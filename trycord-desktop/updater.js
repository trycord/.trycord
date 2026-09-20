// Trycord desktop auto-updater (electron-updater, GitHub Releases provider).
//
// Safety rules:
//   - Never blocks launch. Every failure is logged and swallowed.
//   - Only active in packaged builds (app.isPackaged). `npm start` never
//     contacts an update server.
//   - Only trusts the release provider configured in package.json build.publish
//     (electron-updater validates metadata + checksums; no custom downloaders).
//   - Never touches server configuration, databases, or the configured API URL.
//   - Install happens only via user action (Restart now) or on app quit when
//     the user enabled "Automatically install updates".
const path = require('path');
const fs = require('fs');

function prefsPath(app) {
  return path.join(app.getPath('userData'), 'updater-prefs.json');
}

function loadPrefs(app) {
  const defaults = { autoInstall: true, channel: 'latest', lastChecked: null };
  try {
    const raw = fs.readFileSync(prefsPath(app), 'utf8');
    return Object.assign(defaults, JSON.parse(raw));
  } catch (e) {
    return defaults;
  }
}

function savePrefs(app, prefs) {
  try {
    fs.writeFileSync(prefsPath(app), JSON.stringify(prefs), 'utf8');
  } catch (e) {
    /* prefs are best-effort; never break the app over them */
  }
}

// log(message) — main-process logger injected by main.js.
function initUpdater({ app, ipcMain, getWindow, log }) {
  const prefs = loadPrefs(app);
  let autoUpdater = null;

  // Renderer bridge (works in dev too; updater calls no-op there).
  ipcMain.handle('trycord:get-version', () => {
    try {
      return app.getVersion();
    } catch (e) {
      return 'unknown';
    }
  });
  ipcMain.handle('trycord:updater-prefs', () => Object.assign({}, prefs));
  ipcMain.handle('trycord:updater-prefs-set', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.autoInstall === 'boolean') prefs.autoInstall = patch.autoInstall;
      if (patch.channel === 'latest' || patch.channel === 'beta') {
        prefs.channel = patch.channel;
        applyChannel();
      }
      savePrefs(app, prefs);
    }
    return Object.assign({}, prefs);
  });
  ipcMain.handle('trycord:updater-check', async () => {
    await checkForUpdates('manual');
    return true;
  });
  ipcMain.handle('trycord:updater-install', () => {
    try {
      if (autoUpdater) autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      log('[updater] install failed: ' + (e && e.message ? e.message : e));
    }
    return true;
  });

  function send(ev) {
    try {
      const win = getWindow();
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('trycord-updater', ev);
      }
    } catch (e) {
      /* renderer may be gone; ignore */
    }
  }

  function applyChannel() {
    if (!autoUpdater) return;
    try {
      autoUpdater.channel = prefs.channel === 'beta' ? 'beta' : 'latest';
      autoUpdater.allowPrerelease = prefs.channel === 'beta';
    } catch (e) {
      log('[updater] channel apply failed: ' + (e && e.message ? e.message : e));
    }
  }

  async function checkForUpdates(reason) {
    if (!autoUpdater) {
      log('[updater] check skipped (not a packaged build, reason=' + reason + ')');
      return;
    }
    try {
      log('[updater] checking for updates (reason=' + reason + ', channel=' + prefs.channel + ')');
      await autoUpdater.checkForUpdates();
      prefs.lastChecked = new Date().toISOString();
      savePrefs(app, prefs);
    } catch (e) {
      // Offline / no server / bad metadata: log and keep running.
      log('[updater] check failed: ' + (e && e.message ? e.message : e));
      send({ type: 'error', message: String((e && e.message) || e) });
    }
  }

  if (!app.isPackaged) {
    log('[updater] dev mode: automatic updates disabled');
    return { checkForUpdates, prefs };
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log('[updater] electron-updater unavailable: ' + (e && e.message ? e.message : e));
    return { checkForUpdates, prefs };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = prefs.autoInstall !== false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  applyChannel();

  autoUpdater.on('checking-for-update', () => {
    log('[updater] checking-for-update');
    send({ type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    const version = (info && info.version) || '?';
    log('[updater] update-available: v' + version);
    send({ type: 'available', version });
  });
  autoUpdater.on('update-not-available', () => {
    log('[updater] update-not-available');
    send({ type: 'not-available', lastChecked: prefs.lastChecked });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = p && typeof p.percent === 'number' ? p.percent : 0;
    send({ type: 'progress', percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || '?';
    log('[updater] update-downloaded: v' + version);
    send({ type: 'downloaded', version });
  });
  autoUpdater.on('error', (e) => {
    // Corrupt download, checksum mismatch, no permission, offline, ...
    // The current version keeps running.
    log('[updater] error: ' + (e && e.message ? e.message : e));
    send({ type: 'error', message: String((e && e.message) || e) });
  });

  // Startup check (delayed so the UI paints first). Failures never propagate.
  setTimeout(() => {
    checkForUpdates('startup').catch(() => {});
  }, 8000);

  // Keep autoInstallOnAppQuit in sync when prefs change via IPC.
  const origSave = prefs;
  setInterval(() => {
    try {
      if (autoUpdater) autoUpdater.autoInstallOnAppQuit = origSave.autoInstall !== false;
    } catch (e) {}
  }, 30000).unref();

  return { checkForUpdates, prefs };
}

module.exports = { initUpdater };
