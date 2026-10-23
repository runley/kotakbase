import { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import bencode from 'bencode'
import { SubtitleStream } from 'matroska-subtitles'
import { pickFile, findEpisode, VIDEO, RISKY } from './episode.js'
import { readChapters } from './chapters.js'
import { Mpv } from './mpv.js'
import { setupAniList } from './anilist-auth.js'
import { createDownloads } from './downloads.js'
import updater from 'electron-updater'
const { autoUpdater } = updater

const dir = import.meta.dirname

// Keys kept out of the repo: secrets.local.json (git-ignored, packaged into the installer; see secrets.example.json),
// or the MAL_CLIENT_ID / ANILIST_CLIENT_ID environment variables when running from source. A missing key just turns its feature off.
const secrets = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'secrets.local.json'), 'utf8')) } catch { return {} } })()
ipcMain.on('mal-client-id', e => { e.returnValue = process.env.MAL_CLIENT_ID || secrets.malClientId || '' })
setupAniList(process.env.ANILIST_CLIENT_ID || secrets.anilistClientId || '', () => win)

// Backstop in case WebRTC peers come back (they're switched off below): they raise late errors when their torrent is
// removed mid-connection, with nothing left listening. The peer is gone already, so it's only logged; any other
// uncaught error still shows Electron's usual error box.
const isClosedPeer = err => err?.name === 'OperationError' || err?.code === 'ERR_DATA_CHANNEL' || /webrtc-polyfill|simple-peer/.test(err?.stack ?? '')
// WebTorrent 3.0.21 (latest) answers a peer's piece request that arrives just after its torrent was removed, reading
// from the torrent's storage that removal already released ("reading 'get'" of null). That torrent is gone, so: logged.
const isRemovedTorrentRequest = err => err instanceof TypeError && /reading 'get'/.test(err.message) && /webtorrent[\\/]lib[\\/]torrent\.js/.test(err.stack ?? '')
process.on('uncaughtException', err => {
  if (isClosedPeer(err)) return console.warn('WebRTC peer closed:', err.message)
  if (isRemovedTorrentRequest(err)) return console.warn('Piece request for a removed torrent ignored')
  dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${err?.stack ?? err}`)
})
// One running copy per profile, so two instances never fight over the download folder; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) process.exit(0)
// Watch Together invite links (kotakbase://join/CODE): Windows starts Kotakbase with the link as an argument, or hands
// it to the running one here. Only the room code is taken from it; the page asks before leaving a room it's in.
let invite = null
const takeInvite = argv => {
  const code = argv.map(a => String(a).match(/^kotakbase:\/\/join\/([A-Za-z0-9-]{12,20})\/?$/i)?.[1]).find(Boolean)
  if (code) invite = code
  return code
}
if (app.isPackaged) app.setAsDefaultProtocolClient('kotakbase') // the installed app only: a dev run would take the links over
takeInvite(process.argv)
ipcMain.handle('take-invite', () => { const c = invite; invite = null; return c })
app.on('second-instance', (_, argv) => { showWindow(); if (takeInvite(argv)) send('invite', invite) })

// Streams are throwaway: the previous torrent's files are deleted when another one starts, and the folder is wiped on start/quit.
const downloadPath = path.join(app.getPath('userData'), 'stream-cache')
const wipeDownloads = () => {
  try { fs.rmSync(downloadPath, { recursive: true, force: true }) } catch (e) { console.warn('Could not fully clear stream cache:', e.message) }
}
wipeDownloads()
// exposes video.audioTracks so the player can switch between dub/sub audio in one file
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks')
// No WebRTC (browser) peers: anime torrents get their peers from regular trackers and DHT, and WebRTC peers dropping
// mid-connection throw errors nothing can catch ("Close called", "Ice connection closed")
const client = new WebTorrent({ tracker: { wrtc: false } })
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'http://nyaa.tracker.wf:7777/announce'
]
let win
let tray
// downloads for watching offline; the player never deletes or deselects a torrent these own
const downloads = createDownloads({
  client,
  store: path.join(app.getPath('userData'), 'downloads.json'),
  defaultDir: path.join(app.getPath('videos'), 'Kotakbase'),
  trackers: TRACKERS,
  isPlaying: t => current?.torrent === t,
  onChange: list => send('downloads', list)
})
let quitting = false // closing the window only hides it (to the tray) unless the app is really quitting
app.on('before-quit', () => { quitting = true })
function showWindow () { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } }
let current = null // { torrent, file, path, subs, mpv }; a downloaded episode has no torrent, its file is read from disk

// Serves the file that is currently playing, with Range support so the <video> can seek.
const server = http.createServer((req, res) => {
  if (!current || req.url !== current.path) return res.writeHead(404).end()
  const { file } = current
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  let start = 0
  let end = file.length - 1
  if (range?.[1]) start = Number(range[1])
  if (range?.[2]) range[1] ? (end = Math.min(Number(range[2]), end)) : (start = file.length - Number(range[2]))
  res.writeHead(range ? 206 : 200, {
    // Chromium's webm demuxer plays matroska too
    'Content-Type': /\.mp4$|\.m4v$/i.test(file.name) ? 'video/mp4' : 'video/webm',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${file.length}` })
  })
  if (req.method === 'HEAD') return res.end()
  const stream = file.createReadStream({ start, end })
  res.on('close', () => stream.destroy())
  // mpv reads the subtitles itself
  if (!/\.mkv$/i.test(file.name) || current.mpv) return stream.pipe(res)
  // read subtitles out of the bytes the video is actually playing, so they follow seeks; a seek reuses the track info from the previous stream
  const subs = new SubtitleStream(current.subs)
  if (!current.subs) {
    subs.once('tracks', tracks => send('sub-tracks', tracks))
    subs.on('file', f => /font|ttf|otf/i.test(f.mimetype + f.filename) && send('sub-font', f.data))
  }
  subs.on('subtitle', (sub, track) => send('sub', sub, track))
  subs.on('error', () => {})
  current.subs = subs
  stream.pipe(subs).pipe(res)
}).listen(0, '127.0.0.1')

