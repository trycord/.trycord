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
//
// Diagnostics (no secrets — this flow carries no credentials):
//   [updater] version / provider / repository / channel / packaged
// Failure classes sent to the renderer:
//   - "missing-metadata": GitHub answered 404 for latest.yml. This means no
//     published release carries update metadata yet — a release-pipeline
//     problem, not a broken app.
//   - "offline": DNS/connection failure, no network, update host unreachable.
//   - "unknown": anything else; raw detail stays in the main-process log.
const path = require('path');
const fs = require('fs');

const PROVIDER = 'github';
const REPO_OWNER = 'LanxTheShowmaker';
const REPO_NAME = '.trycord';

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

// Classify a raw updater failure for UI + logging. Never throws.
function classifyError(e) {
  const raw = String((e && e.stack) || (e && e.message) || e || '');
  if (
    /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(raw) ||
    /Cannot find .*\.yml in the latest release artifacts/i.test(raw) ||
    /statusCode["']?\s*:\s*404|HttpError:\s*404|"method:\s*"GET"[\s\S]{0,200}404/i.test(raw) ||
    (/404/.test(raw) && /latest\.yml/i.test(raw))
  ) {
    return 'missing-metadata';
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ERR_INTERNET_DISCONNECTED|net::|offline/i.test(raw)) {
    return 'offline';
  }
  return 'unknown';
}

function shortDetail(e) {
  const raw = String((e && e.message) || e || 'unknown error');
  return raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
}

// log(message) — main-process logger injected by main.js.
function initUpdater({ app, ipcMain, getWindow, log }) {
  const prefs = loadPrefs(app);
  let autoUpdater = null;
  let appVersion = 'unknown';
  try {
    appVersion = app.getVersion();
  } catch (e) {
    /* version label is best-effort */
  }

  log('[updater] version: ' + appVersion);
  log('[updater] provider: ' + PROVIDER);
  log('[updater] repository: ' + REPO_OWNER + '/' + REPO_NAME);
  log('[updater] channel: ' + prefs.channel);
  log('[updater] packaged: ' + !!app.isPackaged);

  // Renderer bridge (works in dev too; updater calls no-op there).
  ipcMain.handle('trycord:get-version', () => appVersion);
  ipcMain.handle('trycord:updater-provider', () => ({
    provider: PROVIDER,
    owner: REPO_OWNER,
    repo: REPO_NAME,
  }));
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

  function reportError(e, where) {
    const kind = classifyError(e);
    log('[updater] ' + where + ' failed (' + kind + '): ' + shortDetail(e));
    send({
      type: 'error',
      kind,
      message: shortDetail(e),
      version: appVersion,
      channel: prefs.channel,
      provider: PROVIDER,
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });
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
      // Offline / unpublished release / bad metadata: log and keep running.
      reportError(e, 'check');
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
    log('[updater] update-available: ' + version);
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
    log('[updater] update-downloaded: ' + version);
    send({ type: 'downloaded', version });
  });
  autoUpdater.on('error', (e) => {
    // Corrupt download, checksum mismatch, no permission, offline,
    // unpublished release metadata, ... The current version keeps running.
    reportError(e, 'updater');
  });

  // Startup check (delayed so the UI paints first). Failures never propagate.
  setTimeout(() => {
    checkForUpdates('startup').catch(() => {});
  }, 8000);

  // Keep autoInstallOnAppQuit in sync when prefs change via IPC.
  setInterval(() => {
    try {
      if (autoUpdater) autoUpdater.autoInstallOnAppQuit = prefs.autoInstall !== false;
    } catch (e) {}
  }, 30000).unref();

  return { checkForUpdates, prefs };
}

module.exports = { initUpdater, classifyError, PROVIDER, REPO_OWNER, REPO_NAME };
