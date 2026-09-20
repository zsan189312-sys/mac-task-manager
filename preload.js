const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  onStats: (cb) => ipcRenderer.on('stats', (e, data) => cb(data)),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid)
});
