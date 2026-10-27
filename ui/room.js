// Watch Together: a room of people whose players follow one host. The host picks what plays and its player is the
// clock; anyone can pause, play or seek (that goes through the host); the host can hand over to someone else, and if
// the host leaves, whoever joined first takes over.
import { joinRoom } from './room-net.js'
import { t as tr } from './i18n.js' // tr: messages here have a `t` (their type)

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I
export const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => CODE_CHARS[b % 32]).join('')
export const formatCode = code => code.match(/.{1,4}/g).join('-')
// a code typed in any format, or the end of an invite link (…/join#CODE or kotakbase://join/CODE)
export const parseCode = text => { const c = String(text).trim().split(/[#/]/).pop().toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-HJ-NP-Z2-9]{12}$/.test(c) ? c : null }
export const inviteLink = code => `https://runley.github.io/kotakbase/join#${formatCode(code)}`
export const validPin = pin => /^\d{4,8}$/.test(pin)

// ---- messages from other members are untrusted: anything malformed is dropped ----
const str = (v, max) => typeof v === 'string' && v.length <= max
const int = v => Number.isInteger(v) && v >= 0 && v < 1e9
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7
// what extensions hand over: a magnet (names in it may have raw spaces), a bare info hash (hex or base32), or a .torrent URL
const TORRENT = /^(magnet:\?[^\x00-\x1f]+|[0-9a-f]{40}|[a-z2-7]{32}|https?:\/\/[^\s\x00-\x1f]+)$/i
export function validLoad (l) {
  if (!l || typeof l !== 'object') return false
  if (!int(l.mediaId) || !int(l.episode) || !str(l.link, 4096) || !TORRENT.test(l.link) || !str(l.key, 5000)) return false
  if (l.fileIndex != null && !int(l.fileIndex)) return false
  if (l.title != null && !str(l.title, 500)) return false
  if (l.numbering != null && (typeof l.numbering !== 'object' || !Object.values(l.numbering).every(v => v == null || int(v)))) return false
  return true
}
export function valid (m) {
  if (!m || typeof m !== 'object') return false
  switch (m.t) {
    case 'hello': return str(m.name, 40) && Number.isSafeInteger(m.since) && m.since > 0 && (m.host == null || str(m.host, 40)) && (m.room == null || str(m.room, 40))
    case 'state': return typeof m.paused === 'boolean' && num(m.time) && (m.load == null || validLoad(m.load))
    case 'control': return typeof m.paused === 'boolean' && num(m.time)
    case 'host': return str(m.id, 40)
    case 'chat': return str(m.text, 300) && m.text.trim().length > 0
    case 'status': return typeof m.buffering === 'boolean' && (m.key == null || str(m.key, 5000))
    default: return false
  }
}

// What a follower does to match the host: play/pause, jump when far off, otherwise speed up or slow down a little
export function syncPlan (host, local) {
  const drift = host.time - local.time
  const play = host.paused === local.paused ? null : !host.paused
  if (host.paused) return { play, seek: Math.abs(drift) > 0.5 ? host.time : null, rate: 1 }
  if (Math.abs(drift) > 2) return { play, seek: host.time, rate: 1 }
  if (Math.abs(drift) > 0.3) return { play, seek: null, rate: 1 + Math.max(-0.1, Math.min(0.1, drift * 0.1)) }
  return { play, seek: null, rate: 1 }
}

// Everyone picks the same new host on their own: whoever joined first (their own clock, as they said in hello)
export const electHost = members => [...members].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))[0]?.id ?? null

export const loadKey = l => l ? JSON.stringify([l.mediaId, l.episode, l.link, l.fileIndex ?? null]) : ''

/**
 * Creates (no code) or joins a room. getPlayer() → { video, buffering } | null for what's playing here;
 * onLoad(load) plays what the host picked; onChange() redraws.
 * A saved room has a PIN (only those who know it meet there), a title it tells others, and no fixed host: whoever is
 * there first hosts it.
 */
export async function openRoom ({ code = newCode(), pin = null, title = null, name, getPlayer, onLoad, onChange, onChat = () => {}, onTitle = () => {} }) {
  const me = { id: null, name, since: Date.now() }
  const members = new Map() // id -> { id, name, since, channel, buffering, key }
  let host = null
  let load = null // what the room is watching (as the host last said)
  let net = { trackers: 0 }
  let last = null // { time, paused, wall, rate } for noticing seeks and pauses made here
  let ignoreUntil = 0 // changes we made ourselves to follow the host
  let lastSent = 0
  let autoPaused = false
  let myStatus = ''
  let closed = false
  let problem = ''
  const chat = [] // { name, text, at, mine }, newest last
  const addChat = (from, text, mine) => {
    chat.push({ name: from, text, at: Date.now(), mine })
    if (chat.length > 200) chat.shift()
    onChat(chat.at(-1))
    changed()
  }

  const isHost = () => host === me.id
  const send = (channel, m) => { try { if (channel.readyState === 'open') channel.send(JSON.stringify(m)) } catch {} }
  const broadcast = m => { for (const p of members.values()) send(p.channel, m) }
  const changed = () => { if (!closed) onChange() }

  const playerNow = () => {
    const p = getPlayer()
    return p && Number.isFinite(p.video.duration) && p.video.duration > 0 ? p : null
  }
  const stateMsg = () => {
    const p = playerNow()
    return { t: 'state', load, paused: p ? p.video.paused : true, time: p ? p.video.currentTime : 0 }
  }
  const sendState = () => { lastSent = Date.now(); broadcast(stateMsg()) }

  function setHost (id) {
    host = id
    autoPaused = false
    if (isHost()) sendState()
    changed()
  }

  function apply (p, plan, time) {
    if (plan.seek != null || plan.play != null) ignoreUntil = Date.now() + 1200
    if (plan.seek != null) p.video.currentTime = plan.seek
    if (plan.play === true) p.video.play()
    if (plan.play === false) p.video.pause()
    if (p.video.playbackRate !== plan.rate) p.video.playbackRate = plan.rate
    last = { time: plan.seek ?? time, paused: plan.play == null ? p.video.paused : !plan.play, wall: Date.now(), rate: plan.rate }
  }

  function onMessage (from, m) {
    const peer = members.get(from)
    if (!peer) return
    // the host's app sent something this one can't read (most likely another version): say so rather than ignore it
    if (!valid(m)) {
      if (from === host && !problem) { problem = tr("The host's Kotakbase sent something this one can't read. Make sure you both have the latest version (Settings → Updates)."); changed() }
      return
    }
    if (m.t === 'hello') {
      Object.assign(peer, { name: m.name, since: m.since, known: true })
      if (m.room && pin && !title) { title = m.room; onTitle(title) } // joined with just the code and PIN: learn its name
      if (!host && m.host) setHost(m.host) // just joined: learn who the host is
      // two people walked into an empty saved room at once and both took it: everyone settles on the same one
      else if (pin && m.host && host && m.host !== host) setHost(electHost([me, ...[...members.values()].filter(p => p.known)]))
      return changed()
    }
    if (m.t === 'host' && from === host) return setHost(m.id)
    if (m.t === 'chat') return addChat(peer.known ? peer.name : tr('Someone'), m.text.trim(), false)
    if (m.t === 'status') { peer.buffering = m.buffering; peer.key = m.key; return changed() }
    if (m.t === 'control' && isHost()) {
      const p = playerNow()
      if (!p) return
      apply(p, { seek: Math.abs(m.time - p.video.currentTime) > 1 ? m.time : null, play: m.paused === p.video.paused ? null : !m.paused, rate: 1 }, p.video.currentTime)
      autoPaused = false
      return sendState()
    }
    if (m.t === 'state' && from === host && !isHost()) {
      if (loadKey(m.load) !== loadKey(load)) {
        load = m.load
        changed()
        if (load) onLoad(load)
        return
      }
      const p = playerNow()
      if (!p || !load) return
      if (mine(p.video, Date.now())) return tellHost(p.video) // paused or sought here just now: that wins
      apply(p, syncPlan(m, { time: p.video.currentTime, paused: p.video.paused }), p.video.currentTime)
    }
  }

  // every quarter second: the host shares changes (and a heartbeat); others notice their own pauses/seeks and say
  // when they're buffering
  // paused, played or sought on this device since we last looked (not by following the host)
  const mine = (video, now) => now > ignoreUntil && !!last && (video.paused !== last.paused ||
    Math.abs((video.currentTime - last.time) - (last.paused ? 0 : (now - last.wall) / 1000 * last.rate)) > 1.5)
  const tellHost = video => {
    if (host && members.has(host)) send(members.get(host).channel, { t: 'control', paused: video.paused, time: video.currentTime })
    last = { time: video.currentTime, paused: video.paused, wall: Date.now(), rate: video.playbackRate }
  }

  function tick () {
    const p = playerNow()
    const now = Date.now()
    if (p) {
      const { video } = p
      const changedHere = mine(video, now)
      if (isHost()) {
        if (changedHere || now - lastSent > 1000) sendState()
        // wait for anyone still loading this episode, then carry on
        const waiting = [...members.values()].some(m => m.buffering && m.key === loadKey(load))
        if (waiting && !video.paused) { autoPaused = true; ignoreUntil = now + 1200; video.pause(); sendState() }
        if (!waiting && autoPaused && video.paused) { autoPaused = false; ignoreUntil = now + 1200; video.play(); sendState() }
        if (changedHere && video.paused) autoPaused = false // paused by hand: stays paused
      } else if (changedHere) return tellHost(video)
      last = { time: video.currentTime, paused: video.paused, wall: now, rate: video.playbackRate }
    } else last = null
    // still loading the torrent or buffering counts as not ready; with the player closed, nobody waits for us
    const open = getPlayer()
    const buffering = !!open && (!p || open.buffering)
    const status = JSON.stringify([buffering, open ? loadKey(load) : null])
    if (status !== myStatus && !isHost()) { myStatus = status; broadcast({ t: 'status', buffering, key: open ? loadKey(load) : null }) }
  }

  const hello = () => ({ t: 'hello', name: me.name, since: me.since, host, room: pin ? title : null })
  const connection = await joinRoom(pin ? `${code}:${pin}` : code, {
    onOpen (id, channel) {
      const peer = { id, name: tr('Connecting…'), since: Infinity, channel, buffering: false, key: null, known: false }
      members.set(id, peer)
      channel.onmessage = e => {
        if (typeof e.data !== 'string' || e.data.length > 16_384) return
        let m
        try { m = JSON.parse(e.data) } catch { return }
        onMessage(id, m)
      }
      send(channel, hello())
      if (isHost()) send(channel, stateMsg())
      myStatus = '' // tell the newcomer too
      changed()
    },
    onClose (id) {
      members.delete(id)
      if (id === host) setHost(electHost([me, ...[...members.values()].filter(m => m.known)]))
      changed()
    },
    onStatus (s) { net = s; changed() }
  })
  me.id = connection.id
  const timer = setInterval(tick, 250)
  // a saved room with nobody in it after a while: this device hosts it (with others there, their hello said who does)
  const claimTimer = pin && setTimeout(() => { if (!host && !closed) setHost(electHost([me, ...[...members.values()].filter(p => p.known)])) }, 8000)

  return {
    code,
    pin,
    me,
    get host () { return host },
    get load () { return load },
    get net () { return net },
    get problem () { return problem },
    isHost,
    members: () => [...members.values()],
    // the room was just created here: you're its host
    claim () { setHost(me.id) },
    makeHost (id) { if (isHost() && members.has(id)) { broadcast({ t: 'host', id }); setHost(id) } },
    // this device started playing something: as host, that's what the room watches now
    played (l) {
      if (!isHost()) return
      load = { ...l, key: loadKey(l) }
      sendState()
      changed()
    },
    chat: () => chat,
    say (text) {
      text = String(text).trim().slice(0, 300)
      if (!text) return
      broadcast({ t: 'chat', text })
      addChat(me.name, text, true)
    },
    rename (n) { me.name = n; broadcast(hello()); changed() },
    leave () {
      closed = true
      clearInterval(timer)
      clearTimeout(claimTimer)
      connection.leave()
      const p = getPlayer()
      if (p && p.video.playbackRate !== 1) p.video.playbackRate = 1
    }
  }
}
