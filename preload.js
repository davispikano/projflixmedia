const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  removeFolder: (folder) => ipcRenderer.invoke('library:removeFolder', folder),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setVlcPath: () => ipcRenderer.invoke('config:setVlcPath'),
  setTmdbKey: (key) => ipcRenderer.invoke('config:setTmdbKey', key),
  fetchAllMeta: () => ipcRenderer.invoke('meta:fetchAll'),
  clearMeta: () => ipcRenderer.invoke('meta:clear'),
  onMetaProgress: (cb) => ipcRenderer.on('meta:progress', (_e, data) => cb(data)),
  getProgress: () => ipcRenderer.invoke('progress:get'),
  clearProgress: (p) => ipcRenderer.invoke('progress:clear', p),
  play: (p) => ipcRenderer.invoke('play', p),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  readImage: (p) => ipcRenderer.invoke('image:read', p),
});
