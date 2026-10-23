// Watch Together's network: everyone in a room finds each other through public WebTorrent trackers (the same
// WebSocket signalling WebTorrent uses for browser peers) and then talks directly over WebRTC data channels.
// The trackers only pass connection offers along; no server of ours, and nothing about playback goes through them.
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.btorrent.xyz'
]
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }]
const OFFERS = 3 // per announce and tracker: each goes to a different room member the tracker knows
const ANNOUNCE_EVERY = 30_000 // new members are found when either side announces
const OFFER_TTL = 35_000

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
// trackers take the swarm id as 20 raw bytes in a JSON string, one char per byte
const binary = bytes => String.fromCharCode(...new Uint8Array(bytes))
const swarmId = async code => binary(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`kotakbase-room:${code}`)))

// Non-trickle: the whole offer/answer, ICE candidates included, goes through the tracker in one message
async function gathered (pc) {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise(resolve => {
      const done = () => { if (pc.iceGatheringState === 'complete') resolve() }
      pc.addEventListener('icegatheringstatechange', done)
      setTimeout(resolve, 4000) // enough candidates by now on any normal network
    })
  }
  return { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
}

/**
 * Joins the room `code`. Calls onOpen(peerId, channel) once a member is connected (their data channel is open) and
 * onClose(peerId) when they're gone. Returns { id, leave(), status() }.
 */
export async function joinRoom (code, { onOpen, onClose, onStatus = () => {} }) {
  const id = randomId()
  const infoHash = await swarmId(code)
  const peers = new Map() // peerId -> { pc, channel, open }
  const offers = new Map() // offerId -> { pc, channel, timer }
  const sockets = new Map() // url -> WebSocket
  let left = false
  let timer
  let soonTimer
  const soon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(announce, 500) }

  const drop = peerId => {
    const p = peers.get(peerId)
    if (!p) return
    peers.delete(peerId)
    p.pc.close()
    if (p.open) onClose(peerId)
  }
  const watch = (peerId, pc, channel) => {
    const p = { pc, channel, open: false }
    peers.set(peerId, p)
    channel.onopen = () => { if (peers.get(peerId) === p) { p.open = true; onOpen(peerId, channel) } }
    channel.onclose = () => { if (peers.get(peerId) === p) drop(peerId) }
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && peers.get(peerId) === p) drop(peerId) }
    // a member who never connects (a network that blocks direct connections) is retried on the next announce
    setTimeout(() => { if (peers.get(peerId) === p && !p.open) drop(peerId) }, 30_000)
  }

  async function makeOffers () {
    return Promise.all(Array.from({ length: OFFERS }, async () => {
      const pc = new RTCPeerConnection({ iceServers: ICE })
      const channel = pc.createDataChannel('room')
      await pc.setLocalDescription(await pc.createOffer())
      const offerId = randomId()
      offers.set(offerId, { pc, channel, timer: setTimeout(() => { offers.delete(offerId); pc.close() }, OFFER_TTL) })
      return { offer_id: offerId, offer: await gathered(pc) }
    }))
  }

  async function announce () {
    if (left) return
    const open = [...sockets.values()].filter(ws => ws.readyState === WebSocket.OPEN)
    onStatus({ trackers: open.length, members: [...peers.values()].filter(p => p.open).length })
    // the same offers can't go to several trackers (an answer from each would land on one connection), so each gets its own
    for (const ws of open) {
      const list = await makeOffers()
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: id, numwant: OFFERS, uploaded: 0, downloaded: 0, left: 1, event: 'started', offers: list }))
    }
  }

  async function onMessage (ws, data) {
    if (left || data.action !== 'announce' || data.info_hash !== infoHash || !data.peer_id || data.peer_id === id) return
    const from = data.peer_id
    if (data.offer && typeof data.offer.sdp === 'string') {
      // one connection per pair: the member with the smaller id makes the offer the other one takes
      if (peers.has(from)) return
      if (from > id) return soon() // so our offers reach them now rather than at the next announce
      const pc = new RTCPeerConnection({ iceServers: ICE })
      const ready = new Promise(resolve => { pc.ondatachannel = e => resolve(e.channel) })
      await pc.setRemoteDescription(data.offer)
      await pc.setLocalDescription(await pc.createAnswer())
      const answer = await gathered(pc)
      if (left || peers.has(from)) return pc.close()
      ready.then(channel => watch(from, pc, channel))
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: id, to_peer_id: from, offer_id: data.offer_id, answer }))
      setTimeout(() => { if (!peers.has(from)) pc.close() }, 30_000) // the data channel never came
    }
    if (data.answer && typeof data.answer.sdp === 'string') {
      const o = offers.get(data.offer_id)
      if (!o) return
      offers.delete(data.offer_id)
      clearTimeout(o.timer)
      if (from < id || peers.has(from)) return o.pc.close() // the other side makes this pair's offer
      watch(from, o.pc, o.channel)
      await o.pc.setRemoteDescription(data.answer).catch(() => drop(from))
    }
  }

  for (const url of TRACKERS) {
    const connect = () => {
      if (left) return
      const ws = new WebSocket(url)
      sockets.set(url, ws)
      ws.onopen = announce
      ws.onmessage = e => { try { onMessage(ws, JSON.parse(e.data)).catch(() => {}) } catch {} }
      ws.onclose = () => { if (!left) setTimeout(connect, 15_000) } // a tracker that's down is tried again later
    }
    connect()
  }
  timer = setInterval(announce, ANNOUNCE_EVERY)

  return {
    id,
    leave () {
      left = true
      clearInterval(timer)
      clearTimeout(soonTimer)
      for (const ws of sockets.values()) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: id, event: 'stopped', uploaded: 0, downloaded: 0, left: 1, numwant: 0 })) } catch {}
        ws.onclose = null
        ws.close()
      }
      for (const o of offers.values()) { clearTimeout(o.timer); o.pc.close() }
      for (const p of peers.values()) p.pc.close()
      offers.clear()
      peers.clear()
    }
  }
}
