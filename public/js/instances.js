// The public instance directory.
//
// A reader who wants to join an instance other than this one asks here. The
// answer is a list of pointers, not verdicts: an entry may say an instance
// accepts registrations and it may say an instance is verified, and both are
// claims by whoever published the entry. The page says so, and it does not
// turn a claim into a fact.
//
// Everything shown is what the API returns. An instance with no description
// says so. An instance with no name is shown by its address, because an
// address is a thing a reader can use and an empty heading is not.
//
// The list is read from the public discovery index - the same endpoint the
// application's own instance chooser calls - and the page is a static
// document, so it carries no framework.
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

  // The address an instance is reached at, shown without the scheme so that
  // it reads as a place rather than as a URL.
  function hostOf(url) {
    var text = String(url || '').trim();
    try {
      var parsed = new URL(text);
      return parsed.host + (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '');
    } catch (e) {
      return text.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    }
  }

  // Whether an instance says it takes registrations, and what that means.
  function registrationText(instance) {
    if (instance.registrationOpen === true) return 'Says it accepts registrations';
    if (instance.registrationOpen === false) return 'Says it is not accepting registrations';
    return 'Says nothing about registrations';
  }

  // The verification claim, named as a claim.
  function verifiedText(instance) {
    if (instance.verified === true) return 'Claims to be verified';
    if (instance.verified === false) return 'Claims not to be verified';
    return null;
  }

  var host = document.querySelector('[data-instances]');
  if (!host) return;

  var listEl = host.querySelector('[data-instance-list]');
  var detailEl = host.querySelector('[data-instance-detail]');

  var state = { items: [], loading: false, error: null, selected: null, problems: [] };

  function renderList() {
    clear(listEl);

    if (state.loading) {
      listEl.appendChild(el('p', { class: 'muted', text: 'Loading instances...' }));
      return;
    }

    if (state.error) {
      listEl.appendChild(el('div', { class: 'panel' }, [
        el('p', { text: 'The list of instances could not be loaded.' }),
        el('p', { class: 'small muted', text: state.error.code ? (state.error.message || 'The server refused the request.') : 'This is usually a connection problem. Check your network, then retry.' }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: load }, ['Retry']),
      ]));
      return;
    }

    if (!state.items.length) {
      listEl.appendChild(el('div', { class: 'panel' }, [
        el('p', { text: 'No other instances are listed here.' }),
        el('p', { class: 'small muted', text: 'An instance appears in this list when whoever runs this one has listed it. An instance you run yourself does not need to be listed to be used.' }),
        el('p', { class: 'small' }, [el('a', { class: 'text-link', href: '/install' }, ['Read the install guide'])]),
      ]));
      return;
    }

    state.items.forEach(function (instance) {
      var name = instance.name || hostOf(instance.url);
      var mark = el('div', { class: 'community-mark' });
      mark.textContent = initial(name);
      var meta = registrationText(instance);
      var verified = verifiedText(instance);
      listEl.appendChild(el('button', {
        class: 'dir-card', type: 'button',
        'aria-current': state.selected && state.selected.url === instance.url ? 'true' : 'false',
        onclick: function () { select(instance); },
      }, [
        mark,
        el('div', {}, [
          el('h3', { text: name }),
          el('p', { text: instance.description || 'No description.' }),
          el('div', { class: 'meta', text: hostOf(instance.url) + ' · ' + meta + (verified ? ' · ' + verified : '') }),
        ]),
        el('span', { class: 'chev', 'aria-hidden': 'true', text: '\u2192' }),
      ]));
    });
  }

  function renderDetail() {
    clear(detailEl);

    if (!state.selected) {
      detailEl.appendChild(el('p', { class: 'dir-placeholder', text: 'Select an instance to see what it says about itself.' }));
      return;
    }

    var instance = state.selected;
    var name = instance.name || hostOf(instance.url);
    var actions = el('div', { class: 'dir-preview-actions' });

    // The address of the instance, opened as it is. It is a link to another
    // host, so it is marked as leaving this page.
    actions.appendChild(el('a', {
      class: 'btn btn-primary btn-sm',
      href: instance.url,
      rel: 'noopener',
    }, ['Open ' + name]));

    detailEl.appendChild(el('div', { class: 'dir-preview-head' }, [
      el('div', {}, [
        el('h2', { text: name }),
        el('div', { class: 'meta', text: hostOf(instance.url) }),
      ]),
    ]));
    detailEl.appendChild(el('p', { class: 'dir-preview-desc', text: instance.description || 'No description.' }));

    var facts = el('ul', { class: 'dir-channel-list' });
    facts.appendChild(el('li', {}, [el('span', { text: registrationText(instance) })]));
    var verified = verifiedText(instance);
    if (verified) facts.appendChild(el('li', {}, [el('span', { text: verified })]));
    if (instance.instanceId) facts.appendChild(el('li', {}, [el('span', { class: 'mono', text: instance.instanceId })]));
    detailEl.appendChild(el('p', { class: 'field-label', text: 'What it says' }));
    detailEl.appendChild(facts);

    detailEl.appendChild(el('p', { class: 'small muted', text: 'A directory says what it has been told. Whether an instance is reachable, whether it accepts registrations and whether it speaks this protocol are facts the instance itself confirms.' }));
    detailEl.appendChild(actions);
  }

  function select(instance) {
    state.selected = instance;
    renderList();
    renderDetail();
  }

  function load() {
    state.loading = true;
    state.error = null;
    renderList();

    Api.instances().then(function (answer) {
      state.loading = false;
      state.items = (answer && answer.instances) || [];
      state.problems = (answer && answer.problems) || [];
      if (!state.selected && state.items.length) state.selected = state.items[0];
      renderList();
      renderDetail();
    }).catch(function (error) {
      state.loading = false;
      state.error = error || {};
      renderList();
      renderDetail();
    });
  }

  load();
})();
