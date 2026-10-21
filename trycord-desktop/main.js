// The desktop application.
//
// The desktop app is an access point: a window that loads the same web client
// the browser gets. It holds no database, no server state and no authority of
// its own.
//
// The one decision everything else follows from: the client is served from
// `trycord://app`, not from `file://`.
//
// A `file://` document has an opaque origin, and measured against a real
// endpoint the renderer sends no `Origin` header at all - so a server with
// `CLIENT_ORIGIN` configured emits no `Access-Control-Allow-Origin`, and the
// browser discards every API response. The desktop app simply could not talk
// to a server that had `CLIENT_ORIGIN` set, whichever instance it pointed at.
//
// `trycord://app` is a real, allowlistable origin, and it is independent of
// the backend: one renderer origin connects to any number of instances. Each
// instance just has to list this one origin in its own `CLIENT_ORIGIN`.
//
// Security is fully on. This is not `webSecurity: false`; only the origin
// changes.
//
// The startup order is the launcher's: the launcher window opens first, checks
// for an update, and the application window is not created until it opens.
// Nothing behind it is initialised, loaded or painted in the meantime. See
// docs/launcher.md.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, protocol, shell, session } = require('electron');

const updater = require('./updater.js');

const ORIGIN = 'trycord://app';
const ROOT = path.join(__dirname, 'client');

// The one window that matters.
let mainWindow = null;
// The launcher, which is up first and closes when the application opens.
let launcherWindow = null;

// -- the backend the client talks to -------------------------------------------

// Where the client should look for the API.
//
// The order is the documented one: the address the operator gave on the
// command line, then the address the build carries, and then the client's own
// chain decides. The build's own address is written into client/backend.json
// when the client is staged, and it is the same file the web deployment
// publishes.
function backendUrl() {
  const flag = process.argv.find((argument) => argument.startsWith('--api-url='));
  if (flag) {
    const value = flag.slice('--api-url='.length).trim();
    if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  }
  try {
    const file = path.join(ROOT, 'backend.json');
    if (fs.existsSync(file)) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && json.backendUrl && /^https?:\/\//i.test(json.backendUrl)) {
        return String(json.backendUrl).replace(/\/+$/, '');
      }
    }
  } catch (error) {
    console.warn('[desktop] the built backend address could not be read: ' + error.message);
  }
  return '';
}

// -- the protocol ---------------------------------------------------------------

// The protocol that carries the client.
//
// `standard` and `secure` together are what make the origin a real one:
// a standard scheme is treated as a normal origin by the network stack, and a
// secure scheme is one the browser will keep, so the renderer is not in an
// opaque context and the API's answers are readable.
protocol.registerSchemesAsPrivileged([
  { scheme: 'trycord', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// The client is served from the staged tree.
//
// Two rules make it work:
//
//   - a path that is not a file is the client shell, because the client routes
//     on paths and there is no `trycord://app/settings` file - without this,
//     a deep link is a blank window;
//   - the shell's <base> is rewritten to this origin, because the document
//     carries the hosted mount and the relative URLs under it have to resolve
//     here.
function serveClient(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const file = path.join(ROOT, pathname);
  // A path that tries to leave the staged tree is refused rather than
  // resolved: `path.join` would happily walk out of it with a `..`.
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    return new Response('Not found', { status: 404 });
  }

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const body = fs.readFileSync(file);
    const type = mimeFor(file);
    if (pathname === '/index.html') {
      const html = body.toString('utf8')
        .replace(/<base href="[^"]*">/i, `<base href="${ORIGIN}/">`);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response(body, { headers: { 'Content-Type': type } });
  }

  // The shell, for a route.
  const shell = path.join(ROOT, 'index.html');
  if (!fs.existsSync(shell)) {
    return new Response('The client is not staged. Run `npm run stage`.', { status: 500 });
  }
  const html = fs.readFileSync(shell, 'utf8')
    .replace(/<base href="[^"]*">/i, `<base href="${ORIGIN}/">`);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function registerProtocol() {
  protocol.handle('trycord', serveClient);
}

// -- the windows ---------------------------------------------------------------

function launcherWindowOptions() {
  return {
    width: 460,
    height: 320,
    resizable: false,
    frame: false,
    show: false,
    center: true,
    backgroundColor: '#141519',
    webPreferences: {
      preload: path.join(__dirname, 'launcher-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

function applicationWindowOptions() {
  return {
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 520,
    show: false,
    backgroundColor: '#141519',
    title: 'Trycord',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  };
}

function createLauncher() {
  launcherWindow = new BrowserWindow(launcherWindowOptions());
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWindow.on('closed', () => { launcherWindow = null; });
  launcherWindow.once('ready-to-show', () => { launcherWindow.show(); });
  return launcherWindow;
}

function createApplication() {
  mainWindow = new BrowserWindow(applicationWindowOptions());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // The window's own links open in the reader's browser. The application is
  // not a browser: a link to a document or a repository is somebody else's
  // page, and it belongs in a tab they can see.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer stays inside the application. A navigation away from the
  // client would take the window to a page with no application in it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN + '/') && url !== ORIGIN) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(ORIGIN + '/');

  // The backend the client should use, handed to the renderer before the
  // client boots so the first request already goes to the right place.
  const address = backendUrl();
  if (address) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(
        'window.trycord && window.trycord.setBackendUrl && window.trycord.setBackendUrl('
        + JSON.stringify(address) + ')'
      ).catch(() => { /* the client resolves its own backend */ });
    });
  }

  return mainWindow;
}

// -- the launcher and the update -----------------------------------------------

// The update check runs in the launcher, and it never blocks the application:
// an update server that cannot be reached is not a reason somebody cannot
// talk to their community.
async function runLauncher() {
  const launcher = createLauncher();
  const result = await updater.check();
  launcher.webContents.send('trycord:update', result);
  return result;
}

function openApplication() {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close();
  if (!mainWindow) createApplication();
  else if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// -- the single instance ---------------------------------------------------------

// One application, not several: a second launch focuses the window that is
// already open and exits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      openApplication();
    }
  });

  app.whenReady().then(async () => {
    registerProtocol();

    // The renderer origin has to be allowed by the instance it talks to. The
    // desktop app is not the instance's business to configure, so the origin is
    // written into the session's permission request handler: anything that is
    // not the client itself or an explicit API address is refused.
    const address = backendUrl();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'notifications') callback(true);
      else callback(false);
    });

    await runLauncher();

    // The application opens when the launcher says so, and when the reader
    // decides that the update is not worth waiting for.
    const { ipcMain } = require('electron');
    ipcMain.on('trycord:launch', () => openApplication());
  });

  app.on('window-all-closed', () => {
    // On macOS the application stays open with no windows, which is what a
    // person expects of an application they have not quit.
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { ORIGIN, serveClient, mimeFor, backendUrl };