function send (channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function addTorrent (link) {
  return new Promise((resolve, reject) => {
    // extensions often return a bare info hash, so always add public trackers or metadata waits on slow DHT
    const torrent = client.add(link, { path: downloadPath, deselect: true, announce: TRACKERS })
    torrent.once('ready', () => resolve(torrent))
    torrent.once('error', reject)
  })
}

let browsing = null // torrent loaded only to list its files, not playing yet

async function loadTorrent (link) {
  const existing = await client.get(link)
  if (existing && !existing.ready) await new Promise((resolve, reject) => { existing.once('ready', resolve); existing.once('error', reject) })
  return existing ?? await addTorrent(link)
}

// Drops the torrent that was only opened to list files, unless it's the one playing.
async function dropBrowsing () {
  const t = browsing
  browsing = null
  if (t && t !== current?.torrent && !t.destroyed && !downloads.owns(t)) await client.remove(t, { destroyStore: true })
}

// Video files in a torrent, for choosing an OVA/special/movie out of a pack. Nothing downloads until one is played.
ipcMain.handle('files', async (_, link) => {
  const torrent = await loadTorrent(link)
  if (browsing !== torrent) await dropBrowsing()
  browsing = torrent
  return torrent.files.map((f, index) => ({ index, name: f.name, path: f.path, size: f.length })).filter(f => VIDEO.test(f.name))
})
ipcMain.handle('files-cancel', dropBrowsing)

let starting = Promise.resolve() // the play request in progress, which 'next-file' waits for
ipcMain.handle('play', (_, link, episode, fileIndex, numbering, mpvMode) => {
  const run = startPlay(link, episode, fileIndex, numbering, !!mpvMode)
  starting = run.catch(() => {})
  return run
})
// the stream that's playing is replaced: drop its torrent and files, unless it's a download's
async function dropCurrent (keep) {
  const t = current?.torrent
  current = null
  if (t && t !== keep && !downloads.owns(t)) await client.remove(t, { destroyStore: true })
}
async function startPlay (link, episode, fileIndex, numbering, mpvMode) {
  const existing = await client.get(link)
  await dropCurrent(existing)
  if (browsing === existing) browsing = null
  else await dropBrowsing()
  const torrent = await loadTorrent(link)
  // checked on the file list alone, before anything downloads; a refused torrent is dropped
  const refuse = async message => { if (!downloads.owns(torrent)) await client.remove(torrent, { destroyStore: true }); throw new Error(message) }
  const risky = torrent.files.filter(f => RISKY.test(f.name)).map(f => f.name)
  if (risky.length) await refuse(`This torrent contains program files (${risky.slice(0, 3).join(', ')}), a common sign of a fake or malware, so it won't be played. Pick another source.`)
  if (!torrent.files.some(f => VIDEO.test(f.name))) await refuse("There's no video in this torrent. Pick another source.")
  const file = torrent.files[fileIndex] ?? pickFile(torrent.files, episode, numbering)
  if (!downloads.owns(torrent)) torrent.files.forEach(f => f !== file && f.deselect()) // a download keeps fetching its other episodes
  file.select()
  return serve(file, torrent, `${torrent.infoHash}/${torrent.files.indexOf(file)}`, mpvMode)
}
// a downloaded episode, straight from disk
ipcMain.handle('play-download', async (_, id, index, mpvMode) => {
  const file = downloads.local(id, index)
  if (!file) throw new Error('This download is missing or not finished.')
  await dropCurrent()
  await dropBrowsing()
  return serve(file, null, `local/${id}/${index}`, mpvMode)
})
function serve (file, torrent, key, mpvMode) {
  // a random token keeps a stale <video> request from a previous play from attaching to this one
  current = { torrent, file, path: `/${key}/${Date.now()}`, mpv: mpvMode }
  // chapters sit in the MKV header before the video data, which is downloaded first anyway; [] for other formats
  const playing = current
  const chapters = /\.mkv$/i.test(file.name) ? readChapters(file.createReadStream({ start: 0, end: Math.min(file.length - 1, 32 * 1024 * 1024) })) : Promise.resolve([])
  chapters.then(list => { if (current === playing) send('chapters', list) })
  return { url: `http://127.0.0.1:${server.address().port}${current.path}`, name: file.name }
}

// Is the next episode in the torrent that's playing (a season pack)? Returns its index so it can start straight from
// this torrent, or null. With `download` (near the end of an episode) it also starts downloading it in the background;
// the playing file still comes first, since its pieces are the ones the player is reading.
ipcMain.handle('next-file', async (_, link, episode, numbering, download) => {
  await starting
  if (!current?.torrent || current.torrent !== await client.get(link)) return null // that torrent isn't the one playing any more
  const file = findEpisode(current.torrent.files, episode, numbering)
  if (!file || file === current.file) return null
  if (download) file.select()
  return current.torrent.files.indexOf(file)
})

// Live seeder counts for results an extension returned without them (Seadex always sends 0), like Hayase's
// "updatePeers". Nyaa's tracker: anime torrents announce there (big public trackers like opentrackr report 0 for them).
// Never throws: {} on failure or timeout.
// A plain HTTP scrape: the tracker answers only for hashes it knows, so unknown ones don't spoil the batch.
const SCRAPE_URL = 'http://nyaa.tracker.wf:7777/scrape'
async function scrape (hashes) {
  try {
    const query = hashes.map(h => 'info_hash=' + h.replace(/../g, '%$&')).join('&') // raw 20-byte hash, percent-encoded
    const res = await fetch(`${SCRAPE_URL}?${query}`, { signal: AbortSignal.timeout(8000) })
    const { files = {} } = bencode.decode(Buffer.from(await res.arrayBuffer()))
    return Object.entries(files).map(([key, c]) => [key.length === 20 ? Buffer.from(key, 'latin1').toString('hex') : key.toLowerCase(), { seeders: c.complete, leechers: c.incomplete, downloads: c.downloaded }])
  } catch {
    return []
  }
}
ipcMain.handle('scrape', async (_, hashes) => {
  hashes = hashes.filter(h => /^[0-9a-f]{40}$/i.test(h))
  const chunks = []
  // Nyaa's tracker rejects URLs over ~2000 characters (about 25 hashes), so ask in groups of 20
  for (let i = 0; i < hashes.length; i += 20) chunks.push(hashes.slice(i, i + 20))
  return Object.fromEntries((await Promise.all(chunks.map(scrape))).flat())
})

// Player closed: drop the torrent (stops uploading) and delete its files, like Hayase does for a torrent no player uses.
ipcMain.handle('stop', async () => {
  await dropCurrent()
  downloads.idle() // a finished download the player was reading can stop now, and waiting ones start
})

ipcMain.handle('downloads-list', () => downloads.list())
// a torrent opened only to pick a file from it isn't playing: let the download take it over
ipcMain.handle('downloads-add', async (_, spec) => { await dropBrowsing(); return downloads.add(spec) })
ipcMain.handle('downloads-pause', (_, id) => downloads.pause(id))
ipcMain.handle('downloads-resume', (_, id) => downloads.resume(id))
ipcMain.handle('downloads-remove', (_, id, index) => downloads.remove(id, index))
ipcMain.handle('downloads-dir', () => downloads.dir)
ipcMain.handle('downloads-open', async () => { fs.mkdirSync(downloads.dir, { recursive: true }); await shell.openPath(downloads.dir) })
ipcMain.handle('downloads-choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Folder for downloads', defaultPath: downloads.dir, properties: ['openDirectory', 'createDirectory'] })
  if (!r.canceled && r.filePaths[0]) downloads.setDir(r.filePaths[0])
  return downloads.dir
})

