// Trycord desktop window (Electron access point).
// Loads the bundled web client (client/, copied from frontend at build).
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
const { app, BrowserWindow, shell, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { initUpdater } = require('./updater');
const { Launcher, registerLauncherIpc } = require('./launcher');

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
    path.join(__dirname, '..', 'frontend', 'backend.json'),
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

// One session per machine. A second copy would run its own WebSocket, its own
// notification handlers and its own updater against the same profile, and the
// two would fight over localStorage. The second process hands its arguments
// over and exits.
//
// Declared before anything else so it wins over everything that follows.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWin;
    if (!win || win.isDestroyed()) {
      if (app.isReady()) createAppWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

// The self-test must observe a deterministic client state: isolate it to a
// throwaway profile so persisted user data (theme, sessions) cannot affect
// assertions. This must happen before the first window is created.
if (process.argv.includes('--smoke-test')) {
  const os = require('os');
  app.setPath('userData', path.join(os.tmpdir(), 'trycord-smoke-' + process.pid));
}

// The renderer is served from a custom application scheme rather than file://.
//
// Why this matters: a file:// document has an opaque origin. Measured against
// a real endpoint, the renderer sends NO Origin header at all, and the server
// then emits no Access-Control-Allow-Origin - so the browser discards every
// cross-origin API response. The desktop app simply could not talk to a server
// that had CLIENT_ORIGIN configured, no matter which instance it pointed at.
//
// trycord://app is a deliberate, fixed identity for the application. It is
// completely independent of the backend URL: one renderer origin connects to
// any number of instances (official, self-hosted, localhost), each of which
// just has to list this one origin in its own CLIENT_ORIGIN.
//
// This is NOT webSecurity:false. Security stays fully on; only the document's
// origin changes from opaque to a real, allowlistable one.
const APP_SCHEME = 'trycord';
const APP_HOST = 'app';
const APP_ORIGIN = APP_SCHEME + '://' + APP_HOST;

// Must run before the app is ready, or the scheme is already fixed by then.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      // standard: gives the scheme a real origin (trycord://app) instead of an
      // opaque one, and makes URL parsing behave like http(s).
      standard: true,
      // secure: a trustworthy origin, so localStorage, crypto.subtle and
      // service workers behave the way they do on https.
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function clientDir() {
  const bundled = path.join(__dirname, 'client');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;
  return path.join(__dirname, '..', 'frontend');
}

function clientEntry() {
  return path.join(clientDir(), 'index.html');
}

// Map trycord://app/<path> onto a file inside the client directory.
function resolveClientFile(requestUrl) {
  const url = new URL(requestUrl);
  if (url.hostname !== APP_HOST) return null;
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/index.html';
  // Normalise before joining, then confirm the result is still inside the
  // client directory. Without this, a request for trycord://app/../../.env
  // would read outside the bundle.
  const root = path.resolve(clientDir());
  const target = path.resolve(path.join(root, rel));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  // Routes are paths, not a hash, so trycord://app/settings is a real
  // navigation and there is no settings file. Serve the shell instead, or a
  // reload on any deep route is a blank window.
  if (!isFile(target)) return path.join(root, 'index.html');
  return target;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveClientFile(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    // net.fetch understands file:// and sets the correct Content-Type from the
    // extension, which the client relies on for its ES modules and CSS.
    return net.fetch(pathToFileURL(file).toString());
  });
}

let mainWin = null;
let updaterApi = null;
let launcher = null;

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
  // so the exe never permanently hardcodes localhost. It rides along as a
  // query on the app-scheme URL, exactly as it did on the old file:// URL.
  const target = APP_ORIGIN + '/index.html' + (launchApiUrl ? '?api=' + encodeURIComponent(launchApiUrl) : '');
  win.loadURL(target);
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
              (location.protocol === 'file:' || location.protocol === 'trycord:' ? '${API}' : location.origin);
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
          // The rail renders into #community-navigation; #global-navigation is
          // a landmark kept empty for assistive tech. Count the five global
          // destinations by name rather than by index, so adding a rail entry
          // (the community-creation action already lives here) does not break it.
          const wanted = ['Home', 'Direct messages', 'Notifications', 'Discover', 'Friends'];
          const labels = [...document.querySelectorAll('#community-navigation .rail-nav-item')]
            .map(b => b.getAttribute('data-label'));
          const rail = wanted.filter(w => labels.includes(w)).length;
          const title = (document.getElementById('context-title') || {}).textContent || '';
          const homeEnvironment = !!document.querySelector('#view-root .home-environment');
          const pres = (typeof window.TrycordPresentation !== 'undefined')
            ? window.TrycordPresentation.mode() : 'unset';
          // CSS must actually apply — a broken stylesheet leaves the shell as
          // plain text even though the DOM looks right.
          const rules = document.styleSheets.length ? document.styleSheets[0].cssRules.length : -1;
          const bodyBg = getComputedStyle(document.body).backgroundColor;
          // The rail must actually be laid out by the stylesheet, not collapsed
          // to nothing by a broken grid.
          const railW = Math.round(document.getElementById('community-navigation').getBoundingClientRect().width);
          return 'desk-shell-visible=' + desk + ' mobile-shell-visible=' + mobile + ' rail-tabs=' + rail + ' title=' + title + ' home-environment=' + (homeEnvironment ? 'yes' : 'no') + ' presentation=' + pres + ' hash=' + location.hash + ' cssRules=' + rules + ' body-bg=' + bodyBg + ' rail-width=' + railW;
        })()`);
        console.log('[smoke] home: ' + out);
        // rail-tabs counts the global destinations (Home/DMs/Notifications/Discover/Friends).
        if (!String(out).includes('rail-tabs=5') || !String(out).includes('home-environment=yes') ||
            !String(out).includes('presentation=desktop') || !String(out).includes('desk-shell-visible=true') ||
            !String(out).includes('hash=#/home')) process.exitCode = 1;
        const ruleMatch = String(out).match(/cssRules=(\d+)/);
        if (!ruleMatch || parseInt(ruleMatch[1], 10) < 150) {
          console.log('[smoke] FAIL stylesheet did not parse');
          process.exitCode = 1;
        }
        // Ember default page token (--t-pg #130b07). Keep in sync with
        // the Ember block in frontend/css/app.css.
        if (!String(out).includes('body-bg=rgb(19, 11, 7)')) {
          console.log('[smoke] FAIL design tokens did not apply');
          process.exitCode = 1;
        }
        const railWidth = String(out).match(/rail-width=(\d+)/);
        if (!railWidth || parseInt(railWidth[1], 10) < 40) {
          console.log('[smoke] FAIL the rail has no width (styles did not lay the shell out)');
          process.exitCode = 1;
        }
        const navOut = await win.webContents.executeJavaScript(`(async () => {
          // Rail buttons carry data-label and route on click; there is no
          // data-href on them.
          const btn = document.querySelector('#community-navigation .rail-nav-item[data-label="Discover"]');
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

// The updater sends to "the window". During startup that is the launcher, so
// the check happens where a person can see it instead of 8 seconds after a
// window they are already reading appears.
function activeWindow() {
  if (launcher && launcher.win && !launcher.win.isDestroyed()) return launcher.win;
  return mainWin;
}

app.whenReady().then(() => {
  registerAppProtocol();

  // Dev never contacts an update server, so there is nothing to check and the
  // launcher would only be a screen with nothing to say. Go straight in.
  const wantsLauncher = app.isPackaged && !process.argv.includes('--smoke-test');

  if (wantsLauncher) {
    launcher = new Launcher({
      app,
      log,
      onReady: () => {
        launcher = null;
        createWindow();
      },
      onRetry: () => { if (updaterApi) updaterApi.checkForUpdates('retry'); },
    });
    registerLauncherIpc(launcher);
    launcher.create();
  } else {
    createWindow();
  }

  // Packaged builds only. Every failure is logged and the app still launches.
  try {
    updaterApi = initUpdater({
      app,
      ipcMain,
      getWindow: activeWindow,
      // Called for every updater event so the launcher can show them.
      onEvent: (ev) => { if (launcher) launcher.onUpdaterEvent(ev); },
      // The launcher is the only thing that needs a prompt start; otherwise the
      // app window owns it and the check stays where it always was.
      checkOnStart: wantsLauncher,
      log,
    });
  } catch (e) {
    log('[updater] init failed (continuing without updates): ' + (e && e.message ? e.message : e));
    if (launcher) launcher.proceedAnyway();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The launcher closing is a quit, not a window-closed.
  if (launcher) return;
  if (process.platform !== 'darwin') app.quit();
});
