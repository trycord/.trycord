/* Home — The Atrium. One flowing communication environment, not a dashboard:
   a single prose tone, your places as glowing presence threads, people you
   keep woven beside them, and live rooms underneath each place. Actions
   ride the same flow as prose. No sections, no cards, no CTA rows,
   no "Welcome back" — this is a room, not a landing page. */
(function () {
  var Ui = window.TrycordUi;
  var C = window.TrycordComponents;

  function daypart(h) {
    if (h < 5) return 'It is late — your spaces are still awake.';
    if (h < 12) return 'Morning — your places are waking up around you.';
    if (h < 18) return 'Afternoon — this place is yours.';
    return 'Evening — the coals are warm, the rooms glow.';
  }

  function placeBlock(s) {
    var meta = [];
    if (s.member_count) meta.push(s.member_count + ' members');
    if (s.is_public !== undefined) meta.push(s.is_public ? 'open space' : 'private space');
    return (
      '<div class="place" data-place="' + Ui.esc(s.id) + '">' +
      '<a class="place-head" href="#/server/' + encodeURIComponent(s.id) + '" aria-label="Enter ' + Ui.esc(s.name) + '">' +
      '<span class="place-halo">' + Ui.avatarHtml(s.name, '') + '</span>' +
      '<span class="place-ident">' +
      '<span class="place-name">' + Ui.esc(s.name) + '</span>' +
      '<span class="place-meta">' + Ui.esc(meta.join(' · ')) + '</span>' +
      '</span>' +
      '<span class="place-glow" aria-hidden="true"></span>' +
      '</a>' +
      '<div class="place-rooms" data-place-rooms="' + Ui.esc(s.id) + '">' +
      '<span class="place-quiet">The room is quiet for now. Step in when ready.</span>' +
      '</div>' +
      '</div>'
    );
  }

  // One thread row, both for rooms-in-places and the Activity timeline.
  function activityItem(a) {
    return (
      '<button type="button" class="thread-row" data-goto-server="' + Ui.esc(a.server_id) +
      '" data-goto-channel="' + Ui.esc(a.channel_id) + '">' +
      '<span class="thread-author">' + Ui.avatarHtml(a.author_display || a.author_name, 'avatar-sm') + '</span>' +
      '<span class="thread-body">' +
      '<span class="thread-meta">' + Ui.esc(a.author_display || a.author_name) +
      '<span class="thread-where"> in ' + Ui.esc(a.server_name) + ' &middot; #' + Ui.esc(a.channel_name) + '</span>' +
      '<span class="thread-when">' + Ui.esc(Ui.timeAgo(a.created_at)) + '</span></span>' +
      '<span class="thread-text">' + Ui.esc(a.content) + '</span>' +
      '</span></button>'
    );
  }

  function personRow(c) {
    var who = (c.peer && (c.peer.displayName || c.peer.username)) || 'Unknown';
    var last = c.lastMessage ? Ui.esc(c.lastMessage.content) : 'Reach out — they are a message away.';
    return (
      '<button type="button" class="person-row' + (c.unreadCount ? ' unread' : '') + '" data-dm="' + Ui.esc(c.id) + '">' +
      C.presenceAvatar(who, '', c.peer && c.peer.presence) +
      '<span class="person-body">' +
      '<span class="person-name">' + Ui.esc(who) + '</span>' +
      '<span class="person-preview">' + last + '</span>' +
      '</span>' +
      (c.lastMessage ? '<span class="person-when">' + Ui.esc(Ui.timeAgo(c.lastMessage.createdAt)) + '</span>' : '') +
      (c.unreadCount ? '<span class="person-unread">' + (c.unreadCount > 99 ? '99+' : c.unreadCount) + '</span>' : '') +
      '</button>'
    );
  }

  function wovenActions() {
    return (
      '<footer class="atrium-weather" aria-label="Woven actions">' +
      '<span class="atrium-dotsep" aria-hidden="true"></span>' +
      '<button type="button" class="linky" data-at="create">Start a space</button>' +
      '<span class="atrium-dotsep" aria-hidden="true"></span>' +
      '<a class="linky" href="#/join">Join with an invite</a>' +
      '<span class="atrium-dotsep" aria-hidden="true"></span>' +
      '<a class="linky" href="#/discover">Find communities</a>' +
      '<span class="atrium-dotsep" aria-hidden="true"></span>' +
      '<button type="button" class="linky" data-at="dm">Message someone</button>' +
      '</footer>'
    );
  }

  async function home(root) {
    var u = TrycordState.user;
    var first = ((u.displayName || u.username) || 'there').split(' ')[0];
    // Home is the quiet canvas: no command actions up top.
    C.setTopbar('Home', '', '', 'i-home');

    var servers = (TrycordState.servers || []);
    var dms = (TrycordState.dms || []);

    var shown = servers.slice(0, 6);
    var flowHtml = shown.length
      ? shown.map(placeBlock).join('')
      : '<p class="atrium-quiet">No places yet. Start one, or follow an invite — they will glow here.</p>';
    if (servers.length > shown.length) {
      flowHtml += '<p class="atrium-quiet"><a href="#/servers" class="linky">And ' +
        (servers.length - shown.length) + ' more places gather in the spine &rarr;</a></p>';
    }

    var online = dms.filter(function (d) { return d.peer && d.peer.presence === 'online'; }).length;
    flowHtml += online
      ? '<p class="atrium-quiet">' + online + (online === 1 ? ' of your people is' : ' of your people are') +
        ' in right now.</p>'
      : '';
    flowHtml += dms.length
      ? '<div class="atrium-people" aria-label="People you keep">' + dms.slice(0, 5).map(personRow).join('') + '</div>'
      : '<p class="atrium-quiet">No conversations yet — someone new is one message away.</p>';

    root.innerHTML =
      '<div class="atrium">' +
      '<header class="atrium-tone">' +
      '<h2 class="atrium-stroke"><span class="atrium-name">' + Ui.esc(first) + '</span>' +
      '<span class="ember" aria-hidden="true"></span>' +
      '<span class="atrium-frag">' + daypart(new Date().getHours()) + '</span></h2>' +
      '</header>' +
      '<div class="atrium-flow" id="atrium-flow">' + flowHtml + '</div>' +
      wovenActions() +
      '</div>';

    // Wire woven controls
    var createBtn = root.querySelector('[data-at="create"]');
    if (createBtn) createBtn.onclick = () => C.createServerModal();
    var dmBtn = root.querySelector('[data-at="dm"]');
    if (dmBtn) dmBtn.onclick = function () {
      C.openUserSearch(function (picked) {
        TrycordApi.openDM(picked.id).then(function (c) {
          Trycord.refreshSocial().then(function () { location.hash = '#/dm/' + encodeURIComponent(c.id); });
        }).catch(function (e) { Ui.toast(e.message, 'error'); });
      });
    };
    root.querySelectorAll('[data-dm]').forEach(function (b) {
      b.onclick = function () { location.hash = '#/dm/' + encodeURIComponent(b.dataset.dm); };
    });

    // Live threads woven under their own places; strays (rooms you left)
    // land in the flow at the end, still clicking through to the channel.
    try {
      var acts = await TrycordApi.activity(10);
      var known = {};
      shown.forEach(function (s) { known[s.id] = s; });
      var grouped = {};
      var strays = [];
      (acts || []).forEach(function (a) {
        var room = document.querySelector(
          '.place[data-place="' + (window.CSS && CSS.escape ? CSS.escape(a.server_id) : a.server_id) + '"] [data-place-rooms]');
        if (room && known[a.server_id]) {
          (grouped[a.server_id] = grouped[a.server_id] || []).push(a);
        } else if (!known[a.server_id]) {
          strays.push(a);
        }
      });
      Object.keys(grouped).forEach(function (sid) {
        var room = document.querySelector('.place[data-place="' + (window.CSS && CSS.escape ? CSS.escape(sid) : sid) + '"] [data-place-rooms]');
        if (!room) return;
        room.innerHTML = grouped[sid].map(activityItem).join('');
      });
      if (strays.length) {
        var flow = document.getElementById('atrium-flow');
        if (flow) flow.insertAdjacentHTML('beforeend', '<div class="atrium-strays">' +
          strays.map(activityItem).join('') + '</div>');
      }
      document.querySelectorAll('.atrium [data-goto-server]').forEach(function (b) {
        b.onclick = function () {
          location.hash = '#/server/' + encodeURIComponent(b.dataset.gotoServer) +
            '/chat/' + encodeURIComponent(b.dataset.gotoChannel);
        };
      });
    } catch (e) {
      // Threads are atmosphere, not the point; the flow stays whole.
    }
  }

  window.TrycordPagesHome = { home, activityItem };
})();