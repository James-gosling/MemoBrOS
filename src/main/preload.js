const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('memo', {
  invoke: (channel, payload) => ipcRenderer.invoke('memo', channel, payload),
  pathFor: (file) => webUtils.getPathForFile(file),
  on: (handler) => ipcRenderer.on('memo:event', (_e, event) => handler(event)),
});
