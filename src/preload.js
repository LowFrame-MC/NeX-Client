import electron from 'electron';

const { contextBridge, ipcRenderer } = electron;

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`Expected callback for ${channel}`);
  }

  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nex', {
  auth: {
    login: () => invoke('auth-login')
  },
  mods: {
    search: (payload) => invoke('search-mods', payload),
    download: (payload) => invoke('download-mod', payload),
    installed: (payload) => invoke('installed-mods', payload),
    onProgress: (callback) => subscribe('download-progress', callback)
  },
  resourcePacks: {
    search: (payload) => invoke('search-resource-packs', payload),
    download: (payload) => invoke('download-resource-pack', payload),
    installed: (payload) => invoke('installed-resource-packs', payload),
    onProgress: (callback) => subscribe('download-progress', callback)
  },
  launcher: {
    launch: (payload) => invoke('launch-game', payload),
    preview: (payload) => invoke('launch-preview', payload),
    supportedVersions: () => invoke('supported-versions'),
    onLog: (callback) => subscribe('minecraft-log', callback)
  },
  config: {
    read: () => invoke('get-client-config'),
    save: (config) => invoke('save-client-config', config),
    setModule: (payload) => invoke('set-module-toggle', payload)
  },
  window: {
    minimize: () => invoke('window-minimize'),
    maximize: () => invoke('window-maximize'),
    close: () => invoke('window-close')
  },
  app: {
    meta: () => invoke('app-meta'),
    openExternal: (url) => invoke('open-external', url),
    onError: (callback) => subscribe('app-error', callback)
  }
});
