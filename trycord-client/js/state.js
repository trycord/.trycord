/* Client state: session, server cache, favorites + recent (localStorage),
   appearance + settings (localStorage). */
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

  var State = {
    user: null,
    servers: [],
    perms: {}, // serverId -> { is_owner, permissions[] }
    favorites: load('trycord.favorites', []),
    recent: load('trycord.recent', []),
    settings: Object.assign(
      { theme: 'dark', density: 'comfortable', apiBase: '' },
      load('trycord.settings', {})
    ),

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
      save('trycord.favorites', State.favorites);
      save('trycord.recent', State.recent);
    },
    // Effective access for the open server: { is_owner, permissions[] }.
    // '*' means all permissions (owner). Always mirrored by the backend.
    setPerms(serverId, access) {
      State.perms[serverId] = access || { is_owner: false, permissions: [] };
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
      save('trycord.favorites', State.favorites);
      return i === -1;
    },
    touchRecent(id) {
      State.recent = [{ id, ts: Date.now() }].concat(
        State.recent.filter((r) => r.id !== id)
      ).slice(0, 8);
      save('trycord.recent', State.recent);
    },
    clearLocal() {
      State.favorites = [];
      State.recent = [];
      save('trycord.favorites', []);
      save('trycord.recent', []);
    },
  };

  State.applyAppearance();
  window.TrycordState = State;
})();
