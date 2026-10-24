// Discord Rich Presence: "Watching Frieren · Episode 12 / 28" on your Discord profile while an episode plays. It talks to
// the Discord desktop app over its local pipe (no server, no sign-in); if Discord isn't running, nothing happens.
import net from 'node:net'

// What Discord should show for what's playing (null: nothing). now: { title, episode, total, cover, paused, time, duration }
export function toActivity (now) {
  if (!now?.title) return null
  const pad = s => String(s).padEnd(2, ' ').slice(0, 128) // Discord wants 2 to 128 characters
  const activity = {
    type: 3, // Watching
    status_display_type: 2, // the member list says "Watching <show>", not "Watching Kotakbase"
    details: pad(now.title),
    state: pad(now.total > 1 ? `Episode ${now.episode} / ${now.total}` : now.paused ? 'Paused' : 'Movie'),
    assets: { large_image: now.cover || 'logo', large_text: pad(now.title) },
    instance: false
  }
  // a progress bar while playing; none while paused (Discord would keep counting)
  if (!now.paused && Number.isFinite(now.duration) && now.duration > 0) {
    const start = Date.now() - now.time * 1000
    activity.timestamps = { start: Math.round(start), end: Math.round(start + now.duration * 1000) }
  }
  return activity
}

// Messages on Discord's pipe: [opcode, length] as little-endian int32s, then JSON
const frame = (op, data) => {
  const json = Buffer.from(JSON.stringify(data))
  const head = Buffer.alloc(8)
  head.writeInt32LE(op, 0)
  head.writeInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}

export function createDiscord (clientId) {
  let socket = null
  let ready = false
  let lastTry = 0
  let sent = null // the activity Discord has, to send only changes
  let wanted = null

  const connect = (n = 0) => {
    if (n > 9) return
    const s = net.createConnection(`\\\\?\\pipe\\discord-ipc-${n}`)
    // not there: Discord uses the first free pipe of 0-9; a connection that breaks later just ends
    s.once('error', () => { s.destroy(); if (socket === s) { socket = null; ready = false } else connect(n + 1) })
    s.once('connect', () => {
      socket = s
      s.write(frame(0, { v: 1, client_id: clientId }))
      s.on('data', () => { if (!ready) { ready = true; sent = undefined; push() } }) // the first reply is READY
      s.once('close', () => { if (socket === s) { socket = null; ready = false } })
    })
  }
  const push = () => {
    if (!ready) return
    // the progress bar moves on its own: a few seconds of drift isn't worth a message (Discord limits how often)
    const same = JSON.stringify({ ...wanted, timestamps: undefined }) === JSON.stringify({ ...sent, timestamps: undefined }) &&
      Math.abs((wanted?.timestamps?.start ?? 0) - (sent?.timestamps?.start ?? 0)) < 3000
    if (same) return
    sent = wanted
    socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, ...(wanted && { activity: wanted }) }, nonce: String(Date.now()) }))
  }

  return {
    set (now) {
      if (!clientId) return
      wanted = toActivity(now)
      // Discord may have started after Kotakbase: look for it again, every 15 s at most
      if (!socket && wanted && Date.now() - lastTry > 15_000) { lastTry = Date.now(); connect() }
      push()
    }
  }
}
