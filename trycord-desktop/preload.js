// Isolated bridge: no Node exposure to the page.
// Desktop capabilities (updater, version) are exposed through a minimal,
// allow-listed IPC API. In the browser there is no bridge and the client
// degrades gracefully (update UI shows browser-mode state).
const { contextBridge, ipcRenderer } = require('electron');

let version = '1.5.0';
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const pkg = require('./package.json');
  if (pkg && pkg.version) version = String(pkg.version);
} catch (e) {
  /* keep fallback */
}

const listeners = new Set();
try {
  ipcRenderer.on('trycord-updater', (_event, ev) => {
    listeners.forEach((fn) => {
      try {
        fn(ev);
      } catch (e) {
        /* listener errors must not break the bridge */
      }
    });
  });
} catch (e) {
  /* IPC unavailable (should not happen in Electron) */
}

contextBridge.exposeInMainWorld('trycordDesktop', {
  platform: process.platform,
  version,
  updater: {
    provider: () => ipcRenderer.invoke('trycord:updater-provider'),
    getPrefs: () => ipcRenderer.invoke('trycord:updater-prefs'),
    setPrefs: (patch) => ipcRenderer.invoke('trycord:updater-prefs-set', patch),
    check: () => ipcRenderer.invoke('trycord:updater-check'),
    install: () => ipcRenderer.invoke('trycord:updater-install'),
    getVersion: () => ipcRenderer.invoke('trycord:get-version'),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  },
});
