import assert from 'node:assert/strict'
import test from 'node:test'
import { newCode, formatCode, parseCode, inviteLink, valid, validLoad, syncPlan, electHost, hostAfterHello, loadKey, validPin, shareLink } from './ui/room.js'

test('room codes: 12 unambiguous characters, typed back in any format', () => {
  const code = newCode()
  assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/)
  assert.equal(parseCode(formatCode(code).toLowerCase()), code)
  assert.equal(parseCode(` ${formatCode(code)} `), code)
  assert.equal(parseCode('ABCD-EFGH-IJK0'), null) // I and 0 are never used
  assert.equal(parseCode('short'), null)
  // invite links of both kinds
  assert.equal(parseCode(inviteLink(code)), code)
  assert.equal(parseCode(`kotakbase://join/${formatCode(code)}`), code)
  assert.match(inviteLink(code), /^https:\/\/runley\.github\.io\/kotakbase\/join#[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
})

test('messages from other members: only well-formed ones get through', () => {
  const load = { mediaId: 21, episode: 3, link: 'magnet:?xt=urn:btih:abc', key: 'k', fileIndex: 2, numbering: { abs: 40 } }
  assert.ok(validLoad(load))
  // the link forms extensions really return
  assert.ok(validLoad({ ...load, link: 'magnet:?xt=urn:btih:abc&dn=[SubsPlease] Slime - 16 (1080p).mkv&tr=udp://t:1' }))
  assert.ok(validLoad({ ...load, link: '08ada5a7a6183aae1e09d831df6748d566095a10' }))
  assert.ok(validLoad({ ...load, link: 'BBMWHGU4YQ4GVQ2HCXI53EN5LAEBAO2G' }))
  // nothing that makes others' apps fetch a URL the host picked
  assert.ok(!validLoad({ ...load, link: 'https://nyaa.si/download/1.torrent' }))
  assert.ok(!validLoad({ ...load, link: 'magnet:?xt=urn:btih:abc&xs=http://127.0.0.1/x.torrent' }))
  assert.equal(shareLink('magnet:?xt=urn:btih:abc&dn=A&xs=http://lan/x&ws=http://e/&as=http://e/&x.pe=1.2.3.4:5&tr.1=udp://t:1&XS.2=http://e'),
    'magnet:?xt=urn:btih:abc&dn=A&tr.1=udp://t:1')
  assert.equal(shareLink('https://nyaa.si/download/1.torrent'), null)
  assert.equal(shareLink('08ada5a7a6183aae1e09d831df6748d566095a10'), '08ada5a7a6183aae1e09d831df6748d566095a10')
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
  assert.ok(!valid({ t: 'hello', name: 'Ann', since: Date.now() + 2 * 864e5 })) // joined in the future
  assert.ok(!valid({ t: 'hello', name: 'Ann', since: Infinity }))
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

test('hostAfterHello: believe a host you can see, settle two hosts by election', () => {
  const seen = id => id === 'a' || id === 'b'
  const elect = () => 'a'
  assert.equal(hostAfterHello(null, 'b', seen, elect), 'b') // just joined
  assert.equal(hostAfterHello(null, 'zz', seen, elect), null) // names nobody here
  assert.equal(hostAfterHello(null, null, seen, elect), null)
  assert.equal(hostAfterHello('b', 'b', seen, elect), 'b')
  assert.equal(hostAfterHello('b', null, seen, elect), 'b')
  // after a blip both sides hosted: each one's hello names a different host, both re-elect the same one
  assert.equal(hostAfterHello('b', 'a', seen, elect), 'a')
  assert.equal(hostAfterHello('a', 'b', seen, elect), 'a')
})

test('loadKey: same episode and file means the same thing playing', () => {
  const l = { mediaId: 1, episode: 2, link: 'magnet:?xt=urn:btih:abc' }
  assert.equal(loadKey(l), loadKey({ ...l, title: 'other', numbering: {} }))
  assert.notEqual(loadKey(l), loadKey({ ...l, fileIndex: 3 }))
  assert.equal(loadKey(null), '')
})

test('saved rooms: a 4 to 8 digit PIN, and a room name in hello', () => {
  assert.ok(validPin('1234') && validPin('12345678'))
  assert.ok(!validPin('123') && !validPin('123456789') && !validPin('12a4') && !validPin(''))
  assert.ok(valid({ t: 'hello', name: 'Ann', since: 1, host: null, room: 'Friday anime' }))
  assert.ok(!valid({ t: 'hello', name: 'Ann', since: 1, room: 'x'.repeat(41) }))
  assert.ok(!valid({ t: 'hello', name: 'Ann', since: 1, room: 5 }))
})
