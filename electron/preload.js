const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agora', {
  request: (method, params) => ipcRenderer.invoke('daemon-request', method, params),
  onEvent: (cb) => {
    ipcRenderer.on('daemon-event', (_e, data) => cb(data));
  },
  windowControl: (action) => ipcRenderer.send('window-control', action),
});