// ---- mpv player mode ----
// mpv (a separate process, see mpv.js) draws into `host`, an owned window kept over the player's area of the page; the
// controls sit in `overlay`, a transparent window above it (HTML can't draw over another program's video in the same
// window). The page opens the overlay with window.open and moves the player's controls into it, so player.js drives
// both modes. While the player is full-size the overlay holds the focus (Chromium hides an idle cursor only in the
// active window) and passes keys on to the page; docked, or under a dialog, the focus goes back to the page.
const mpvExe = app.isPackaged ? path.join(process.resourcesPath, 'mpv', 'mpv.exe') : path.join(dir, 'vendor', 'mpv', 'mpv.exe')
const OVERLAY = 'kotakbase-mpv-overlay'
let mpv = null
let mpvCount = 0
let host = null
let overlay = null
let playerRect = null // { x, y, width, height, video, focus } in page pixels, from the page; null while the player is hidden

function mpvHost () {
  // A BaseWindow, transparent: Chromium still layers its compositor window over child windows, and only a see-through
  // one lets mpv's video show
  if (!host || host.isDestroyed()) host = new BaseWindow({ parent: win, show: false, frame: false, transparent: true, backgroundColor: '#00000000', skipTaskbar: true, focusable: false, hasShadow: false, resizable: false, minimizable: false, maximizable: false })
  return host
}

