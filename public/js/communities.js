// The public community directory.
//
// Search, sort and paging run against this instance's public discovery API, the
// same endpoint the application's own discovery screen calls. Every field shown
// is a field the API returns: name, description, member and channel counts, and
// for the preview, the channel list. Nothing is invented - a community with no
// description says so, and an instance with no public communities gets an
// explanation rather than a gallery of made-up ones. Sample content is for the
// demo, where being a demonstration is the point; a directory is where a reader
// goes to find something real.
(function () {
  'use strict';

  var Api = window.TrycordApi;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
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
  function initial(name) { return (String(name || '?').trim().charAt(0) || '?').toUpperCase(); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // A link into the application. Where the application is served from is the
  // instance's business - the origin root on one deployment, a mount on the
  // next - so the address is asked for rather than written down here.
  function appLink(className, text, path) {
    var a = el('a', { class: className }, [text]);
    Api.appHref(path).then(function (href) { a.setAttribute('href', href); });
    return a;
  }

  function mark(server, size) {
    var m = el('div', { class: 'community-mark' + (size ? ' community-mark--' + size : '') });
    m.textContent = initial(server.name);
    // The API returns the icon as a path, because the API is what serves it. A
    // path on its own resolves against this page's origin, which on a site and
    // an API in different places is the wrong host entirely, so the address is
    // completed against the API the page is already talking to.
    if (server.icon_url && server.icon_url.charAt(0) === '/') {
      Api.assetUrl(server.icon_url).then(function (src) {
        if (!src) return;
        var img = el('img', { src: src, alt: '' });
        img.addEventListener('error', function () { clear(m); m.textContent = initial(server.name); });
        clear(m);
        m.appendChild(img);
      });
    }
    return m;
  }

  var host = document.querySelector('[data-directory]');
  if (!host) return;

  var searchInput = host.querySelector('[data-dir-search]');
  var sortSelect = host.querySelector('[data-dir-sort]');
  var resultsEl = host.querySelector('[data-dir-results]');
  var pagerEl = host.querySelector('[data-dir-pager]');
  var previewEl = host.querySelector('[data-dir-preview]');

  var state = {
    q: '', sort: 'members', page: 1,
    items: [], total: 0, pages: 1,
    loading: false, error: null, disabled: false,
    selected: null, selectedId: null, previewLoading: false, previewError: null,
    joined: [],
    signedIn: false,
  };

  // The session belongs to the instance the API belongs to, which is not
  // necessarily the origin this page was served from.
  Api.signedIn().then(function (yes) {
    state.signedIn = yes;
    if (state.selectedId) renderPreview();
  });

  function renderResults() {
    clear(resultsEl);
    if (state.loading) {
      resultsEl.appendChild(el('p', { class: 'muted', text: state.q ? 'Searching communities...' : 'Loading communities...' }));
      return;
    }
    if (state.error) {
      var detail = state.disabled
        ? 'Discovery can be turned back on by whoever runs this instance.'
        : (state.error.code ? (state.error.message || 'The server refused the request.') : 'This is usually a connection problem. Check your network, then retry.');
      resultsEl.appendChild(el('div', { class: 'panel' }, [
        el('p', { text: state.disabled ? 'Community discovery is switched off on this instance.' : 'The directory could not be loaded.' }),
        el('p', { class: 'small muted', text: detail }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: load }, ['Retry']),
      ]));
      return;
    }
    if (!state.items.length) {
      resultsEl.appendChild(el('div', { class: 'panel' }, [
        el('p', { text: state.q ? 'No public communities match "' + state.q + '".' : 'No public communities have been listed on this instance yet.' }),
        el('p', { class: 'small muted', text: 'A community appears here when its owner publishes it and marks it discoverable.' }),
      ]));
      return;
    }
    state.items.forEach(function (s) {
      var card = el('button', {
        class: 'dir-card', type: 'button',
        'aria-current': s.id === state.selectedId ? 'true' : 'false',
        onclick: function () { select(s.id); },
      }, [
        mark(s),
        el('div', {}, [
          el('h3', { text: s.name }),
          el('p', { text: s.description || 'No description.' }),
          el('div', { class: 'meta', text: plural(s.member_count || 0, 'member') + ' · ' + plural(s.channel_count || 0, 'channel') }),
        ]),
        el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u2192' }),
      ]);
      resultsEl.appendChild(card);
    });
  }

  function renderPager() {
    clear(pagerEl);
    if (state.loading || state.error || state.pages <= 1) return;
    pagerEl.appendChild(el('button', {
      class: 'btn btn-sm', type: 'button', 'aria-disabled': state.page <= 1 ? 'true' : 'false',
      onclick: function () { if (state.page > 1) { state.page--; load(); } },
    }, ['Previous']));
    pagerEl.appendChild(el('span', { class: 'page-of', text: 'Page ' + state.page + ' of ' + state.pages }));
    pagerEl.appendChild(el('button', {
      class: 'btn btn-sm', type: 'button', 'aria-disabled': state.page >= state.pages ? 'true' : 'false',
      onclick: function () { if (state.page < state.pages) { state.page++; load(); } },
    }, ['Next']));
  }

  function renderPreview() {
    clear(previewEl);
    if (!state.selectedId) {
      previewEl.appendChild(el('p', { class: 'dir-placeholder', text: 'Select a community to preview it. Only information the owner has made public is shown.' }));
      return;
    }
    if (state.previewLoading) {
      previewEl.appendChild(el('p', { class: 'muted', text: 'Loading preview...' }));
      return;
    }
    if (state.previewError || !state.selected) {
      previewEl.appendChild(el('div', {}, [
        el('p', { text: 'This community could not be previewed. It may no longer be public.' }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { select(state.selectedId); } }, ['Retry']),
      ]));
      return;
    }

    var s = state.selected;
    previewEl.appendChild(el('div', { class: 'dir-preview-head' }, [
      mark(s, 'lg'),
      el('div', {}, [
        el('h2', { text: s.name }),
        el('div', { class: 'meta', text: plural(s.member_count || 0, 'member') + ' · ' + plural((s.channels || []).length, 'channel') }),
      ]),
    ]));
    previewEl.appendChild(el('p', { class: 'dir-preview-desc', text: s.description || 'No description.' }));

    if ((s.channels || []).length) {
      var list = el('ul', { class: 'dir-channel-list' });
      s.channels.forEach(function (c) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'hash', text: '#' }),
          el('span', { text: c.name }),
          c.topic ? el('span', { class: 'topic', text: c.topic }) : null,
        ]));
      });
      previewEl.appendChild(el('p', { class: 'field-label', text: 'Channels' }));
      previewEl.appendChild(list);
    }

    var actions = el('div', { class: 'dir-preview-actions' });
    actions.appendChild(appLink('btn btn-primary btn-sm', 'Open in Trycord', ''));

    var joined = state.joined.indexOf(s.id) !== -1;
    if (state.signedIn) {
      if (joined) {
        actions.appendChild(el('span', { class: 'pill', text: 'Joined' }));
      } else {
        var joinBtn = el('button', { class: 'btn btn-sm', type: 'button' }, ['Join community']);
        joinBtn.addEventListener('click', function () { join(s.id, joinBtn); });
        actions.appendChild(joinBtn);
      }
    } else {
      actions.appendChild(appLink('btn btn-sm', 'Sign in to join', ''));
    }
    previewEl.appendChild(actions);

    previewEl.appendChild(el('p', { class: 'dir-note', text: 'Only public information is shown. Joining opens Trycord, where membership is confirmed by the server.' }));
  }

  async function load() {
    state.loading = true; state.error = null; state.disabled = false;
    renderResults(); renderPager();
    try {
      var res = await Api.servers({ q: state.q, sort: state.sort, page: state.page, limit: 12 });
      state.items = (res && res.items) || [];
      state.total = (res && res.total) || state.items.length;
      state.pages = (res && res.pages) || 1;
    } catch (e) {
      state.items = [];
      state.error = e;
      state.disabled = e.code === 'FEATURE_DISABLED';
    }
    state.loading = false;
    renderResults(); renderPager();
  }

  async function select(id) {
    state.selectedId = id; state.selected = null; state.previewError = null; state.previewLoading = true;
    renderResults(); renderPreview();
    try {
      state.selected = await Api.server(id);
    } catch (e) {
      state.previewError = e;
    }
    state.previewLoading = false;
    renderPreview();
  }

  async function join(id, button) {
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Joining...';
    try {
      await Api.join(id);
      state.joined = state.joined.concat(id);
      renderPreview();
    } catch (e) {
      button.removeAttribute('aria-disabled');
      button.textContent = e.code === 'SERVER_PRIVATE' ? 'This community is private' : 'Could not join. Try again';
    }
  }

  if (searchInput) {
    var timer = null;
    searchInput.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = searchInput.value.trim();
        state.page = 1;
        load();
      }, 250);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      state.sort = sortSelect.value;
      state.page = 1;
      load();
    });
  }

  load();
})();
