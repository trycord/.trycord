// The launcher's bridge.
//
// The launcher is a small window of its own: it asks the main process what
// the update check found, and it tells the main process when the reader has
// had enough waiting.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trycordLauncher', {
  // What the update check found.
  onUpdate(handler) {
    ipcRenderer.on('trycord:update', (event, answer) => handler(answer));
  },
  // Open the application.
  launch() {
    ipcRenderer.send('trycord:launch');
  },
});
