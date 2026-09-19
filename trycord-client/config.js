/* Trycord runtime backend configuration.
   Edit this file to point the client at a different Trycord server —
   no rebuild needed. Examples:
     http://localhost:9971      (local development, the default)
     http://51.79.44.111:9971   (remote server)
   Precedence (most explicit wins): ?api= URL parameter, in-app Server
   setting (saved on this device), this file, then the built-in default. */
window.TRYCORD_CONFIG = {
  API_URL: 'http://localhost:9971',
};