const alive = w => w && !w.isDestroyed()
function placeMpv () {
  // quitting: window events still arrive while the window and its page are being destroyed
  if (!alive(win) || win.webContents.isDestroyed()) return
  const r = playerRect
  const shown = r && win.isVisible() && !win.isMinimized()
  // Docked or under a dialog, the page gets the focus back (typing in a dialog). After hiding the overlay, not before:
  // hiding the active window lets Windows activate whatever comes next (another app), and with Kotakbase inactive its
  // fullscreen showed the taskbar on top and the overlay never took the focus again.
  const giveBack = alive(overlay) && overlay.isFocused() && !(shown && r.focus) && win.isVisible()
  if (!shown) for (const w of [host, overlay]) if (alive(w)) w.hide()
  if (giveBack) win.focus()
  if (!shown) return
  const c = win.getContentBounds()
  const z = win.webContents.getZoomFactor()
  const bounds = { x: Math.round(c.x + r.x * z), y: Math.round(c.y + r.y * z), width: Math.max(1, Math.round(r.width * z)), height: Math.max(1, Math.round(r.height * z)) }
  for (const w of [mpvHost(), overlay]) {
    if (!alive(w)) continue
    w.setBounds(bounds)
    const visible = w === host ? r.video : true
    if (visible && !w.isVisible()) w.showInactive()
    if (!visible && w.isVisible()) w.hide()
  }
  focusOverlay()
}
// only while Kotakbase is the active app: never takes the focus from another program
function focusOverlay () {
  if (playerRect?.focus && alive(overlay) && overlay.isVisible() && alive(win) && win.isFocused()) overlay.focus()
}
ipcMain.on('mpv-bounds', (_, rect) => { playerRect = rect; placeMpv() })

