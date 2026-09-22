// Trycord desktop window (Electron access point).
// Loads the bundled web client (client/, copied from trycord-client at build).
// Backend: --api-url=<url> startup argument, else the client's own
// configuration (config.js / saved setting), else http://localhost:9971.
//   Trycord.exe --api-url=http://51.79.44.111:9971
// Dev:      npm run dev        (no update server contact)
// Build:    npm run build      (local package, never publishes)
// Windows:  npm run build:win  (NSIS installer, never publishes)
// Release:  npm run release    (CI publishes; needs GH_TOKEN)
// Self-test (needs server): npm run smoke
//
// The desktop app is an access point only: no database, no server state,
// no backend authority. Auto-updates touch only the desktop application
// itself and never server configuration or user data.
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { initUpdater } = require('./updater');

const API = 'http://localhost:9971';

function log() {
  // eslint-disable-next-line no-console
  console.log.apply(console, arguments);
}

// Backend override from the command line, e.g. --api-url=http://51.79.44.111:9971
// (also accepts "--api-url <url>"). Only http(s) URLs are honored.
function apiUrlFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    let v = null;
    if (a.startsWith('--api-url=')) v = a.slice('--api-url='.length);
    else if (a === '--api-url' && argv[i + 1]) v = String(argv[++i]);
    if (v && /^https?:\/\//i.test(v.trim())) return v.trim().replace(/\/+$/, '');
  }
  return null;
}

const launchApiUrl = apiUrlFromArgs(process.argv);

function clientEntry() {
  const bundled = path.join(__dirname, 'client', 'index.html');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(__dirname, '..', 'trycord-client', 'index.html');
}

let mainWin = null;
let updaterApi = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Trycord',
    autoHideMenuBar: true,
    backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin = win;
  // The ?api= parameter is the client's top-precedence backend source,
  // so the exe never permanently hardcodes localhost.
  win.loadFile(clientEntry(), launchApiUrl ? { query: { api: launchApiUrl } } : {});
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (mainWin === win) mainWin = null;
  });

  if (process.argv.includes('--smoke-test')) {
    const smokeApi = launchApiUrl || API;
    console.log('[smoke] backend: ' + smokeApi);
    win.webContents.once('did-finish-load', async () => {
      try {
        // Full UI proof, step 1: register in-page and persist the token.
        const reg = await win.webContents.executeJavaScript(`(async () => {
          try {
            const api = new URLSearchParams(location.search).get('api') ||
              (location.protocol === 'file:' ? '${API}' : location.origin);
            const u = 'smoke' + Date.now().toString(36);
            const legalRes = await fetch(api + '/api/legal');
            const legal = await legalRes.json();
            const res = await fetch(api + '/api/auth/register', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: 'secret123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion }),
            });
            if (!res.ok) return 'REGISTER-FAIL ' + res.status;
            const r = await res.json();
            localStorage.setItem('trycord.token', r.token);
            location.hash = '#/home';
            return 'TOKEN-SET';
          } catch (e) { return 'PAGE-FAIL ' + e; }
        })()`);
        console.log('[smoke] register: ' + reg);
        // Step 2: reload so the app boots and restores the session itself.
        win.reload();
        await new Promise((res) => setTimeout(res, 6000));
        const out = await win.webContents.executeJavaScript(`(() => {
          const desk = !!document.getElementById('desktop-shell')
            && !document.getElementById('desktop-shell').hidden;
          const mobile = !!document.getElementById('mobile-shell')
            && !document.getElementById('mobile-shell').hidden;
          const rail = document.querySelectorAll('#global-navigation .nav-row[data-nav]').length;
          const title = (document.getElementById('context-title') || {}).textContent || '';
          const atrium = !!document.querySelector('#view-root .atrium');
          const pres = (typeof window.TrycordPresentation !== 'undefined')
            ? window.TrycordPresentation.mode() : 'unset';
          return 'desk-shell-visible=' + desk + ' mobile-shell-visible=' + mobile + ' rail-tabs=' + rail + ' title=' + title + ' atrium=' + (atrium ? 'yes' : 'no') + ' presentation=' + pres;
        })()`);
        console.log('[smoke] home: ' + out);
        if (!String(out).includes('rail-tabs=4') || !String(out).includes('atrium=yes') ||
            !String(out).includes('presentation=desktop') || !String(out).includes('desk-shell-visible=true')) process.exitCode = 1;
      } catch (e) {
        console.log('[smoke] FAIL ' + e);
        process.exitCode = 1;
      }
      setTimeout(() => app.quit(), 500);
    });
  }
  return win;
}

app.whenReady().then(() => {
  createWindow();
  // Auto-updater: packaged builds only; dev never contacts an update server.
  // All failures are logged and swallowed — the app always launches.
  try {
    updaterApi = initUpdater({ app, ipcMain, getWindow: () => mainWin, log });
  } catch (e) {
    log('[updater] init failed (continuing without updates): ' + (e && e.message ? e.message : e));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
