/* Trycord runtime backend configuration.
   Leave API_URL empty to auto-detect: same-origin when the client is served
   by a Trycord server, http://localhost:9971 for local file/desktop use.
   Set it to pin a specific instance without rebuilding, e.g.:
     http://51.79.44.111:9971
     https://trycord.wispbyte.app (official instance)
   When served with /runtime-config.js present, deployment values merge in.
   Precedence (most explicit wins): ?api= URL parameter, in-app Server
   setting (saved on this device), this file + runtime config, then default. */
window.TRYCORD_CONFIG = {
  API_URL: '',
  // instanceId: 'official',   // namespaced browser storage for this instance
  // globalUrl: '',            // optional global service (empty = independent)
};
