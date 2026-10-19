// The interactive demo.
//
// One miniature client, mounted twice: a compact preview in the home hero and the
// full experience on /demo. It is built from the same tokens as the application
// and driven by the same public data the directory reads, which is the point - the
// brief asks for the product shown rather than described.
//
// What is real and what is not is stated on the surface and not only in a
// comment. Real: the list of public communities and their channels, read from
// /api/discover. Simulated: messages, members, presence, and your own
// membership, none of which the public API exposes and none of which is sent
// anywhere. Joining is a local state change; it never mutates the instance. When
// the instance has no public communities the demo falls back to labelled sample
// content rather than an empty frame.
(function () {
  'use strict';

  var Api = window.TrycordApi;
  var Sample = window.TrycordSample;
  var SESSION_KEY = 'trycord.demo';
  var MAX_DISPLAY = 6;

  /* ---- tiny helpers ------------------------------------------------------ */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k === 'html') node.innerHTML = props[k];
      else if (k.indexOf('on') === 0 && typeof props[k] === 'function') node.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== undefined && props[k] !== null) node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function hash(str) {
    var h = 2166136261;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function initial(name) { return (String(name || '?').trim().charAt(0) || '?').toUpperCase(); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function saved() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function persist(patch) {
    var s = saved();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* session storage blocked */ }
  }

  /* ---- the simulated cast and messages -----------------------------------
     Deterministic, so switching channels and back again shows the same room,
     and clearly not real: the names are placeholders and the note says so. */
  function cast() { return (Sample && Sample.people) || []; }
  function messagesFor(channel, server) {
    var pool = (Sample && Sample.messages) || [];
    if (!pool.length) return [];
    var seed = hash((server && server.id) + '/' + (channel && channel.id));
    var people = cast();
    var count = 3 + (seed % 3);
    var out = [];
    for (var i = 0; i < count; i++) {
      var person = people[(seed + i * 7) % people.length];
      out.push({
        who: person.name,
        color: person.color,
        text: pool[(seed + i * 3) % pool.length],
        when: (i === 0 ? 'Today at 9:0' + (seed % 10) : 'Today at 9:' + (10 + i)),
      });
    }
    return out;
  }

  /* ---- the controller ---------------------------------------------------- */
  function mount(host) {
    var full = host.getAttribute('data-demo') === 'full';
    // The full experience renders its controls into the page's side panel rather
    // than inside the window chrome, so the miniature stays a clean likeness of
    // the product and the controls sit beside it like any other page control.
    var controlsHost = full ? document.querySelector('[data-demo-controls]') : null;

    var state = {
      servers: [],
      source: 'live',      // 'live' | 'sample'
      activeServerId: saved().activeServerId || null,
      activeChannelId: saved().activeChannelId || null,
      joined: saved().joined || [],
      density: saved().density === 'compact' ? 'compact' : 'comfortable',
      showMembers: saved().showMembers !== false,
      loaded: false,
      error: null,
    };

    function activeServer() {
      return state.servers.filter(function (s) { return s.id === state.activeServerId; })[0] || state.servers[0] || null;
    }
    function activeChannel() {
      var s = activeServer();
      if (!s || !s.channels || !s.channels.length) return null;
      return s.channels.filter(function (c) { return c.id === state.activeChannelId; })[0] || s.channels[0];
    }
    function isJoined(id) { return state.joined.indexOf(id) !== -1; }

    /* -- data -- */
    async function load() {
      state.error = null;
      state.loaded = false;
      render();
      try {
        var res = await Api.servers({ limit: 12, sort: 'members' });
        var items = (res && res.items) || [];
        if (!items.length) {
          state.servers = Sample ? Sample.servers.slice() : [];
          state.source = 'sample';
        } else {
          state.servers = items;
          state.source = 'live';
        }
      } catch (e) {
        // A failure is shown as a failure. Sample content is a separate, labelled
        // decision, not a silent stand-in for a request that did not work.
        state.error = e;
        state.servers = [];
      }
      state.loaded = true;
      ensureSelection();
      await ensureChannels();
      render();
    }

    async function ensureChannels() {
      var s = activeServer();
      if (!s || (s.channels && s.channels.length)) return;
      if (state.source !== 'live') return;
      try {
        var detail = await Api.server(s.id);
        s.channels = (detail && detail.channels) || [];
        s.channel_count = (detail && detail.channel_count) || s.channels.length;
        if (typeof detail.member_count === 'number') s.member_count = detail.member_count;
      } catch (e) {
        s.channels = [];
      }
    }

    function ensureSelection() {
      if (!state.servers.length) { state.activeServerId = null; state.activeChannelId = null; return; }
      var valid = state.servers.some(function (s) { return s.id === state.activeServerId; });
      if (!valid) state.activeServerId = state.servers[0].id;
      var s = activeServer();
      var chanValid = s && s.channels && s.channels.some(function (c) { return c.id === state.activeChannelId; });
      if (!chanValid) state.activeChannelId = (s && s.channels && s.channels[0] && s.channels[0].id) || null;
    }

    async function selectServer(id) {
      state.activeServerId = id;
      state.activeChannelId = null;
      persist({ activeServerId: id, activeChannelId: null });
      await ensureChannels();
      ensureSelection();
      persist({ activeChannelId: state.activeChannelId });
      render();
    }
    function selectChannel(id) {
      state.activeChannelId = id;
      persist({ activeChannelId: id });
      render();
    }
    function toggleJoin() {
      var s = activeServer();
      if (!s) return;
      var at = state.joined.indexOf(s.id);
      if (at === -1) state.joined = state.joined.concat(s.id);
      else state.joined = state.joined.filter(function (x) { return x !== s.id; });
      persist({ joined: state.joined });
      render();
    }
    function setDensity(d) { state.density = d; persist({ density: d }); render(); }
    function setShowMembers(v) { state.showMembers = v; persist({ showMembers: v }); render(); }

    /* -- render -- */
    function renderStates(node) {
      if (state.error) {
        var code = state.error.code;
        var msg = code === 'FEATURE_DISABLED'
          ? 'Community discovery is switched off on this instance.'
          : 'The demo could not reach this instance.';
        var detail = code === 'FEATURE_DISABLED'
          ? 'The demo reads the public community list, and this instance has that switched off.'
          : (code ? (state.error.message || 'The server refused the request.') : 'This is usually a connection problem. Check your network, then retry.');
        node.appendChild(el('div', { class: 'mini-error' }, [
          el('p', { text: msg }),
          el('p', { class: 'small muted', text: detail }),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: load }, ['Retry']),
        ]));
        return true;
      }
      if (!state.loaded) {
        node.appendChild(el('div', { class: 'mini-loading' }, [
          el('div', { class: 'mini-spinner' }),
          el('p', { class: 'small', text: 'Loading public communities' }),
        ]));
        return true;
      }
      if (!state.servers.length) {
        node.appendChild(el('div', { class: 'mini-empty' }, [
          el('p', { text: 'No communities to show yet.' }),
        ]));
        return true;
      }
      return false;
    }

    function render() {
      clear(host);
      host.removeAttribute('aria-busy');

      var client = el('div', { class: 'mini-client', 'data-density': state.density });
      if (renderStates(client)) { host.appendChild(client); return; }

      var server = activeServer();
      var channel = activeChannel();

      /* rail: the community list */
      var rail = el('div', { class: 'mini-rail' });
      rail.appendChild(railMark());
      state.servers.slice(0, MAX_DISPLAY).forEach(function (s) {
        var btn = el('button', {
          class: 'mini-rail-btn' + (isJoined(s.id) ? ' is-joined' : ''),
          type: 'button',
          'aria-current': s.id === state.activeServerId ? 'true' : 'false',
          'aria-label': s.name + (isJoined(s.id) ? ' (joined)' : ''),
          title: s.name,
          onclick: function () { selectServer(s.id); },
        }, [initial(s.name)]);
        rail.appendChild(btn);
      });

      /* channels */
      var channels = el('div', { class: 'mini-channels' });
      channels.appendChild(el('div', { class: 'mini-community' }, [
        el('h3', { text: server.name }),
        el('p', { text: plural(server.member_count || 0, 'member') + ' · ' + plural((server.channels || []).length, 'channel') }),
      ]));
      var group = el('div', { class: 'mini-channel-group' });
      group.appendChild(el('p', { class: 'mini-channel-label', text: 'Channels' }));
      (server.channels || []).forEach(function (c) {
        group.appendChild(el('button', {
          class: 'mini-channel',
          type: 'button',
          'aria-current': c.id === (channel && channel.id) ? 'true' : 'false',
          onclick: function () { selectChannel(c.id); },
        }, [
          el('span', { class: 'hash', text: '#' }),
          el('span', { text: c.name }),
        ]));
      });
      if (!(server.channels || []).length) group.appendChild(el('p', { class: 'small muted', text: 'No channels listed.' }));
      channels.appendChild(group);

      /* main */
      var main = el('div', { class: 'mini-main' });
      main.appendChild(el('div', { class: 'mini-main-head' }, [
        el('h3', { text: channel ? '#' + channel.name : server.name }),
        channel && channel.topic ? el('p', { text: channel.topic }) : null,
      ]));
      var messages = el('div', { class: 'mini-messages', role: 'log', 'aria-label': 'Simulated messages' });
      (channel ? messagesFor(channel, server) : []).forEach(function (m) {
        messages.appendChild(el('div', { class: 'mini-msg' }, [
          el('div', { class: 'mini-avatar av-' + (m.color || 0), 'aria-hidden': 'true', text: initial(m.who) }),
          el('div', {}, [
            el('div', { class: 'mini-msg-head' }, [
              el('span', { class: 'who', text: m.who }),
              el('span', { class: 'when', text: m.when }),
            ]),
            el('p', { text: m.text }),
          ]),
        ]));
      });
      main.appendChild(messages);
      var composer = el('div', { class: 'mini-composer' }, [
        el('input', { type: 'text', disabled: 'disabled', 'aria-label': 'Message (simulated, disabled)', placeholder: 'Messaging is simulated in the demo' }),
      ]);
      main.appendChild(composer);

      client.appendChild(rail);
      client.appendChild(channels);
      client.appendChild(main);
      if (full && state.showMembers) client.appendChild(renderMembers(client));

      host.appendChild(client);
      if (controlsHost) {
        clear(controlsHost);
        controlsHost.appendChild(renderControls(server));
      }
      host.appendChild(renderNote());
      renderSource();
    }

    function railMark() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'mini-rail-brand');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = '<path d="M50 9 L88 78 Q90 82 85 82 L65 82 L50 56 L35 82 L15 82 Q10 82 12 78 Z" fill="currentColor"/>' +
        '<path d="M39 70 L50 51 L61 70 Z" fill="var(--cutout)"/>' +
        '<path d="M49 31 L67 31 L67 40 L58 40 L58 49 L49 49 Z" fill="var(--cutout)"/>' +
        '<circle cx="72" cy="58" r="7" fill="var(--cutout)"/>';
      return svg;
    }

    function renderMembers(client) {
      client.classList.add('has-members');
      var wrap = el('div', { class: 'mini-members' });
      wrap.appendChild(el('p', { class: 'mini-channel-label', text: 'Members' }));
      cast().forEach(function (p) {
        wrap.appendChild(el('div', { class: 'mini-member' }, [
          el('span', { class: 'mini-presence presence-' + p.presence, 'aria-hidden': 'true' }),
          el('span', { class: 'who', text: p.name }),
          el('span', { class: 'role', text: p.role }),
        ]));
      });
      return wrap;
    }

    function renderNote() {
      var live = state.source === 'live';
      var text = live
        ? 'Live: the public communities and channels below were read from this instance a moment ago. '
          + 'Simulated: the messages, the member list, presence, and joining or leaving a community. '
          + 'Nothing you do here is sent anywhere.'
        : (Sample ? Sample.note + ' ' : '')
          + 'Simulated: the messages, the member list, presence, and joining or leaving a community. '
          + 'Nothing you do here is sent anywhere.';
      return el('p', { class: 'mini-note' }, [text]);
    }

    // Which instance the live half of the demo was read from. A demo that
    // shows a real community list without saying where it came from reads as
    // a live instance whether it is one or not.
    function renderSource() {
      var host = document.querySelector('[data-demo-source]');
      if (!host) return;
      if (state.source !== 'live') {
        host.textContent = 'Sample content. This is not a live instance.';
        return;
      }
      Api.apiBase().then(function (base) {
        host.textContent = 'Reading public communities from ' + base + '.';
      }).catch(function () {
        host.textContent = 'Reading public communities from this instance.';
      });
    }

    function renderControls(server) {
      var panel = el('div', { class: 'demo-controls' });

      // Density
      var density = el('div', { class: 'control-group' }, [
        el('span', { class: 'field-label', text: 'Density' }),
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Density' }, [
          segBtn('Comfortable', state.density === 'comfortable', function () { setDensity('comfortable'); }),
          segBtn('Compact', state.density === 'compact', function () { setDensity('compact'); }),
        ]),
      ]);

      // Membership
      var joined = isJoined(server.id);
      var switchId = 'demo-join';
      var input = el('input', { type: 'checkbox', id: switchId });
      if (joined) input.setAttribute('checked', 'checked');
      input.addEventListener('change', toggleJoin);
      var membership = el('div', { class: 'control-group' }, [
        el('label', { class: 'switch', for: switchId }, [
          input,
          el('span', { class: 'track', 'aria-hidden': 'true' }),
          el('span', { text: joined ? 'You are a member of ' + server.name : 'Join ' + server.name }),
        ]),
      ]);

      // Members list
      var showId = 'demo-members';
      var showInput = el('input', { type: 'checkbox', id: showId });
      if (state.showMembers) showInput.setAttribute('checked', 'checked');
      showInput.addEventListener('change', function () { setShowMembers(showInput.checked); });
      var membersToggle = el('div', { class: 'control-group' }, [
        el('label', { class: 'switch', for: showId }, [
          showInput,
          el('span', { class: 'track', 'aria-hidden': 'true' }),
          el('span', { text: 'Show member list' }),
        ]),
      ]);

      // Reset
      var reset = el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: function () {
          state.joined = []; state.density = 'comfortable'; state.showMembers = true;
          persist({ joined: [], density: 'comfortable', showMembers: true });
          render();
        },
      }, ['Reset the demo']);

      panel.appendChild(density);
      panel.appendChild(membership);
      panel.appendChild(membersToggle);
      panel.appendChild(el('div', { class: 'control-group' }, [reset]));
      return panel;
    }

    function segBtn(label, pressed, onClick) {
      return el('button', {
        type: 'button', 'aria-pressed': pressed ? 'true' : 'false', onclick: onClick,
      }, [label]);
    }

    load();
    return { reload: load };
  }

  /* ---- mounts ------------------------------------------------------------ */
  var hosts = Array.prototype.slice.call(document.querySelectorAll('[data-demo]'));
  hosts.forEach(function (host) { mount(host); });
})();
