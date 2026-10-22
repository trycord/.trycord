// The status page's live checks.
//
// Four rows, four questions, and the answer to each comes from a different
// origin than the last:
//
//   This website  - did the web server that served this page answer?
//   Application API - is the process that answers the app running?
//   Database      - does the instance's own health answer about its database?
//   Web app       - did the server find the client it was told to serve?
//
// The last three are asked of the API, not of the page. A relative '/health' on
// a deployment where the site and the API are different origins asks the site,
// which has no health endpoint, and the page then reports a healthy instance as
// unavailable. So the API's address is resolved the way the rest of the site
// resolves it, and the probes go there.
//
// The first row is deliberately the other way round: it asks the origin that
// served this page, because that is the one thing this page can check for
// itself.
(function () {
  'use strict';

  var root = document.querySelector('[data-status]');
  if (!root) return;

  var summaryEl = document.getElementById('status-summary');
  var checkedEl = document.getElementById('status-checked');
  var whenEl = document.getElementById('status-when');
  var refreshBtn = root.querySelector('[data-status-refresh]');
  var tbody = root.querySelector('tbody');

  var staticRows = tbody ? tbody.innerHTML : '';

  var monitorMeta = document.querySelector('meta[name="status-monitor"]');
  var monitorUrl = monitorMeta ? String(monitorMeta.getAttribute('content') || '').trim() : '';

  var LABEL = { ok: 'Operational', warn: 'Degraded', bad: 'Unavailable', unknown: 'Unknown' };
  var CLASS = { ok: 'state--ok', warn: 'state--warn', bad: 'state--bad', unknown: 'state--unknown' };
  var FROM_MONITOR = { up: 'ok', degraded: 'warn', down: 'bad', unknown: 'unknown' };
  var SUMMARY = {
    up: 'All components are operational.',
    degraded: 'One or more components are degraded.',
    down: 'One or more components are unavailable.',
    unknown: 'The monitor has not reported yet.'
  };

  var states = { site: 'unknown', api: 'unknown', db: 'unknown', app: 'unknown', voice: 'unknown' };

  function set(key, state) {
    states[key] = state;
    var el = root.querySelector('[data-state-cell="' + key + '"]');
    if (!el) return;
    el.className = 'state ' + CLASS[state];
    el.textContent = LABEL[state];
  }

  // The API this instance runs. The site's own resolver answers it, so the
  // status page and the directory cannot disagree about which API they are
  // talking to.
  function apiBase() {
    var Api = window.TrycordApi;
    if (Api && typeof Api.apiBase === 'function') {
      return Api.apiBase().catch(function () { return location.origin; });
    }
    return Promise.resolve(location.origin);
  }

  function probe(url) {
    return fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          return { reached: true, ok: res.ok, status: res.status, data: data };
        });
      })
      .catch(function () {
        return { reached: false, ok: false, status: 0, data: null };
      });
  }

  // The website's own origin. A HEAD is enough: the question is whether the
  // server answered, not what it would have said.
  function probeSite() {
    var url = String(location.origin || '').replace(/\/+$/, '') + '/';
    return fetch(url, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        // Any answer at all means the web server is up. A 404 still means it
        // answered; a 5xx means it answered and is broken.
        if (res.status >= 500) return { reached: true, ok: false, status: res.status, data: null };
        return { reached: true, ok: true, status: res.status, data: null };
      })
      .catch(function () {
        return { reached: false, ok: false, status: 0, data: null };
      });
  }

  function localTime(date) {
    try { return date.toLocaleTimeString(); } catch (e) { return date.toISOString(); }
  }

  function summarizeLocal() {
    var vals = [states.site, states.api, states.db, states.app, states.voice];
    if (vals.indexOf('bad') !== -1) return 'One or more checks failed.';
    if (vals.indexOf('warn') !== -1) return 'The instance is running, but a component is degraded.';
    if (vals.indexOf('unknown') !== -1) return 'Some checks could not be completed from your browser.';
    return 'All checks passed just now.';
  }

  function runLocal(extraNote) {
    if (tbody && staticRows) tbody.innerHTML = staticRows;
    set('site', 'unknown');
    set('api', 'unknown');
    set('db', 'unknown');
    set('app', 'unknown');
    set('voice', 'unknown');

    return apiBase().then(function (base) {
      var api = String(base || '').replace(/\/+$/, '');
      return Promise.all([
        probeSite(),
        probe(api + '/health'),
        probe(api + '/api/health'),
        probe(api + '/api/voice/relay'),
      ]);
    }).then(function (out) {
      var site = out[0];
      var health = out[1];
      var detail = out[2];
      var relay = out[3];

      if (!site.reached) set('site', 'unknown');
      else if (site.ok) set('site', 'ok');
      else set('site', 'bad');

      if (!health.reached) set('api', 'unknown');
      else if (health.ok && health.data && health.data.ok === true) set('api', 'ok');
      else set('api', 'bad');

      if (!detail.reached || !detail.data) {
        set('db', 'unknown');
        set('app', 'unknown');
      } else {
        if (detail.data.db === 'ok') set('db', 'ok');
        else if (detail.data.db === 'unreachable') set('db', 'bad');
        else set('db', 'unknown');

        if (detail.data.client === true) set('app', 'ok');
        else if (detail.data.client === false) set('app', 'warn');
        else set('app', 'unknown');
      }

      // The relay. The address is public - it is in the configuration the
      // clients are given - and whether it answers is a fact about the
      // instance, so the page can be asked without a session.
      if (!relay.reached || !relay.data) set('voice', 'unknown');
      else if (relay.data.ok === true) set('voice', 'ok');
      else set('voice', 'bad');

      var stamp = localTime(new Date());
      if (summaryEl) summaryEl.textContent = summarizeLocal();
      if (checkedEl) checkedEl.textContent = 'Last checked at ' + stamp + '.';
      if (whenEl) {
        whenEl.textContent = (extraNote ? extraNote + ' ' : '') +
          'These results were taken by your browser at ' + stamp +
          '. They describe this moment only. Run the checks again for a fresh answer.';
      }
      root.setAttribute('aria-busy', 'false');
    });
  }

  function monitorDetail(component) {
    var bits = [];
    if (typeof component.latencyMs === 'number') bits.push(component.latencyMs + ' ms');
    var w = component.window;
    if (w && w.samples) {
      var passed = (typeof w.passed === 'number')
        ? w.passed
        : Math.round((w.availability || 0) * w.samples);
      bits.push('passed ' + passed + ' of ' + w.samples + ' recent checks');
    }
    return bits.join(', ');
  }

  function resetLocalCells() {
    set('site', 'unknown');
    set('api', 'unknown');
    set('db', 'unknown');
    set('app', 'unknown');
    set('voice', 'unknown');
  }

  function renderMonitor(report) {
    if (!tbody) return;
    var components = (report && report.components) || [];
    tbody.innerHTML = '';
    components.forEach(function (component) {
      var pageState = FROM_MONITOR[component.state] || 'unknown';
      var tr = document.createElement('tr');

      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = component.name || component.id || 'Component';

      var tdDesc = document.createElement('td');
      tdDesc.textContent = component.description || component.url || '';

      var tdState = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'state ' + CLASS[pageState];
      badge.textContent = LABEL[pageState];
      tdState.appendChild(badge);
      var detail = monitorDetail(component);
      if (detail) {
        var note = document.createElement('span');
        note.className = 'small muted';
        note.textContent = ' ' + detail;
        tdState.appendChild(note);
      }

      tr.appendChild(th);
      tr.appendChild(tdDesc);
      tr.appendChild(tdState);
      tbody.appendChild(tr);
    });
  }

  function finishMonitor(report) {
    var overall = report && report.overall;
    if (summaryEl) summaryEl.textContent = SUMMARY[overall] || 'Status reported.';
    var stamp = report && report.generatedAt ? localTime(new Date(report.generatedAt)) : 'an unknown time';
    if (checkedEl) checkedEl.textContent = 'Last reported at ' + stamp + '.';
    if (whenEl) {
      whenEl.textContent = 'These results come from this instance\'s status monitor' +
        (report && report.title ? ' (' + report.title + ')' : '') +
        ', which checks the instance on a schedule. They are its most recent checks, not a permanent record.';
    }
    root.setAttribute('aria-busy', 'false');
  }

  function runMonitor() {
    var base;
    try { base = new URL(monitorUrl, window.location.href); } catch (e) { return Promise.resolve(false); }
    var jsonUrl = base.href.replace(/\/+$/, '') + '/status.json';
    return fetch(jsonUrl, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (report) {
        renderMonitor(report);
        finishMonitor(report);
        return true;
      })
      .catch(function () { return false; });
  }

  function start() {
    root.setAttribute('aria-busy', 'true');
    if (summaryEl) summaryEl.textContent = 'Checking this instance...';
    if (checkedEl) checkedEl.textContent = 'Running the checks now.';
    if (whenEl) whenEl.textContent = 'Times are shown in your browser\'s local time.';
    resetLocalCells();

    if (monitorUrl) {
      return runMonitor().then(function (ok) {
        if (ok) return;
        if (tbody) tbody.innerHTML = staticRows;
        return runLocal('The status monitor could not be reached, so these results come from your browser instead.');
      });
    }
    return runLocal('');
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshBtn.setAttribute('aria-disabled', 'true');
      start().then(function () { refreshBtn.removeAttribute('aria-disabled'); });
    });
  }

  start();
})();
