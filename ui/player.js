import JASSUB from './vendor/jassub.js'
import { LANGS, langOf, pickTrack, pickSubTrack } from './lang.js'
import { MpvVideo } from './mpv-video.js'

const $player = document.getElementById('player')
let $root = $player // holds the player's controls: #player itself, or in mpv mode its stand-in in the overlay window
const $ = id => $root.querySelector('#' + id)
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}` }
const fmtSpeed = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${(b / 1e3).toFixed(1)} kb/s`
const PLAY = '<path d="M7 4.5v15l12-7.5z" class="fill"/>'
const PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" class="fill"/>'
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z" class="fill"/>'
const VOLUME_ON = SPEAKER + '<path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>'
const VOLUME_OFF = SPEAKER + '<path d="m16 9.5 5 5m0-5-5 5"/>'

// mute icon + slider follow the video, whatever changed it (button, M key, arrows, slider)
function showVolume (video) {
  const off = video.muted || video.volume === 0
  $('p-vol-icon').innerHTML = off ? VOLUME_OFF : VOLUME_ON
  $('p-volume').value = video.muted ? 0 : video.volume
  $root.querySelector('[data-p=mute]').setAttribute('aria-label', off ? 'Unmute' : 'Mute')
}

// Used for SRT tracks, which have no ASS header of their own.
const SRT_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Nunito,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1.5,2,80,80,60,1

[Events]
Format: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

let state = null // everything for the video currently open
// window closed to the tray: don't keep playing out of sight
window.native.on('hidden', () => state?.video.pause())

// language priority lists from Settings (ISO 639-2 codes, highest priority first)
export const LANG_DEFAULTS = { audioLangs: ['jpn'], subLangs: ['eng'] }
export function langPrefs (key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? LANG_DEFAULTS[key] } catch { return LANG_DEFAULTS[key] }
}
const trackLabel = t => [t.name || t.label, LANGS[langOf(t)]?.[0] ?? t.language].filter(Boolean).join(' · ') || `Track ${t.number ?? ''}`

// matroska stores each ASS line as "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text", which libass takes directly.
// matroska-subtitles drops ReadOrder and libass drops repeated ReadOrders, so give every distinct line its own (seek replays still dedupe).
function chunk (sub, track) {
  const key = `${track.number}|${sub.time}|${sub.layer}|${sub.text}`
  if (!state.order.has(key)) state.order.set(key, state.order.size)
  const order = state.order.get(key)
  if (track.type === 'ass' || track.type === 'ssa') {
    return [order, sub.layer ?? 0, sub.style, sub.name, sub.marginL, sub.marginR, sub.marginV, sub.effect, sub.text].map(v => v ?? '').join(',')
  }
  const text = sub.text.replace(/<(\/?)([ibu])>/gi, (_, end, tag) => `{\\${tag.toLowerCase()}${end ? 0 : 1}}`).replace(/<[^>]+>/g, '').replace(/\r?\n/g, '\\N')
  return `${order},0,Default,,0,0,0,,${text}`
}

function feed (sub, n) {
  const s = state
  const line = chunk(sub, s.tracks[n])
  s.jassub.ready.then(() => s.jassub.renderer.processChunk(line, sub.time, sub.duration)).catch(() => {})
}

async function selectTrack (n) {
  const s = state
  s.active = n
  renderSubMenu()
  if (s.mpv) return s.video.setSub(n) // mpv renders them itself
  if (n == null) { s.jassub?.destroy(); s.jassub = null; return }
  const t = s.tracks[n]
  const header = t.type === 'ass' || t.type === 'ssa' ? t.header : SRT_HEADER
  if (!s.jassub) {
    s.jassub = new JASSUB({ video: s.video, subContent: header, fonts: s.fonts })
  } else {
    await s.jassub.ready
    await s.jassub.renderer.setTrack(header)
  }
  if (state !== s || s.active !== n) return
  s.cues[n].forEach(sub => feed(sub, n))
}

