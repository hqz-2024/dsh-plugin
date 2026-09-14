// dsh-manifest-tool preload：安全桥接主进程能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectDir: () => ipcRenderer.invoke('select-dir'),
  listVideos: (dir) => ipcRenderer.invoke('list-videos', dir),
  readManifest: (dir) => ipcRenderer.invoke('read-manifest', dir),
  saveManifest: (dir, data) => ipcRenderer.invoke('save-manifest', dir, data),
  saveAsManifest: (data) => ipcRenderer.invoke('save-as-manifest', data),
});
