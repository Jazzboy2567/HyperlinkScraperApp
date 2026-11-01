const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getResults: () => ipcRenderer.invoke('get-results'),
  getSeenCount: () => ipcRenderer.invoke('get-seen-count'),

  serverStart: () => ipcRenderer.invoke('server-start'),
  serverStop: () => ipcRenderer.invoke('server-stop'),
  serverStatus: () => ipcRenderer.invoke('server-status'),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  runTest: (urlEntry, opts) => ipcRenderer.invoke('run-test', urlEntry, opts),
  runNow: (urlId) => ipcRenderer.invoke('run-now', urlId),

  clearSeenLinks: () => ipcRenderer.invoke('clear-seen-links'),
  clearAllResults: () => ipcRenderer.invoke('clear-all-results'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  getRssInfo: () => ipcRenderer.invoke('get-rss-info'),
  getScraperInfo: () => ipcRenderer.invoke('get-scraper-info'),
  updateScraper: () => ipcRenderer.invoke('update-scraper'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),

  listExtensions: () => ipcRenderer.invoke('list-extensions'),
  setExtensionEnabled: (id, on) => ipcRenderer.invoke('set-extension-enabled', id, on),
  reloadExtensions: () => ipcRenderer.invoke('reload-extensions'),
  getExtensionsDir: () => ipcRenderer.invoke('get-extensions-dir'),
  openExtensionsDir: () => ipcRenderer.invoke('open-extensions-dir'),
  rerankResults: () => ipcRenderer.invoke('rerank-results'),

  onServerLog: (cb) => ipcRenderer.on('server-log', (_, d) => cb(d)),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_, s) => cb(s)),
  onNewResults: (cb) => ipcRenderer.on('new-results', (_, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, s) => cb(s)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
});