function renderSubMenu () {
  const s = state
  const items = [[null, 'Off'], ...Object.values(s.tracks).map(t => [t.number, trackLabel(t)])]
  $('p-subs').innerHTML = ''
  for (const [n, label] of items) {
    const b = document.createElement('button')
    b.textContent = label
    b.className = s.active === n ? 'on' : ''
    b.onclick = () => { selectTrack(n); $('p-subs').hidden = true }
    $('p-subs').append(b)
  }
}

let idleTimer
function wake () {
  $player.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (state && !state.video.paused && $('p-subs').hidden && cm.hidden) $player.classList.add('idle') }, 2500)
}
// Chromium also sends mousemove when the page changes under a still pointer; only a real move wakes the controls
let lastPointer = ''
function onMouseMove (e) {
  const at = `${e.screenX},${e.screenY}`
  if (at === lastPointer) return
  lastPointer = at
  wake()
}

// The whole page goes fullscreen (not just the player), so the source picker and episode list show over it and
// fullscreen survives moving to another episode. In mpv mode the window does (the click asking for it lands in the
// overlay window, which can't make the page fullscreen); mpv's windows follow it.
let windowFullscreen = false
window.native.on('fullscreen', on => { windowFullscreen = on })
const isFullscreen = () => !!document.fullscreenElement || windowFullscreen
export const exitFullscreen = () => document.fullscreenElement ? document.exitFullscreen() : windowFullscreen && window.native.fullscreen(false)
const toggleFullscreen = () => isFullscreen() ? exitFullscreen() : state?.mpv ? window.native.fullscreen(true) : document.documentElement.requestFullscreen()

// mpv couldn't start or stopped: say why, and offer the built-in player in the skip button's place
function offerBuiltin (s, text) {
  s.failed = true
  $('p-loading').textContent = text
  const btn = $('p-skip')
  btn.hidden = false
  btn.textContent = 'Play with the built-in player'
  btn.dataset.to = 'builtin'
}

/**
 * Open the player and stream `link`.
 * opts: { title, subtitle, skipTimes (duration => Promise<chapters>, used when the file has none), onTitle (title clicked), onEpisodes (episode line clicked), link, episode, numbering (optional: { abs, tvdbSeason, tvdbSeasonEpisode } for continued seasons), fileIndex (optional: play this file of the torrent), resume, hasPrev, hasNext, onProgress(time, duration), onPrev, onNext, onSources (pick another source for this episode), nextInTorrent (optional: true when the next episode is in this torrent, so it's kept loaded), player ('mpv' or 'builtin'), autoMpv (switch to mpv when the built-in player finds no audio it can play) }
 */
