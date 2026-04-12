const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agora', {
  request: (method, params) => ipcRenderer.invoke('daemon-request', method, params),
  onEvent: (cb) => {
    ipcRenderer.on('daemon-event', (_e, data) => cb(data));
  },
  windowControl: (action) => ipcRenderer.send('window-control', action),
  // VPN management — handled by the main process, not the daemon
  vpnStart: (type, config) => ipcRenderer.invoke('vpn-start', type, config),
  vpnStop: ()             => ipcRenderer.invoke('vpn-stop'),
});
