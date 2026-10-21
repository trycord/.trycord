// The bridge into the renderer.
//
// The renderer is the web client, and it runs with the sandbox on and the node
// integration off. It gets one narrow thing from the application: the address
// of the instance it should talk to.
//
// That is all it gets, and all it needs. The application has no authority of
// its own - it holds no database and no server state - so there is nothing
// else for it to hand over.

'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('trycord', {
  // The instance this build should talk to, when the operator named one.
  get backendUrl() {
    return process.env.TRYCORD_DESKTOP_BACKEND || '';
  },
  // The application version, for the about screen.
  get version() {
    return process.env.TRYCORD_DESKTOP_VERSION || '';
  },
  // Open a link in the reader's browser. The application is not a browser, and
  // a link to somebody else's page belongs in a tab they can see.
  openExternal(url) {
    if (/^https?:/i.test(String(url || ''))) {
      require('electron').shell.openExternal(String(url));
    }
  },
});