export async function play (opts) {
  const useMpv = opts.player === 'mpv'
  // the main process swaps torrents itself, which keeps a batch torrent loaded when moving to its next episode
  close(false, false, useMpv)
  const video = useMpv ? new MpvVideo() : document.createElement('video')
  const s = state = { opts, video, mpv: useMpv, tracks: {}, cues: {}, fonts: [], order: new Map(), active: null, jassub: null, off: [], fileChapters: null, chapters: [] }
  $player.hidden = false
  pushPlayerEntry()
  $('player-video').replaceChildren(...(useMpv ? [] : [video]))
  if (useMpv) enterOverlay()
  else window.native.mpv.quit() // one left idle by a previous episode in mpv mode
  $('p-title').textContent = opts.title
  $('p-ep').textContent = opts.subtitle
  $('p-loading').textContent = 'Loading torrent…'
  $('p-subs').hidden = true
  $root.querySelector('[data-p=prev]').hidden = !opts.hasPrev
  $root.querySelector('[data-p=next]').hidden = !opts.hasNext
  ;['p-peers', 'p-down', 'p-up'].forEach(id => { $(id).textContent = id === 'p-peers' ? '0' : '0 kb/s' })
  renderSubMenu()
  wake()

  s.off.push(window.native.on('stats', st => {
    $('p-peers').textContent = st.peers
    $('p-down').textContent = fmtSpeed(st.down)
    $('p-up').textContent = fmtSpeed(st.up)
  }))
  s.off.push(window.native.on('sub-tracks', list => {
    for (const t of list) { s.tracks[t.number] = t; s.cues[t.number] = [] }
    const pick = pickSubTrack(list, langPrefs('subLangs'))
    if (pick) selectTrack(pick.number)
    else renderSubMenu()
  }))
  s.off.push(window.native.on('sub', (sub, n) => {
    s.cues[n]?.push(sub)
    if (s.active === n && s.jassub) feed(sub, n)
  }))
  s.off.push(window.native.on('chapters', list => { s.fileChapters = list; loadChapters(s) }))
  s.off.push(window.native.on('sub-font', data => {
    s.fonts.push(data)
    s.jassub?.ready.then(() => s.jassub.renderer.addFonts([data])).catch(() => {})
  }))

  // Electron prefixes errors from the main process with "Error invoking remote method 'play': Error: "
  const reason = e => e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
  // mpv starts while the torrent loads
  const mpvStarted = useMpv && window.native.mpv.open().then(() => null, e => e)
  let src
  try { src = await window.native.play(opts.link, opts.episode, opts.fileIndex, opts.numbering, useMpv) } catch (e) {
    if (state === s) $('p-loading').textContent = `Can't play this torrent: ${reason(e)}`
    return
  }
  const mpvError = await mpvStarted
  if (state !== s) return
  if (mpvError) return offerBuiltin(s, `mpv couldn't start: ${reason(mpvError)}`)

  video.autoplay = true
  video.volume = Number(localStorage.getItem('volume') ?? 1)
  video.muted = localStorage.getItem('muted') === 'true'
  video.onvolumechange = () => showVolume(video)
  showVolume(video)
  video.src = src.url
  video.onloadedmetadata = () => {
    if (opts.resume && opts.resume < video.duration - 10) video.currentTime = opts.resume
    const audio = [...(video.audioTracks ?? [])]
    // Chromium lists only the audio tracks it can decode: none means Dolby/DTS-only audio, so the video would be silent
    s.noAudio = !useMpv && !!video.audioTracks && !audio.length
    if (s.noAudio && opts.autoMpv) return play({ ...opts, player: 'mpv', resume: video.currentTime })
    showSkip(s)
    const i = pickTrack(audio, langPrefs('audioLangs'))
    if (i !== -1) audio.forEach((t, k) => { t.enabled = k === i })
    if (useMpv) {
      const subs = video.subTracks
      for (const t of subs) s.tracks[t.number] = t
      selectTrack(pickSubTrack(subs, langPrefs('subLangs'))?.number ?? null)
    }
    loadChapters(s)
  }
  video.onwaiting = () => { $('p-loading').textContent = 'Buffering…' }
  video.onplaying = () => { $('p-loading').textContent = '' }
  video.onerror = () => {
    const text = `Can't play this file (${video.error?.message || 'unsupported format'})`
    if (useMpv) offerBuiltin(s, text)
    else $('p-loading').textContent = text
  }
  // "playing" keeps the mini player out from the edge while the video plays (paused, it tucks away again)
  video.onplay = video.onpause = () => { $('p-play-icon').innerHTML = video.paused ? PLAY : PAUSE; $player.classList.toggle('playing', !video.paused); wake() }
  let lastSave = 0
  video.ontimeupdate = () => {
    $('p-time').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`
    $('p-played').style.width = `${video.currentTime / video.duration * 100}%`
    const b = video.buffered
    for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime && b.end(i) >= video.currentTime) $('p-buf').style.width = `${b.end(i) / video.duration * 100}%`
    if (Date.now() - lastSave > 3000) { lastSave = Date.now(); opts.onProgress(video.currentTime, video.duration) }
    showSkip(s)
  }
  video.onended = () => { opts.onProgress(video.duration, video.duration); if (opts.hasNext) actions.next() } // closes the player so the source picker shows
}

// ---- chapters: the file's own, else AniSkip's opening/ending times (opts.skipTimes) ----
// Needs both the file's chapter list (from the main process) and the duration (AniSkip matches by episode length).
async function loadChapters (s) {
  if (s.chapters.length || s.loadingChapters || !s.fileChapters || !s.video.duration) return
  s.loadingChapters = true
  let list = s.fileChapters
  if (!list.length && s.opts.skipTimes) list = await s.opts.skipTimes(s.video.duration).catch(() => [])
  if (state !== s) return
  s.chapters = list.map(c => ({ ...c, end: c.end ?? s.video.duration }))
  const d = s.video.duration
  // a tick where each chapter starts, and the opening/ending shaded
  $('p-chapters').innerHTML = s.chapters.map(c => (c.start > 0 ? `<i class="tick" style="left:${c.start / d * 100}%"></i>` : '') +
    (c.kind ? `<i class="band ${c.kind}" style="left:${c.start / d * 100}%;width:${(c.end - c.start) / d * 100}%"></i>` : '')).join('')
}

const chapterAt = (s, t) => s.chapters.findLast(c => t >= c.start)

// "Skip Intro" during the opening, "Skip Credits" (or "Next Episode" when the credits run to the end) during the ending
function showSkip (s) {
  const btn = $('p-skip')
  if (s.failed) return // it's offering the built-in player
  // no playable audio (Dolby/DTS only): this button offers another source instead, for as long as the episode plays
  if (s.noAudio) { btn.hidden = false; btn.textContent = 'No audio in this release: pick another source'; btn.dataset.to = 'sources'; return }
  const t = s.video.currentTime
  const seg = s.chapters.find(c => c.kind && t >= c.start && t < c.end - 1)
  btn.hidden = !seg
  if (!seg) return
  const toNext = seg.kind === 'ed' && seg.end >= s.video.duration - 2 && s.opts.hasNext
  btn.textContent = seg.kind === 'op' ? 'Skip Intro' : toNext ? 'Next Episode' : 'Skip Credits'
  btn.dataset.to = toNext ? 'next' : seg.end
}

// keepOverlay: the next file plays in mpv too, so mpv's windows stay up in between (taking them down handed the focus
// to the page and back, which brought the taskbar up over fullscreen)
export function close (stopTorrent = true, leaveFullscreen = true, keepOverlay = false) {
  if (!state) return
  const s = state
  state = null
  s.off.forEach(off => off())
  $('p-chapters').innerHTML = ''
  $('p-skip').hidden = true
  cm.hidden = true
  s.jassub?.destroy()
  s.video.pause()
  // unloading resets the position to 0 and fires timeupdate; with the handlers still on, that saved 0 as your progress
  s.video.ontimeupdate = s.video.onended = s.video.onwaiting = s.video.onplaying = s.video.onerror = null
  if (s.mpv) {
    s.video.destroy()
    if (!keepOverlay) leaveOverlay()
    // closing the player ends mpv; moving to another episode (leaveFullscreen false) keeps it for the next file
    leaveFullscreen ? window.native.mpv.quit() : window.native.mpv.stop()
  } else {
    s.video.removeAttribute('src')
    s.video.load()
  }
  if (leaveFullscreen) exitFullscreen()
  $player.hidden = true
  $player.classList.remove('playing')
  expand()
  if (stopTorrent) window.native.stop()
}

// ---- mini player: "back" docks the player at the right edge and keeps it playing ----
const isMini = () => $player.classList.contains('mini')

function minimize () {
  if (!state || isMini()) return false
  exitFullscreen()
  cm.hidden = true
  $('p-subs').hidden = true
  $player.classList.add('mini')
  $player.tabIndex = 0
  return true
}

function expand () {
  $player.classList.remove('mini')
  $player.removeAttribute('tabindex')
  wake()
}

// The full-size player is its own history entry (same URL as the page under it), so back docks it and forward
// restores it only when it's the next entry, just like a page. Hash routing ignores it because the URL doesn't change.
function pushPlayerEntry () {
  if (!history.state?.player) history.pushState({ player: true }, '')
}
function openFull () {
  expand()
  pushPlayerEntry()
}
window.addEventListener('popstate', () => {
  if (history.state?.player) { if (state) expand() } else minimize()
})

// ---- mpv mode: the controls move into a transparent window over mpv's video (main.js keeps it and mpv's window over
// #player's area). #player stays in the page, laid out as usual (full, docked, tucked), and the overlay copies its place
// and classes every frame. The episode list and dialogs (the source picker) opened over the full-size player move into
// the overlay too: they show over the video, and the overlay keeps the focus. Over the docked player they stay in the
// page, which hides the overlay and video while they're open.
let overlayWin = null
let sentBounds

// a dialog or the episode list is open, wherever it is: player keys are off then
const OVER_PLAYER = '.modal, .ep-drawer'
const dialogOpen = () => !!(document.querySelector(OVER_PLAYER) || $root.ownerDocument.querySelector(OVER_PLAYER))
new MutationObserver(records => {
  if ($root === $player || isMini()) return
  for (const node of records.flatMap(r => [...r.addedNodes])) {
    if (!node.matches?.(OVER_PLAYER)) continue
    const focused = node.contains(document.activeElement) && document.activeElement // e.g. the source picker's filter
    $root.ownerDocument.body.append(node)
    if (focused) focused.focus()
  }
}).observe(document.body, { childList: true })

function enterOverlay () {
  if ($root !== $player) return // still there from the previous file
  if (!overlayWin || overlayWin.closed) {
    overlayWin = window.open('', 'kotakbase-mpv-overlay') // main.js gives it its window options
    const d = overlayWin.document
    d.head.innerHTML = [...document.querySelectorAll('link[rel=stylesheet]')].map(l => `<link rel="stylesheet" href="${l.href}">`).join('') +
      '<style>html, body { background: transparent !important; margin: 0; overflow: hidden; }</style>'
    d.body.innerHTML = '<div id="player"></div>'
    const root = d.getElementById('player')
    bindPlayer(root)
    // the overlay covers the docked player: hovering it slides the player out, as hovering #player does
    root.addEventListener('pointerenter', () => $player.classList.add('hover'))
    root.addEventListener('pointerleave', () => $player.classList.remove('hover'))
    d.addEventListener('pointerdown', closeMenu)
    // the overlay has the focus while the player is full-size (main.js): its keys go to the page's handlers
    d.addEventListener('keydown', e => { if (!document.dispatchEvent(new KeyboardEvent('keydown', e))) e.preventDefault() })
  }
  $root = overlayWin.document.getElementById('player')
  $root.append(...$player.childNodes)
  followPlayer()
}

function leaveOverlay () {
  if ($root === $player) return
  $player.append(...$root.childNodes)
  document.body.append(...$root.ownerDocument.querySelectorAll(OVER_PLAYER))
  $root = $player
  $player.classList.remove('hover')
  sentBounds = 'null'
  window.native.mpv.bounds(null)
}

function followPlayer () {
  if ($root === $player) return
  // On the overlay's frames while it shows: a page fully covered by mpv's windows (fullscreen) counts as hidden and
  // gets none, which froze this loop (the cursor and controls never hid). Hidden, the overlay gets none; the page does.
  ;(sentBounds === 'null' ? window : overlayWin).requestAnimationFrame(followPlayer)
  const r = $player.getBoundingClientRect()
  // the part inside the window: the docked player tucks partly past its edge
  const x = Math.max(0, r.left)
  const y = Math.max(0, r.top)
  const w = Math.min(innerWidth, r.right) - x
  const h = Math.min(innerHeight, r.bottom) - y
  const covered = $player.hidden || w <= 0 || h <= 0 || document.querySelector('.modal, .ep-drawer')
  // mpv's video shows only when the whole player is in view (it would squeeze into the visible strip)
  const rect = covered ? null : { x, y, width: w, height: h, video: w >= r.width - 1 && h >= r.height - 1, focus: !isMini() }
  const key = JSON.stringify(rect)
  if (key !== sentBounds) { sentBounds = key; window.native.mpv.bounds(rect) }
  // laid out where the whole player is, so a part past the edge stays cut off
  // written only when changed: rewriting them every frame makes Chromium send mousemoves under a still pointer
  if ($root.className !== $player.className) $root.className = $player.className
  const style = `position: fixed; inset: auto; left: ${r.left - x}px; top: ${r.top - y}px; width: ${r.width}px; height: ${r.height}px; transform: none; transition: none; background: ${rect?.video === false ? '#000' : 'transparent'}`
  if ($root.dataset.style !== style) { $root.dataset.style = style; $root.style.cssText = style }
}

// ---- controls ----
const actions = {
  back: () => history.state?.player ? history.back() : minimize(),
  close: () => close(),
  play: () => state.video.paused ? state.video.play() : state.video.pause(),
  // In mpv mode the episode pauses under what comes next instead of closing: the source picker then opens over it in
  // the overlay, which keeps the focus (focus going to the page and back brought the taskbar up over fullscreen).
  // Picking plays the new episode; cancelling returns to this one.
  prev: () => { const s = state; if (s.mpv) { s.video.pause(); return s.opts.onPrev() } close(true, false); s.opts.onPrev() },
  next: () => { const s = state; if (s.mpv) { s.video.pause(); return s.opts.onNext() } close(!s.opts.nextInTorrent?.(), false); s.opts.onNext() },
  mute: () => { state.video.muted = !state.video.muted; localStorage.setItem('muted', state.video.muted) },
  subs: () => { $('p-subs').hidden = !$('p-subs').hidden },
  fullscreen: toggleFullscreen,
  skip: () => {
    const to = $('p-skip').dataset.to
    if (to === 'next') actions.next()
    else if (to === 'sources') state.opts.onSources?.()
    else if (to === 'builtin') play({ ...state.opts, player: 'builtin', autoMpv: false, resume: state.video.currentTime || state.opts.resume })
    else state.video.currentTime = Number(to)
  },
  // title → the show's page (the player docks and keeps playing); episode line → the episode list over the player.
  // The title leaves fullscreen (it docks the player); the episode list shows over the fullscreen player.
  title: () => { const s = state; minimize(); s.opts.onTitle?.() },
  episodes: () => state.opts.onEpisodes?.()
}
// on #player, and in mpv mode on its stand-in in the overlay window too
function bindPlayer (el) {
  el.addEventListener('click', e => {
    const a = e.target.closest('[data-p]')?.dataset.p
    if (a && state) actions[a]()
    else if (isMini()) openFull()
  })
  el.addEventListener('keydown', e => { if (isMini() && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFull() } })
  el.addEventListener('mousemove', onMouseMove)
  el.addEventListener('contextmenu', openMenu)
}
bindPlayer($player)
// the controls layer covers the video, so clicks on its empty area (not a button or the seek bar) count as clicks on the video
const ui = $player.querySelector('.p-ui')
ui.addEventListener('click', e => { if (state && e.target === ui) { $('p-subs').hidden ? actions.play() : ($('p-subs').hidden = true) } })
ui.addEventListener('dblclick', e => { if (e.target === ui) toggleFullscreen() })
$('p-volume').oninput = e => { if (!state) return; state.video.volume = e.target.value; state.video.muted = false; localStorage.setItem('volume', e.target.value); localStorage.setItem('muted', false) }

// ---- right-click menu: [label, submenu[] | action] where submenu entries are [label, checked, action] ----
const cm = document.createElement('div')
cm.className = 'cm'
cm.hidden = true
$player.append(cm)

function buildMenu (el, entries) {
  for (const [label, x] of entries) {
    const row = document.createElement('div')
    row.className = 'cm-row'
    const b = document.createElement('button')
    b.textContent = label
    row.append(b)
    if (Array.isArray(x)) {
      b.classList.add('cm-parent')
      const sub = document.createElement('div')
      sub.className = 'cm-sub'
      for (const [l, checked, fn] of x) {
        const sb = document.createElement('button')
        sb.textContent = l
        sb.className = checked ? 'on' : ''
        sb.disabled = !fn
        sb.onclick = () => { cm.hidden = true; fn() }
        sub.append(sb)
      }
      row.append(sub)
    } else {
      b.onclick = () => { cm.hidden = true; x() }
    }
    el.append(row)
  }
}

function openMenu (e) {
  if (!state || isMini()) return
  e.preventDefault()
  const s = state
  const v = s.video
  const audio = [...(v.audioTracks ?? [])]
  cm.replaceChildren()
  buildMenu(cm, [
    ['Audio', audio.length ? audio.map((t, i) => [trackLabel(t) || `Track ${i + 1}`, t.enabled, () => audio.forEach((a, k) => { a.enabled = k === i })]) : [['Default', true]]],
    ['Subtitles', [['Off', s.active == null, () => selectTrack(null)], ...Object.values(s.tracks).map(t => [trackLabel(t), s.active === t.number, () => selectTrack(t.number)])]],
    ['Chapters', s.chapters.length
      ? s.chapters.map(c => [`${fmtTime(c.start)}  ${c.title || 'Chapter'}`, chapterAt(s, v.currentTime) === c, () => { v.currentTime = c.start }])
      : [['No chapters', false]]],
    ['Playback Rate', [0.5, 0.75, 1, 1.25, 1.5, 2].map(r => [`${r}x`, v.playbackRate === r, () => { v.playbackRate = r }])],
    ['Fullscreen', toggleFullscreen],
    // mpv's video isn't a <video> the browser can float
    ...s.mpv ? [] : [['Picture in Picture', () => document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()]]
  ])
  cm.hidden = false
  const w = cm.offsetWidth
  const h = cm.offsetHeight
  const { innerWidth, innerHeight } = e.view // the overlay window's, in mpv mode
  cm.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`
  cm.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`
  // open submenus to the left when there's no room on the right
  cm.classList.toggle('flip', e.clientX + w * 2 > innerWidth)
}
function closeMenu (e) { if (!cm.contains(e.target)) cm.hidden = true }
document.addEventListener('pointerdown', closeMenu)

const seekAt = e => { const r = $('p-seek').getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) }
$('p-seek').addEventListener('pointermove', e => {
  if (!state) return
  const f = seekAt(e)
  $('p-hover').style.left = `${f * 100}%`
  const t = f * state.video.duration
  const c = chapterAt(state, t)
  $('p-hover').textContent = fmtTime(t) + (c?.title ? ` · ${c.title}` : '')
  if (e.buttons === 1) state.video.currentTime = f * state.video.duration
})
$('p-seek').addEventListener('pointerdown', e => { if (state) state.video.currentTime = seekAt(e) * state.video.duration })

document.addEventListener('keydown', e => {
  if (!state || isMini() || dialogOpen() || e.target.matches?.('input[type=text], input:not([type])')) return
  const v = state.video
  const keys = {
    ' ': actions.play,
    k: actions.play,
    ArrowLeft: () => { v.currentTime -= 5 },
    ArrowRight: () => { v.currentTime += 5 },
    ArrowUp: () => { v.volume = Math.min(1, v.volume + 0.05); $('p-volume').value = v.volume },
    ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); $('p-volume').value = v.volume },
    f: toggleFullscreen,
    m: actions.mute,
    n: () => state.opts.hasNext && actions.next(),
    // fullscreen: the browser leaves the page's fullscreen on Escape itself; mpv mode's window fullscreen is left here
    Escape: () => cm.hidden ? (isFullscreen() ? !document.fullscreenElement && exitFullscreen() : actions.back()) : (cm.hidden = true)
  }
  const fn = keys[e.key]
  if (fn) { e.preventDefault(); fn(); wake() }
})