ipcMain.handle('mpv-available', () => fs.existsSync(mpvExe))
ipcMain.handle('mpv-open', async () => {
  if (mpv) return mpv.ready
  if (!fs.existsSync(mpvExe)) throw new Error('mpv is missing from this installation')
  const wid = mpvHost().getNativeWindowHandle().readBigUInt64LE(0)
  const m = mpv = new Mpv(mpvExe, { wid, pipe: String.raw`\\.\pipe\kotakbase-mpv-` + `${process.pid}-${++mpvCount}` })
  m.on('property', (name, value) => send('mpv-prop', name, value))
  m.on('event', e => send('mpv-event', e))
  // only an exit nobody asked for (a crash): one being quit is no longer `mpv`, and the page may already use a new one
  m.on('exit', err => {
    if (mpv !== m) return
    mpv = null
    send('mpv-exit', err?.message ?? null)
  })
  await m.ready
  await m.observe('time-pos', 'duration', 'pause', 'eof-reached', 'track-list', 'volume', 'mute', 'speed', 'paused-for-cache', 'demuxer-cache-state')
})
const running = () => { if (!mpv) throw new Error('mpv is not running'); return mpv }
// Only what the player needs: the page also runs extension code, and mpv's full command set can start programs.
const MPV_PROPS = ['pause', 'time-pos', 'volume', 'mute', 'speed', 'aid', 'sid', 'duration', 'track-list']
const mpvProp = name => { if (!MPV_PROPS.includes(name)) throw new Error(`mpv property not allowed: ${name}`); return name }
ipcMain.handle('mpv-load', async (_, url) => {
  // only the file this app is serving
  if (!current || url !== `http://127.0.0.1:${server.address().port}${current.path}`) throw new Error('Not the file that is playing')
  await running().set('pause', false)
  await running().command('loadfile', url, 'replace')
})
ipcMain.handle('mpv-get', (_, name) => running().get(mpvProp(name)))
ipcMain.handle('mpv-set', (_, name, value) => running().set(mpvProp(name), value))
ipcMain.handle('mpv-stop', () => mpv?.command('stop'))
ipcMain.handle('mpv-quit', () => {
  const m = mpv
  mpv = null // a play right after this starts a new mpv instead of reusing the one shutting down
  return m?.quit()
})

// The page's own fullscreen (the built-in player) and this one both make the window fullscreen; mpv mode uses this
// one, since the click that asks for it lands in the overlay, not the page.
ipcMain.handle('fullscreen', (_, on) => win.setFullScreen(!!on))

// a new-episode notification was clicked: bring the window up
ipcMain.handle('focus', showWindow)

setInterval(() => {
  if (current?.torrent) send('stats', { down: client.downloadSpeed, up: client.uploadSpeed, peers: current.torrent.numPeers, progress: current.file.progress }) // none for a download played from disk
}, 1000)

