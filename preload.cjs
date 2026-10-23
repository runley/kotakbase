const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  // MyAnimeList Client ID for the details fallback ('' = off); read once, it never changes while running
  malClientId: ipcRenderer.sendSync('mal-client-id'),
  play: (link, episode, fileIndex, numbering, mpv) => ipcRenderer.invoke('play', link, episode, fileIndex, numbering, mpv),
  mpv: {
    available: () => ipcRenderer.invoke('mpv-available'),
    open: () => ipcRenderer.invoke('mpv-open'),
    load: url => ipcRenderer.invoke('mpv-load', url),
    get: name => ipcRenderer.invoke('mpv-get', name),
    set: (name, value) => ipcRenderer.invoke('mpv-set', name, value),
    stop: () => ipcRenderer.invoke('mpv-stop'),
    quit: () => ipcRenderer.invoke('mpv-quit'),
    bounds: rect => ipcRenderer.send('mpv-bounds', rect)
  },
  fullscreen: on => ipcRenderer.invoke('fullscreen', on),
  files: link => ipcRenderer.invoke('files', link),
  filesCancel: () => ipcRenderer.invoke('files-cancel'),
  nextFile: (link, episode, numbering, download) => ipcRenderer.invoke('next-file', link, episode, numbering, download),
  scrape: hashes => ipcRenderer.invoke('scrape', hashes),
  stop: () => ipcRenderer.invoke('stop'),
  focus: () => ipcRenderer.invoke('focus'),
  closeToTray: on => ipcRenderer.invoke('close-to-tray', on),
  // app updates from GitHub releases; changes arrive as on('update', state)
  // Watch Together invite link the app was opened with (or arrives later as on('invite', code))
  takeInvite: () => ipcRenderer.invoke('take-invite'),
  update: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install')
  },
  // AniList sync's sign-in; the token itself stays in the main process
  anilist: {
    account: () => ipcRenderer.invoke('anilist-account'),
    signIn: () => ipcRenderer.invoke('anilist-signin'),
    signOut: () => ipcRenderer.invoke('anilist-signout'),
    query: (query, variables) => ipcRenderer.invoke('anilist-query', query, variables)
  },
  on: (channel, cb) => {
    const listener = (_, ...args) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
})
