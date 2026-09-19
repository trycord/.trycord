// Trycord desktop window (Discord-style Electron wrapper).
// Loads the bundled web client (client/, copied from trycord-client at build).
// Needs trycord-server running at http://localhost:3000.
// Dev:  npm start        Single-file exe:  npm run dist
// Self-test (needs server): npm run smoke
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const API = 'http://localhost:3000';

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
  win.loadFile(clientEntry());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--smoke-test')) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const probe = await win.webContents.executeJavaScript(
          `fetch('${API}/health').then(async r => r.status + ' ' + await r.text()).catch(e => 'FETCH-FAIL ' + e)`
        );
        console.log('[smoke] page loaded; API probe: ' + probe);
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
