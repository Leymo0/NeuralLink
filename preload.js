const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neural', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  gameStatus: () => ipcRenderer.invoke('game:status'),
  pickGameFolder: () => ipcRenderer.invoke('game:pickFolder'),
  runUpdate: (includeGame) => ipcRenderer.invoke('update:run', { includeGame }),
  pendingUpdate: () => ipcRenderer.invoke('update:pending'),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, text) => fn(text)),
  appVersion: () => ipcRenderer.invoke('app:version'),
  sendToGame: (command) => ipcRenderer.invoke('game:command', command),
  gameState: () => ipcRenderer.invoke('game:state'),

  captureSources: () => ipcRenderer.invoke('capture:sources'),
  toggleFullscreen: () => ipcRenderer.send('window:fullscreen'),
});