// Windows shows notifications only for an app with an id (the installer's appId). Dev runs get their own, or Windows
// mixes them up with the installed app and shows electron.exe's icon in its taskbar and Start search.
app.setAppUserModelId(app.isPackaged ? 'app.kotakbase' : 'app.kotakbase.dev')
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    icon: path.join(dir, 'build', 'icon.png'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      // extensions scrape third-party sites from the page, same as Hayase which also turns CORS off
      webSecurity: false
    }
  })
  // KOTAKBASE_SCREEN=1 opens on the first screen other than the main one (test runs, kept out of the way of your work)
  const other = screen.getAllDisplays().filter(d => d.id !== screen.getPrimaryDisplay().id)[Number(process.env.KOTAKBASE_SCREEN) - 1]
  if (other) win.setBounds(other.workArea)
  win.loadFile(path.join(dir, 'ui', 'index.html'))
  // With "hide to tray" (Settings, on by default) closing only hides the window, so a mis-click mid-episode loses nothing
  // and new-episode checks keep running; Quit is then in the tray menu
  win.on('close', e => {
    if (quitting || !tray) return
    e.preventDefault()
    win.hide()
    send('hidden')
  })
  win.on('query-session-end', () => { quitting = true }) // never hold up Windows shutting down
  // mpv's windows follow the page's player area; Windows hides owned windows with a minimized owner, not a hidden one
  for (const e of ['move', 'resize', 'show', 'hide', 'minimize', 'restore']) win.on(e, placeMpv)
  win.on('focus', focusOverlay) // back to Kotakbase (Alt+Tab, a click on the title bar) while the player plays full-size
  win.on('enter-full-screen', () => { send('fullscreen', true); placeMpv() })
  win.on('leave-full-screen', () => { send('fullscreen', false); placeMpv() })
  win.webContents.setWindowOpenHandler(({ frameName }) => frameName !== OVERLAY
    ? { action: 'deny' }
    : { action: 'allow', overrideBrowserWindowOptions: { parent: mpvHost(), show: false, frame: false, transparent: true, backgroundColor: '#00000000', skipTaskbar: true, focusable: true, hasShadow: false, resizable: false, minimizable: false, maximizable: false } })
  win.webContents.on('did-create-window', w => {
    overlay = w
    // Alt+F4 in the focused overlay closes Kotakbase's window (to the tray or quitting), not the player's controls
    w.on('close', e => { if (alive(win) && !quitting) { e.preventDefault(); win.close() } })
    placeMpv()
  })
  setTray(true) // until the page says what Settings has
  setupUpdates()
  downloads.resumeAll()
})
// the page sends the setting at start and whenever it changes
ipcMain.handle('close-to-tray', (_, on) => setTray(!!on))
function setTray (on) {
  if (!on) { tray?.destroy(); tray = null; return }
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(path.join(dir, 'build', 'icon.png')).resize({ width: 32, height: 32 }))
  tray.setToolTip('Kotakbase')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Kotakbase', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]))
  tray.on('click', showWindow)
}

// Updates: the newest release on GitHub (its latest.yml, betas included), downloaded in the background. The page
// offers "Restart to update"; otherwise it installs silently the next time Kotakbase quits.
// state: { status: 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error', version?, error? }
let update = { status: 'idle' }
const setUpdate = u => { update = u; send('update', update) }
const checkUpdate = () => app.isPackaged
  ? autoUpdater.checkForUpdates().catch(e => setUpdate({ status: 'error', error: e.message }))
  : setUpdate({ status: 'error', error: 'Updates only work in the installed app.' })
function setupUpdates () {
  autoUpdater.allowPrerelease = true
  autoUpdater.autoInstallOnAppQuit = false // done in will-quit below: Kotakbase exits with app.exit(), which skips the updater's own hook
  autoUpdater.on('checking-for-update', () => { if (update.status !== 'ready') setUpdate({ status: 'checking' }) })
  autoUpdater.on('update-available', i => setUpdate({ status: 'downloading', version: i.version }))
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'latest' }))
  autoUpdater.on('update-downloaded', i => setUpdate({ status: 'ready', version: i.version }))
  autoUpdater.on('error', e => { if (update.status !== 'ready') setUpdate({ status: 'error', error: e.message }) })
  if (!app.isPackaged) return
  setTimeout(checkUpdate, 10_000)
  setInterval(checkUpdate, 4 * 3600_000)
}
ipcMain.handle('update-state', () => ({ ...update, current: app.getVersion() }))
ipcMain.handle('update-check', () => { checkUpdate() })
ipcMain.handle('update-install', () => { if (update.status === 'ready') autoUpdater.quitAndInstall(true, true) })

// Quitting (closing the window, Quit in the tray, or Windows shutting down): stop the torrents and delete their files
// first. Once will-quit is held off, app.quit() won't quit again, hence exit().
app.on('will-quit', e => {
  e.preventDefault()
  // mpv also exits by itself if this process dies, since its window goes with it
  downloads.persist() // how far each download got
  Promise.all([mpv?.quit(), new Promise(resolve => client.destroy(resolve))]).then(() => {
    wipeDownloads()
    if (update.status === 'ready') autoUpdater.install(true, false) // no-op if quitAndInstall already started it
    app.exit()
  })
})
