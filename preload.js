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

  onServerLog: (cb) => ipcRenderer.on('server-log', (_, d) => cb(d)),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_, s) => cb(s)),
  onNewResults: (cb) => ipcRenderer.on('new-results', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
});