// The incident timeline on the status page.
//
// An operator posts an incident when something is wrong; the status page
// shows it. The rule is that the page shows **exactly what was written** and
// nothing invented - no uptime percentages, no "all systems operational"
// banner that nobody wrote, no history that was not recorded.
//
// So this reads one public list, renders it, and says plainly when there is
// nothing to show.
(function () {
  'use strict';

  var root = document.querySelector('[data-incidents]');
  if (!root) return;

  var list = root.querySelector('[data-incident-list]');
  var empty = root.querySelector('[data-incidents-empty]');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // The state a reader sees. The names come from the instance; an unknown
  // one is shown as itself rather than being mapped onto a colour that would
  // mean something it does not.
  function stateClass(state) {
    var s = String(state || '').toLowerCase();
    if (s === 'resolved') return 'state--ok';
    if (s === 'monitoring') return 'state--ok';
    if (s === 'identified') return 'state--warn';
    if (s === 'investigating') return 'state--warn';
    return 'state--unknown';
  }

  function when(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return String(iso || '');
    }
  }

  function render(incidents) {
    if (!list) return;
    list.textContent = '';
    if (!incidents || !incidents.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    for (const incident of incidents) {
      var item = el('li', 'incident');
      var head = el('div', 'incident-head');
      head.appendChild(el('span', 'incident-state ' + stateClass(incident.status), incident.status || 'unknown'));
      head.appendChild(el('span', 'incident-title', incident.title || 'Something happened'));
      item.appendChild(head);
      if (incident.summary) item.appendChild(el('p', 'incident-summary', incident.summary));
      var meta = el('p', 'incident-meta');
      meta.appendChild(el('span', null, when(incident.startedAt || incident.createdAt)));
      if (incident.updatedAt && incident.updatedAt !== incident.startedAt) {
        meta.appendChild(el('span', null, ' · updated ' + when(incident.updatedAt)));
      }
      item.appendChild(meta);
      list.appendChild(item);
    }
  }

  function load() {
    var api = window.TrycordApi;
    if (!api || typeof api.request !== 'function') return;
    api.request('/api/incidents', { method: 'GET' })
      .then(function (data) {
        root.hidden = false;
        // The list answers with the incidents themselves. An envelope is
        // accepted too, because a client should not have to know which shape
        // a list arrives in.
        render(Array.isArray(data) ? data : ((data && data.incidents) || []));
      })
      .catch(function () {
        // The timeline is not the point of the page. If it cannot be read,
        // the live checks above still stand, and the page says so.
        root.hidden = true;
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
