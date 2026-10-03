// The launcher window.
//
// The app window is not created until this one says it's safe, so nothing is
// initialised behind it. It replaces the updater's delayed background check:
// the check happens here, where it can be seen.
//
// Every state on screen is one the updater actually reported. No invented
// progress, no staged animation pretending to be work.

const { BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const WAITING   = 'waiting';
const CHECKING  = 'checking';
const CURRENT   = 'current';
const AVAILABLE = 'available';
const READY     = 'ready';
const BLOCKED   = 'blocked';

class Launcher {
  constructor({ app, log, onReady, onRetry }) {
    this.app = app;
    this.log = log;
    this.onReady = onReady;
    this.onRetry = onRetry;

    this.win = null;
    this.state = WAITING;
    this.appVersion = 'unknown';
    this.update = null;
    this.progress = null;
    this.error = null;
    this.opened = false;

    try {
      this.appVersion = app.getVersion();
    } catch (e) {
      /* cosmetic, never worth failing startup over */
    }
  }

  create() {
    this.win = new BrowserWindow({
      width: 460,
      height: 420,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      backgroundColor: '#0d0b0a',
      title: 'Trycord',
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'launcher-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win.setMenuBarVisibility(false);
    this.win.loadFile(path.join(__dirname, 'launcher.html'));
    // ready-to-show, not load: showing earlier paints an unpainted frame.
    this.win.once('ready-to-show', () => {
      this.win.show();
      this.log('[launcher] visible');
    });
    this.win.on('closed', () => { this.win = null; });
    this.send({ type: 'state', state: this.state, version: this.appVersion });
    return this.win;
  }

  send(payload) {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send('launcher:state', payload);
    } catch (e) {
      /* closing */
    }
  }

  setState(next, extra) {
    this.state = next;
    this.send(Object.assign({ type: 'state', state: next, version: this.appVersion }, extra));
    this.log('[launcher] ' + next);
  }

  // Everything the updater emits comes through here, so the updater never has
  // to know a launcher exists.
  onUpdaterEvent(ev) {
    if (!ev || typeof ev !== 'object') return;

    switch (ev.type) {
      case 'checking':
        this.setState(CHECKING);
        return;

      case 'not-available':
        // Not an error. The check worked and there was nothing to do, which is a
        // different thing from not being able to ask.
        this.setState(CURRENT);
        this.openApp();
        return;

      case 'available':
        this.update = { version: ev.version || null };
        this.setState(AVAILABLE, { update: this.update });
        return;

      case 'progress':
        // These numbers come from electron-updater's own download. Anything
        // else would be a fiction.
        this.progress = {
          percent: typeof ev.percent === 'number' ? ev.percent : null,
          transferred: ev.transferred || null,
          total: ev.total || null,
        };
        this.send({ type: 'progress', progress: this.progress });
        return;

      case 'downloaded':
        if (this.update) this.update.version = ev.version || this.update.version;
        this.setState(READY, { update: this.update });
        this.send({ type: 'download-complete', update: this.update });
        return;

      case 'error':
        // An update server being unreachable must not make the app unusable.
        this.error = { kind: ev.kind || 'unknown', message: ev.message || '' };
        this.setState(BLOCKED, { error: this.error });
        return;

      default:
    }
  }

  openApp() {
    if (this.opened) return;
    this.opened = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    if (this.onReady) this.onReady();
  }

  proceedAnyway() {
    this.error = null;
    this.openApp();
  }

  retry() {
    this.error = null;
    this.setState(CHECKING);
    if (this.onRetry) this.onRetry();
  }
}

function registerLauncherIpc(launcher) {
  ipcMain.handle('launcher:state', () => ({
    state: launcher.state,
    version: launcher.appVersion,
    update: launcher.update,
    progress: launcher.progress,
    error: launcher.error,
  }));
  ipcMain.handle('launcher:continue', () => { launcher.proceedAnyway(); return true; });
  ipcMain.handle('launcher:retry', () => { launcher.retry(); return true; });
  ipcMain.handle('launcher:open-external', (_e, url) => {
    // http(s) only, so the launcher cannot be talked into opening a local file.
    const v = String(url || '');
    if (/^https?:\/\//i.test(v)) shell.openExternal(v);
    return true;
  });
}

module.exports = { Launcher, registerLauncherIpc };