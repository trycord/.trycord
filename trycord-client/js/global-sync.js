/* Global Trycord layer: explicitly global resources only.
   - Global preferences (theme/density) are shared across instances on this
     browser by storing them outside the per-instance namespace (see state.js).
   - The optional global service (TRYCORD_GLOBAL_URL / config globalUrl) is
     NEVER required for local chat. This module only reports reachability and
     isolates all failures: unknown/unreachable global => local-only mode.
   - No global account linking happens implicitly. Local user IDs, usernames,
     and JWTs are never treated as global identity. Linking a global account,
     when the global service defines the protocol, must be an explicit user
     action — there is deliberately no syncEverything() here. */
(function () {
  var lastCheck = { status: 'unknown', at: 0 };

  function globalUrl() {
    try {
      var api = window.TrycordApi;
      if (api && api.globalUrl) return api.globalUrl();
    } catch (e) { /* ignore */ }
    return '';
  }

  // Non-throwing reachability probe. Safe to call anytime; chat never waits on it.
  async function check() {
    var url = globalUrl();
    if (!url) {
      lastCheck = { status: 'disabled', at: Date.now() };
      return lastCheck;
    }
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(() => ctrl.abort(), 5000);
      var res;
      try {
        res = await fetch(url.replace(/\/+$/, '') + '/api/health', { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      lastCheck = res.ok
        ? { status: 'ready', at: Date.now() }
        : { status: 'unreachable', at: Date.now() };
    } catch (e) {
      lastCheck = { status: 'unreachable', at: Date.now() };
    }
    return lastCheck;
  }

  function describe(status) {
    if (status === 'ready') return 'Connected';
    if (status === 'unreachable') return 'Unreachable — local only';
    if (status === 'disabled') return 'Off — local only';
    return 'Not checked';
  }

  window.TrycordGlobal = { check, describe, globalUrl, last: () => lastCheck };
})();
