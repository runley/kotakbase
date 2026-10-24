import assert from 'node:assert/strict'
import test from 'node:test'
import { newCode, formatCode, parseCode, valid, validLoad, syncPlan, electHost, loadKey } from './ui/room.js'

test('room codes: 12 unambiguous characters, typed back in any format', () => {
  const code = newCode()
  assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/)
  assert.equal(parseCode(formatCode(code).toLowerCase()), code)
  assert.equal(parseCode(` ${formatCode(code)} `), code)
  assert.equal(parseCode('ABCD-EFGH-IJK0'), null) // I and 0 are never used
  assert.equal(parseCode('short'), null)
})

test('messages from other members: only well-formed ones get through', () => {
  const load = { mediaId: 21, episode: 3, link: 'magnet:?xt=urn:btih:abc', key: 'k', fileIndex: 2, numbering: { abs: 40 } }
  assert.ok(validLoad(load))
  // the link forms extensions really return
  assert.ok(validLoad({ ...load, link: 'magnet:?xt=urn:btih:abc&dn=[SubsPlease] Slime - 16 (1080p).mkv&tr=udp://t:1' }))
  assert.ok(validLoad({ ...load, link: '08ada5a7a6183aae1e09d831df6748d566095a10' }))
  assert.ok(validLoad({ ...load, link: 'BBMWHGU4YQ4GVQ2HCXI53EN5LAEBAO2G' }))
  assert.ok(validLoad({ ...load, link: 'https://nyaa.si/download/1.torrent' }))
  assert.ok(!validLoad({ ...load, link: 'magnet:?xt=urn:btih:abc\nevil' }))
  assert.ok(!validLoad({ ...load, link: 'not a link' }))
  assert.ok(!validLoad({ ...load, link: 'javascript:alert(1)' }))
  assert.ok(!validLoad({ ...load, link: 'file:///C:/Windows/notepad.exe' }))
  assert.ok(!validLoad({ ...load, episode: -1 }))
  assert.ok(!validLoad({ ...load, numbering: { abs: 'x' } }))
  assert.ok(valid({ t: 'state', paused: false, time: 12.5, load }))
  assert.ok(valid({ t: 'state', paused: true, time: 0, load: null }))
  assert.ok(!valid({ t: 'state', paused: 'no', time: 1 }))
  assert.ok(!valid({ t: 'control', paused: true, time: NaN }))
  assert.ok(valid({ t: 'hello', name: 'Ann', since: Date.now(), host: null }))
  assert.ok(!valid({ t: 'hello', name: 'x'.repeat(41), since: 1 }))
  assert.ok(valid({ t: 'chat', text: 'hi' }))
  assert.ok(!valid({ t: 'chat', text: '   ' }))
  assert.ok(!valid({ t: 'chat', text: 'x'.repeat(301) }))
  assert.ok(!valid({ t: 'eval', code: '1' }))
  assert.ok(!valid(null))
})

test('syncPlan: follow play/pause, nudge small drift, jump big drift', () => {
  assert.deepEqual(syncPlan({ time: 100, paused: false }, { time: 100.1, paused: false }), { play: null, seek: null, rate: 1 })
  assert.deepEqual(syncPlan({ time: 100, paused: false }, { time: 100, paused: true }), { play: true, seek: null, rate: 1 })
  assert.deepEqual(syncPlan({ time: 50, paused: true }, { time: 52, paused: false }), { play: false, seek: 50, rate: 1 })
  assert.deepEqual(syncPlan({ time: 100, paused: false }, { time: 90, paused: false }), { play: null, seek: 100, rate: 1 })
  const behind = syncPlan({ time: 101, paused: false }, { time: 100, paused: false })
  assert.equal(behind.seek, null)
  assert.ok(behind.rate > 1 && behind.rate <= 1.1)
  assert.ok(syncPlan({ time: 100, paused: false }, { time: 101, paused: false }).rate < 1)
})

test('electHost: whoever joined first, the same pick on every device', () => {
  const members = [{ id: 'b', since: 20 }, { id: 'c', since: 10 }, { id: 'a', since: 10 }]
  assert.equal(electHost(members), 'a')
  assert.equal(electHost([...members].reverse()), 'a')
  assert.equal(electHost([]), null)
})

test('loadKey: same episode and file means the same thing playing', () => {
  const l = { mediaId: 1, episode: 2, link: 'magnet:?xt=urn:btih:abc' }
  assert.equal(loadKey(l), loadKey({ ...l, title: 'other', numbering: {} }))
  assert.notEqual(loadKey(l), loadKey({ ...l, fileIndex: 3 }))
  assert.equal(loadKey(null), '')
})
