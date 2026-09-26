// Trycord desktop window (Electron access point).
// Loads the bundled web client (client/, copied from trycord-client at build).
// Backend precedence at launch:
//   1. --api-url=<url> startup argument (dev/smoke/self-host default route)
//   2. Bundled client/backend.json pin (the production backend for end users)
//   3. No ?api= at all: the client's own chain decides (saved setting, then
//      file:// local default). The shipped exe therefore reaches production
//      out of the box instead of pointing at localhost.
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

function bundledBackendPin() {
  // Single production pin, shared with the web client: read the bundled
  // backend.json (falling back to the source tree when running unpacked).
  // Returns a plausible http(s) URL or null — never throws.
  const candidates = [
    path.join(__dirname, 'client', 'backend.json'),
    path.join(__dirname, '..', 'trycord-client', 'backend.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const v = String((json && json.backendUrl) || '').trim().replace(/\/+$/, '');
      if (/^https?:\/\//i.test(v)) return v;
    } catch { /* corrupt pin: ignore, fall through */ }
  }
  return null;
}

const launchApiUrl = apiUrlFromArgs(process.argv) || bundledBackendPin();

// The self-test must observe a deterministic client state: isolate it to a
// throwaway profile so persisted user data (theme, sessions) cannot affect
// assertions. This must happen before the first window is created.
if (process.argv.includes('--smoke-test')) {
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'trycord-smoke-' + process.pid));
}

function clientEntry() {
  const bundled = path.join(__dirname, 'client', 'index.html');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(__dirname, '..', 'trycord-client', 'index.html');
}

let mainWin = null;
let updaterApi = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Trycord',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0d0b0a',
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
            location.hash = '#/';
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
          const homeEnvironment = !!document.querySelector('#view-root .home-environment');
          const pres = (typeof window.TrycordPresentation !== 'undefined')
            ? window.TrycordPresentation.mode() : 'unset';
          // CSS must actually apply — a broken stylesheet leaves the shell as
          // plain text even though the DOM looks right.
          const rules = document.styleSheets.length ? document.styleSheets[0].cssRules.length : -1;
          const bodyBg = getComputedStyle(document.body).backgroundColor;
          const spinePos = getComputedStyle(document.getElementById('presence-spine')).position;
          return 'desk-shell-visible=' + desk + ' mobile-shell-visible=' + mobile + ' rail-tabs=' + rail + ' title=' + title + ' home-environment=' + (homeEnvironment ? 'yes' : 'no') + ' presentation=' + pres + ' hash=' + location.hash + ' cssRules=' + rules + ' body-bg=' + bodyBg + ' spine-pos=' + spinePos;
        })()`);
        console.log('[smoke] home: ' + out);
        if (!String(out).includes('rail-tabs=4') || !String(out).includes('home-environment=yes') ||
            !String(out).includes('presentation=desktop') || !String(out).includes('desk-shell-visible=true') ||
            !String(out).includes('hash=#/home')) process.exitCode = 1;
        const ruleMatch = String(out).match(/cssRules=(\d+)/);
        if (!ruleMatch || parseInt(ruleMatch[1], 10) < 150) {
          console.log('[smoke] FAIL stylesheet did not parse');
          process.exitCode = 1;
        }
        // Ember default page token (--t-pg #130b07). Keep in sync with
        // the Ember block in trycord-client/css/app.css.
        if (!String(out).includes('body-bg=rgb(19, 11, 7)')) {
          console.log('[smoke] FAIL design tokens did not apply');
          process.exitCode = 1;
        }
        const navOut = await win.webContents.executeJavaScript(`(async () => {
          const btn = document.querySelector('#global-navigation [data-href="#/discover"]');
          if (!btn) return 'NAV-BUTTON-MISSING';
          btn.click();
          await new Promise((res) => setTimeout(res, 1500));
          const title = (document.getElementById('context-title') || {}).textContent || '';
          return 'hash=' + location.hash + ' title=' + title;
        })()`);
        console.log('[smoke] nav: ' + navOut);
        if (!String(navOut).includes('hash=#/discover') || !String(navOut).includes('title=Discover')) process.exitCode = 1;
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
