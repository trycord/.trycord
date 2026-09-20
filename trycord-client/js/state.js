/* Client state, split into three scopes:
   - access-point config:  which instance to talk to (this device's pointer)
   - instance state:       token, favorites, recent — namespaced per instance
   - global state:         appearance (theme/density), shared across instances
   apiBase is access config, NOT a user preference: it selects the instance,
   so it lives outside the namespaced and global buckets. */
(function () {
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }
  function drop(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function instanceSlug() {
    try {
      var id = window.TRYCORD_CONFIG && window.TRYCORD_CONFIG.instanceId;
      if (id && String(id).trim()) {
        return 'cfg-' + String(id).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      }
    } catch (e) { /* ignore */ }
    try {
      var api = window.TrycordApi;
      if (api && api.baseUrl) {
        return 'url-' + new URL(api.baseUrl()).host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      }
      return 'url-unknown';
    } catch (e) {
      return 'url-unknown';
    }
  }

  var slug = instanceSlug();
  var NS = 'trycord:' + slug + ':';

  function rawGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // One-time upgrade: import flat legacy keys into this instance's namespace.
  // Tokens are stored raw (never JSON-encoded) to match the session format.
  function migrateLegacy() {
    if (rawGet(NS + 'token') !== null) return; // already migrated (or logged in)
    var legacyToken = rawGet('trycord.token');
    if (legacyToken) {
      try { localStorage.setItem(NS + 'token', legacyToken); } catch (e) { /* ignore */ }
      save(NS + 'favorites', load('trycord.favorites', []));
      save(NS + 'recent', load('trycord.recent', []));
      ['trycord.token', 'trycord.favorites', 'trycord.recent'].forEach(drop);
    }
  }

  // Access config migration: apiBase used to live in settings.
  var access = load('trycord.access', null) || { apiBase: '' };
  if (!access.apiBase) {
    var legacySettings = load('trycord.settings', {});
    if (legacySettings && legacySettings.apiBase) {
      access.apiBase = legacySettings.apiBase;
      delete legacySettings.apiBase;
      save('trycord.settings', legacySettings);
      save('trycord.access', access);
    }
  }

  var State = {
    user: null,
    servers: [],
    perms: {}, // serverId -> { is_owner, permissions[] }
    // Social state is in-memory only: the server is authoritative, and these
    // are refetched on boot and updated incrementally from WebSocket events.
    dms: [], // [{ id, peer, lastMessage, unreadCount, updatedAt }]
    friends: [], // [{ id, username, displayName, presence }]
    requests: { incoming: [], outgoing: [] },
    notifications: { items: [], unreadCount: 0 },
    instanceSlug: slug,
    access,
    favorites: load(NS + 'favorites', []),
    recent: load(NS + 'recent', []),
    // Global preferences: deliberately shared across instances on this browser.
    settings: Object.assign(
      { theme: 'dark', density: 'comfortable' },
      load('trycord.settings', {})
    ),

    tokenKey: () => NS + 'token',
    saveAccess() {
      save('trycord.access', State.access);
    },
    saveSettings() {
      save('trycord.settings', State.settings);
      State.applyAppearance();
    },
    applyAppearance() {
      document.documentElement.dataset.theme = State.settings.theme || 'dark';
      document.documentElement.dataset.density = State.settings.density || 'comfortable';
    },
    setServers(list) {
      State.servers = Array.isArray(list) ? list : [];
      // prune favorites/recent for servers we no longer belong to
      var ids = {};
      State.servers.forEach((s) => { ids[s.id] = true; });
      State.favorites = State.favorites.filter((id) => ids[id]);
      State.recent = State.recent.filter((r) => ids[r.id]);
      save(NS + 'favorites', State.favorites);
      save(NS + 'recent', State.recent);
    },
    // Effective access for the open server: { is_owner, permissions[] }.
    // '*' means all permissions (owner). Always mirrored by the backend.
    setPerms(serverId, accessPerms) {
      State.perms[serverId] = accessPerms || { is_owner: false, permissions: [] };
    },
    can(serverId, perm) {
      var a = State.perms[serverId];
      if (!a) return false;
      if (a.is_owner) return true;
      return (a.permissions || []).indexOf(perm) !== -1;
    },
    serverById(id) {
      for (var i = 0; i < State.servers.length; i++) {
        if (State.servers[i].id === id) return State.servers[i];
      }
      return null;
    },
    isFav(id) { return State.favorites.indexOf(id) !== -1; },
    toggleFav(id) {
      var i = State.favorites.indexOf(id);
      if (i === -1) State.favorites.push(id);
      else State.favorites.splice(i, 1);
      save(NS + 'favorites', State.favorites);
      return i === -1;
    },
    touchRecent(id) {
      State.recent = [{ id, ts: Date.now() }].concat(
        State.recent.filter((r) => r.id !== id)
      ).slice(0, 8);
      save(NS + 'recent', State.recent);
    },
    clearLocal() {
      State.favorites = [];
      State.recent = [];
      save(NS + 'favorites', []);
      save(NS + 'recent', []);
    },
    // --- social helpers (all in-memory; server is the source of truth) ---
    setDMs(list) {
      State.dms = Array.isArray(list) ? list : [];
    },
    dmUnreadTotal() {
      return State.dms.reduce((n, c) => n + (c.unreadCount || 0), 0);
    },
    dmById(id) {
      for (var i = 0; i < State.dms.length; i++) {
        if (String(State.dms[i].id) === String(id)) return State.dms[i];
      }
      return null;
    },
    // Patch one conversation's preview/unread from a realtime event or send.
    touchDM(id, patch) {
      var c = State.dmById(id);
      if (!c) return null;
      Object.keys(patch || {}).forEach((k) => { c[k] = patch[k]; });
      State.dms.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return c;
    },
    setFriends(list) {
      State.friends = Array.isArray(list) ? list : [];
    },
    setRequests(incoming, outgoing) {
      State.requests = { incoming: incoming || [], outgoing: outgoing || [] };
    },
    pendingRequestCount() {
      return (State.requests.incoming || []).length;
    },
    setNotifications(items, unreadCount) {
      State.notifications = { items: Array.isArray(items) ? items : [], unreadCount: unreadCount || 0 };
    },
  };

  migrateLegacy();
  // Re-read in case migration just populated this instance.
  State.favorites = load(NS + 'favorites', State.favorites);
  State.recent = load(NS + 'recent', State.recent);

  State.applyAppearance();
  window.TrycordState = State;
})();
