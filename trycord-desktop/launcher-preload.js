// Launcher bridge.
//
// Three calls and one subscription. The launcher runs no application code and
// has no filesystem or network access, so it cannot install anything on its own
// authority — it can only ask the main process to, and the main process decides.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

ipcRenderer.on('launcher:state', (_event, payload) => {
  listeners.forEach((fn) => {
    try {
      fn(payload);
    } catch (e) {
      /* a broken listener must not stop the others */
    }
  });
});

contextBridge.exposeInMainWorld('trycordLauncher', {
  getState: () => ipcRenderer.invoke('launcher:state'),
  continueToApp: () => ipcRenderer.invoke('launcher:continue'),
  retry: () => ipcRenderer.invoke('launcher:retry'),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', url),
  onState: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
});