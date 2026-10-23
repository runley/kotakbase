import { fromMpv } from './lang.js'

const mpv = window.native.mpv

// Stands in for the <video> element in mpv mode: the same properties, methods and on* handlers the player uses,
// backed by mpv in the main process. One per played file; destroy() when done with it.
export class MpvVideo {
  #time = 0
  #volume = 1
  #muted = false
  #rate = 1
  #ranges = []
  #loaded = false // mpv still reports on the previous file until this one has loaded: ignore that
  paused = false
  duration = NaN
  tracks = [] // mpv's track-list
  error = null
  // the player sets onloadedmetadata, ontimeupdate, … like on a <video>
  constructor () {
    this.off = [
      window.native.on('mpv-prop', (name, value) => this.#prop(name, value)),
      window.native.on('mpv-event', e => this.#event(e)),
      window.native.on('mpv-exit', () => this.#fail('mpv stopped unexpectedly'))
    ]
  }

  #fail (message) {
    this.error = { message }
    this.onerror?.()
  }

  #prop (name, value) {
    if (name === 'volume') { this.#volume = value / 100; return this.onvolumechange?.() }
    if (name === 'mute') { this.#muted = value; return this.onvolumechange?.() }
    if (!this.#loaded) return
    if (name === 'time-pos' && value != null) { this.#time = value; this.ontimeupdate?.() }
    if (name === 'duration' && value) this.duration = value
    if (name === 'pause') { this.paused = value; (value ? this.onpause : this.onplay)?.() }
    if (name === 'speed') this.#rate = value
    if (name === 'track-list') this.tracks = value ?? []
    if (name === 'paused-for-cache') (value ? this.onwaiting : this.onplaying)?.()
    if (name === 'eof-reached' && value) this.onended?.()
    if (name === 'demuxer-cache-state') this.#ranges = value?.['seekable-ranges'] ?? []
  }

  async #event (e) {
    if (e.event === 'file-loaded') {
      ;[this.duration, this.tracks, this.paused] = await Promise.all([mpv.get('duration'), mpv.get('track-list'), mpv.get('pause')]).catch(() => [NaN, [], false])
      // only now: a time update before the duration is known would save progress against no duration
      this.#loaded = true
      // play/pause first: the play icon and controls auto-hide don't then depend on onloadedmetadata finishing
      ;(this.paused ? this.onpause : this.onplay)?.()
      this.onloadedmetadata?.()
    }
    if (!this.#loaded) return
    if (e.event === 'playback-restart') this.onplaying?.() // playing after the load or a seek
    if (e.event === 'end-file' && e.reason === 'error') this.#fail(e.file_error ?? 'unsupported format')
  }

  set src (url) { mpv.load(url).catch(e => this.#fail(e.message)) }
  get currentTime () { return this.#time }
  set currentTime (t) { this.#time = Math.max(0, Math.min(t, this.duration || t)); mpv.set('time-pos', this.#time).catch(() => {}) }
  get volume () { return this.#volume }
  set volume (v) { this.#volume = Number(v); mpv.set('volume', this.#volume * 100).catch(() => {}) }
  get muted () { return this.#muted }
  set muted (m) { this.#muted = !!m; mpv.set('mute', this.#muted).catch(() => {}) }
  get playbackRate () { return this.#rate }
  set playbackRate (r) { this.#rate = r; mpv.set('speed', r).catch(() => {}) }
  get buffered () { const r = this.#ranges; return { length: r.length, start: i => r[i].start, end: i => r[i].end } }
  play () { this.paused = false; return mpv.set('pause', false).catch(() => {}) }
  pause () { this.paused = true; mpv.set('pause', true).catch(() => {}) }

  // Like <video>.audioTracks: turning one on makes it mpv's audio track (aid)
  get audioTracks () {
    return fromMpv(this.tracks, 'audio').map(t => ({
      ...t,
      get enabled () { return t.selected },
      set enabled (on) { if (on) mpv.set('aid', t.number).catch(() => {}) }
    }))
  }

  get subTracks () { return fromMpv(this.tracks, 'sub') }
  setSub (n) { return mpv.set('sid', n ?? 'no').catch(() => {}) }

  destroy () {
    this.off.forEach(off => off())
    this.onloadedmetadata = this.onwaiting = this.onplaying = this.onerror = this.onplay = this.onpause = this.ontimeupdate = this.onended = this.onvolumechange = null
  }
}
