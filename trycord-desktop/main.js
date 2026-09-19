// Trycord desktop window (Discord-style Electron wrapper).
// Loads the bundled web client (client/, copied from trycord-client at build).
// Backend: --api-url=<url> startup argument, else the client's own
// configuration (config.js / saved setting), else http://localhost:9971.
//   Trycord.exe --api-url=http://51.79.44.111:9971
// Dev:  npm start        Single-file exe:  npm run dist
// Self-test (needs server): npm run smoke
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const API = 'http://localhost:9971';

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '.trycord',
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The ?api= parameter is the client's top-precedence backend source,
  // so the exe never permanently hardcodes localhost.
  win.loadFile(clientEntry(), launchApiUrl ? { query: { api: launchApiUrl } } : {});
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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
            const res = await fetch(api + '/api/auth/register', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: 'secret123' }),
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
          const shell = !document.getElementById('shell-app').hidden;
          const nav = document.querySelectorAll('#sidebar-nav .nav-item').length;
          const title = document.getElementById('page-title').textContent;
          const welcome = [...document.querySelectorAll('#view h2')].some((h) => h.textContent.includes('Welcome back')) ? 'yes' : 'no';
          return 'shell-app-visible=' + shell + ' nav-items=' + nav + ' title=' + title + ' welcome=' + welcome;
        })()`);
        console.log('[smoke] home: ' + out);
        if (!String(out).includes('nav-items=8')) process.exitCode = 1;
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
