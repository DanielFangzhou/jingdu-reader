'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('desktop', {
  info: () => call('app:info'),

  settings: {
    load: () => call('settings:load'),
    save: (s) => call('settings:save', s),
  },

  library: {
    load: () => call('library:load'),
    save: (data) => call('library:save', data),
  },

  books: {
    pick: () => call('dialog:pickBooks'),
    pickFolder: () => call('dialog:pickFolder'),
    import: (srcPath, ext) => call('book:import', srcPath, ext),
    writeVariant: (id, ext, bytes) => call('book:writeVariant', id, ext, bytes),
    removeFile: (rel) => call('book:removeFile', rel),
    exists: (rel) => call('file:exists', rel),
    saveCover: (id, mime, bytes) => call('cover:save', id, mime, bytes),
  },

  win: {
    hide: () => call('win:hide'),
    show: () => call('win:show'),
    minimizeToTray: () => call('win:minimizeToTray'),
    toggleMaximize: () => call('win:toggleMaximize'),
    isMaximized: () => call('win:isMaximized'),
    setAlwaysOnTop: (on) => call('win:setAlwaysOnTop', on),
    getAlwaysOnTop: () => call('win:getAlwaysOnTop'),
    setFullScreen: (on) => call('win:setFullScreen', on),
    quit: () => call('win:quit'),
    updateHotkey: (acc) => call('hotkey:update', acc),
  },

  fs: {
    reveal: (rel) => call('shell:reveal', rel),
    openExternal: (url) => call('shell:openExternal', url),
    read: (absPath) => call('file:read', absPath),
  },

  // 从拖拽的 File 对象取真实磁盘路径（Electron 32+ 用 webUtils）
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
})
