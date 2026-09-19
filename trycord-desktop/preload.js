// Minimal preload: isolated bridge, no Node exposure to the page.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('trycordDesktop', {
  platform: process.platform,
  version: '0.2.0',
});
