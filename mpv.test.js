import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { Mpv, mpvArgs, splitLines } from './mpv.js'

test('splitLines keeps unfinished lines for the next chunk', () => {
  let [rest, msgs] = splitLines('', '{"event":"idle"}\n{"request_id":1,"err')
  assert.deepEqual(msgs, [{ event: 'idle' }])
  ;[rest, msgs] = splitLines(rest, 'or":"success","data":5}\n')
  assert.deepEqual(msgs, [{ request_id: 1, error: 'success', data: 5 }])
  assert.equal(rest, '')
  ;[rest, msgs] = splitLines('', 'not json\n\n{"event":"pause"}\n') // a bad line is skipped, not fatal
  assert.deepEqual(msgs, [{ event: 'pause' }])
})

test('mpvArgs', () => {
  const args = mpvArgs({ wid: 123n, pipe: 'P', volume: 0.35, muted: true })
  for (const a of ['--wid=123', '--input-ipc-server=P', '--no-config', '--volume=35', '--mute=yes', '--keep-open=yes', '--idle=yes', '--force-window=yes', '--no-osc', '--no-input-default-bindings', '--input-vo-keyboard=no', '--hwdec=auto-safe']) assert.ok(args.includes(a), a)
  assert.ok(!mpvArgs({ pipe: 'P' }).some(a => a.startsWith('--wid')))
  assert.deepEqual(mpvArgs({ pipe: 'P', extra: ['--vo=null'] }).at(-1), '--vo=null')
})

test('a missing mpv.exe ends with an error instead of hanging', async () => {
  const mpv = new Mpv('does-not-exist-mpv.exe', { pipe: String.raw`\\.\pipe\kotakbase-mpv-test-missing-${process.pid}` })
  const exited = new Promise(resolve => mpv.once('exit', resolve))
  await assert.rejects(mpv.command('get_property', 'pause'))
  assert.ok(await exited instanceof Error)
})

const exe = 'vendor/mpv/mpv.exe'
test('real mpv: commands, observed properties, quit', { skip: !existsSync(exe) && 'no vendor/mpv (run node scripts/vendor.mjs)', timeout: 20000 }, async t => {
  const pipe = String.raw`\\.\pipe\kotakbase-mpv-test-${process.pid}`
  const mpv = new Mpv(exe, { pipe, volume: 0.5, extra: ['--vo=null', '--ao=null', '--force-window=no'] })
  t.after(() => mpv.kill()) // a failed assertion must not leave mpv running (and the test runner waiting on it)
  assert.equal(await mpv.get('volume'), 50)
  const props = {}
  mpv.on('property', (name, value) => { props[name] = value })
  await mpv.observe('duration', 'track-list')
  const loaded = new Promise(resolve => mpv.on('event', m => m.event === 'file-loaded' && resolve()))
  await mpv.command('loadfile', 'av://lavfi:testsrc=size=320x240')
  await loaded
  await mpv.set('pause', true)
  assert.equal(await mpv.get('pause'), true)
  await assert.rejects(mpv.get('no-such-property'), /property not found/)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(typeof props.duration, 'number')
  assert.equal(props['track-list'].find(t => t.type === 'video')?.id, 1)
  const pid = mpv.proc.pid
  let exitErr
  mpv.once('exit', e => { exitErr = e })
  await mpv.quit()
  assert.equal(exitErr, null) // a requested quit is a clean exit
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(!execFileSync('tasklist', ['/FI', `PID eq ${pid}`]).toString().includes('mpv.exe'), 'mpv process gone')
})
