/* Trycord runtime backend configuration.
   Edit this file to point the client at a different Trycord server —
   no rebuild needed. Examples:
     http://localhost:9971      (local development, the default)
     http://51.79.44.111:9971   (remote server)
     https://trycord.wispbyte.app (official instance)
   When served by the access-point server, /runtime-config.js may override
   these values from the deployment environment (only safe public keys).
   Precedence (most explicit wins): ?api= URL parameter, in-app Server
   setting (saved on this device), this file + runtime config, then default. */
window.TRYCORD_CONFIG = {
  API_URL: 'http://localhost:9971',
  // instanceId: 'official',   // namespaced browser storage for this instance
  // globalUrl: '',            // optional global service (empty = independent)
};
