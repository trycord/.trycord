(function () {
  var CHECKS = [
    { path: '/health', label: 'Health' },
    { path: '/ready', label: 'Ready' }
  ];

  function setState(text, detail, state) {
    var el = document.getElementById('status-text');
    var dl = document.getElementById('status-detail');
    if (el) {
      el.textContent = text;
      el.setAttribute('data-state', state);
    }
    if (dl) dl.textContent = detail;
  }

  Promise.all(CHECKS.map(function (check) {
    return fetch(check.path, { cache: 'no-store' })
      .then(function (r) { return { check: check, ok: r.ok, status: r.status }; })
      .catch(function () { return { check: check, ok: false, status: 'unreachable' }; });
  })).then(function (results) {
    var allOk = results.every(function (r) { return r.ok; });
    var detail = results.map(function (r) {
      return r.check.label + ': ' + r.status;
    }).join('  ·  ');
    setState(
      allOk ? 'Operational' : 'One or more checks failed',
      detail,
      allOk ? 'ok' : 'err'
    );
  }).catch(function () {
    setState('Status unavailable', '', 'err');
  });
})();
