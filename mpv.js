// mpv as a separate process (no native addon, so no Electron ABI rebuilds, and an mpv crash can't take the app down),
// controlled over its JSON IPC pipe. Plain Node, no Electron: main.js passes in the exe path and the window to draw in.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'

// mpv's command line. Never reads the user's own mpv config, keys or scripts; Kotakbase draws all controls itself.
export function mpvArgs ({ wid, pipe, volume = 1, muted = false, extra = [] }) {
  return [
    ...(wid != null ? [`--wid=${wid}`] : []),
    `--input-ipc-server=${pipe}`,
    '--no-config',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes', // stay on the last frame at the end, so the player decides what comes next
    '--no-osc',
    '--osd-level=0',
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    '--input-cursor=no',
    '--cursor-autohide=no',
    '--hwdec=auto-safe',
    // the file streams from the local torrent server: read well ahead, and keep some behind for seeking back
    '--cache=yes',
    '--demuxer-max-bytes=256MiB',
    '--demuxer-max-back-bytes=64MiB',
    '--demuxer-readahead-secs=120',
    `--volume=${Math.round(volume * 100)}`,
    `--mute=${muted ? 'yes' : 'no'}`,
    '--msg-level=all=warn',
    ...extra
  ]
}

// The IPC pipe sends one JSON message per line; a chunk can end mid-line. Returns [the unfinished rest, messages].
export function splitLines (rest, chunk) {
  const lines = (rest + chunk).split('\n')
  rest = lines.pop()
  const messages = []
  for (const line of lines) {
    try { if (line.trim()) messages.push(JSON.parse(line)) } catch { console.warn('mpv: unreadable IPC line', line) }
  }
  return [rest, messages]
}

/**
 * One running mpv. Events: 'property' (name, value) for observed properties, 'event' (message) for mpv's own events
 * (file-loaded, end-file, …), 'exit' (Error | null) once, when the process ends or can't start.
 */
export class Mpv extends EventEmitter {
  constructor (exe, opts) {
    super()
    this.pending = new Map() // request_id → { resolve, reject }
    this.nextId = 1
    this.observed = []
    this.dead = false
    this.proc = spawn(exe, mpvArgs(opts), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.proc.stderr.setEncoding('utf8').on('data', d => console.warn('mpv:', d.trim()))
    this.proc.on('error', err => this.end(err)) // e.g. mpv.exe missing
    this.proc.on('exit', (code, signal) => this.end(code || signal ? new Error(`mpv exited (${signal ?? code})`) : null))
    this.ready = this.connect(opts.pipe)
    this.ready.catch(err => this.kill(err))
  }

  // The pipe appears once mpv has started; keep trying for a few seconds.
  async connect (pipe) {
    const deadline = Date.now() + 8000
    for (;;) {
      if (this.dead) throw this.error ?? new Error('mpv exited')
      try {
        this.sock = await new Promise((resolve, reject) => {
          const s = net.connect(pipe, () => { s.off('error', reject); resolve(s) })
          s.once('error', reject)
        })
        break
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`mpv didn't start (${err.message})`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    let rest = ''
    this.sock.setEncoding('utf8')
    this.sock.on('data', chunk => {
      let messages
      ;[rest, messages] = splitLines(rest, chunk)
      messages.forEach(m => this.receive(m))
    })
    this.sock.on('error', () => {})
    // the pipe only closes when mpv is going away: make sure it does
    this.sock.on('close', () => { if (!this.quitting) this.kill(new Error('mpv pipe closed')) })
  }

  receive (m) {
    if (m.request_id && this.pending.has(m.request_id)) {
      const { resolve, reject } = this.pending.get(m.request_id)
      this.pending.delete(m.request_id)
      return m.error === 'success' ? resolve(m.data) : reject(new Error(`mpv: ${m.error}`))
    }
    if (m.event === 'property-change') return this.emit('property', m.name, m.data)
    if (m.event) this.emit('event', m)
  }

  // Runs an mpv command (e.g. 'loadfile', url) and resolves with its result.
  async command (...command) {
    await this.ready
    if (this.dead) throw new Error('mpv exited')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sock.write(JSON.stringify({ command, request_id: id }) + '\n')
    })
  }

  get (name) { return this.command('get_property', name) }
  set (name, value) { return this.command('set_property', name, value) }
  // mpv sends each observed property's value now and again whenever it changes
  observe (...names) { return Promise.all(names.map(name => this.command('observe_property', this.observed.push(name), name))) }

  end (err) {
    if (this.dead) return
    this.dead = true
    this.error = err
    for (const { reject } of this.pending.values()) reject(err ?? new Error('mpv exited'))
    this.pending.clear()
    this.sock?.destroy()
    this.emit('exit', err)
  }

  kill (err) {
    if (this.dead) return
    this.proc.kill()
    this.end(err)
  }

  // Asks mpv to quit, and kills it if it hasn't within a second and a half. Resolves once it's gone.
  quit () {
    if (this.dead) return Promise.resolve()
    this.quitting = true
    const gone = new Promise(resolve => this.once('exit', resolve))
    this.command('quit').catch(() => {})
    const timer = setTimeout(() => this.kill(), 1500)
    return gone.then(() => clearTimeout(timer))
  }
}
