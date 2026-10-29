import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { chooseFiles, inside, createDownloads } from './downloads.js'

const f = name => ({ name, length: 1 })
const pack = ['Show - 01 (1080p).mkv', 'Show - 02 (1080p).mkv', 'Show - 03 (1080p).mkv', 'NCOP.mkv', 'Show - 02 (1080p).ass', 'setup.txt'].map(f)

test('chooseFiles: a season pack gives each episode found, nothing else', () => {
  const got = chooseFiles(pack, { episodes: [1, 2, 3, 4].map(episode => ({ episode })) })
  assert.deepEqual(got.map(x => [x.file.name, x.episode]), [['Show - 01 (1080p).mkv', 1], ['Show - 02 (1080p).mkv', 2], ['Show - 03 (1080p).mkv', 3]])
})

test('chooseFiles: one episode, or one file asked for by index', () => {
  assert.deepEqual(chooseFiles(pack, { episodes: [{ episode: 2 }] }).map(x => x.file.name), ['Show - 02 (1080p).mkv'])
  assert.deepEqual(chooseFiles(pack, { fileIndex: 2, episodes: [{ episode: 3 }] }).map(x => [x.file.name, x.episode]), [['Show - 03 (1080p).mkv', 3]])
  assert.deepEqual(chooseFiles(pack, { fileIndex: 5, episodes: [{ episode: 1 }] }), []) // not a video
  assert.deepEqual(chooseFiles(pack, { fileIndex: 99, episodes: [{ episode: 1 }] }), [])
})

test('inside: only paths within the download folder', () => {
  const dir = path.resolve('downloads-here')
  assert.equal(inside(dir, 'Show/ep1.mkv'), path.join(dir, 'Show', 'ep1.mkv'))
  assert.equal(inside(dir, '../outside.mkv'), null)
  assert.equal(inside(dir, 'Show/../../outside.mkv'), null)
  assert.equal(inside(dir, path.resolve('/Windows/x.mkv')), null)
  assert.equal(inside('', 'Show/ep1.mkv'), null) // no folder set: nothing is touched
  assert.equal(inside('relative', 'Show/ep1.mkv'), null)
})

test('chooseFiles: one episode is only the file numbered so, or a lone unnumbered video', () => {
  assert.deepEqual(chooseFiles([f('Show - 05.mkv')], { episodes: [{ episode: 6 }] }), [])
  assert.deepEqual(chooseFiles(pack, { episodes: [{ episode: 7 }] }), [])
  assert.deepEqual(chooseFiles([f('Your Name (2016).mkv'), f('a.txt')], { episodes: [{ episode: 1 }] }).map(x => x.file.name), ['Your Name (2016).mkv'])
})

// A fake WebTorrent client: torrents get ready at once, with the files given
const fakeClient = (names, removed, made) => ({
  get: async () => null,
  add (link, { path: at }) {
    const t = new EventEmitter()
    Object.assign(t, { infoHash: link, magnetURI: link, path: at, numPeers: 0, downloadSpeed: 0, files: names.map(name => ({ name: path.basename(name), path: name, length: 1, downloaded: 0, done: false, select () {} })) })
    made.push(t)
    setImmediate(() => t.emit('ready'))
    return t
  },
  remove (t, opts, cb) { removed.push(opts); cb?.(); return Promise.resolve() }
})
const setup = names => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dl-'))
  const removed = []
  const made = []
  const d = createDownloads({ client: fakeClient(names, removed, made), store: path.join(dir, 'downloads.json'), defaultDir: dir, isPlaying: () => false, onChange () {} })
  return { dir, removed, made, d, put: name => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x') } }
}

test('a refused torrent leaves files already on disk alone', async () => {
  const { dir, removed, d, put } = setup(['Show/Show - 01.mkv', 'Show/setup.exe'])
  put('Show/Show - 01.mkv')
  await assert.rejects(d.add({ link: 'a', episodes: [{ episode: 1 }] }))
  assert.ok(removed.every(o => !o.destroyStore))
  assert.ok(fs.existsSync(path.join(dir, 'Show/Show - 01.mkv')))
})

test('a finished download deletes only the partial neighbours it wrote itself', async () => {
  const { dir, made, d, put } = setup(['Show/Show - 01.mkv', 'Show/Show - 02.mkv', 'Show/Show - 03.mkv'])
  put('Show/Show - 03.mkv') // the user's own, there before
  await d.add({ link: 'b', episodes: [{ episode: 1 }] })
  put('Show/Show - 01.mkv'); put('Show/Show - 02.mkv') // the episode, and a neighbour's edge piece
  const t = made.at(-1)
  t.files[0].done = true
  t.emit('done')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(fs.existsSync(path.join(dir, 'Show/Show - 01.mkv')))
  assert.ok(!fs.existsSync(path.join(dir, 'Show/Show - 02.mkv')))
  assert.ok(fs.existsSync(path.join(dir, 'Show/Show - 03.mkv')))
})

test('removing an entry keeps a file another entry also lists', async () => {
  const { dir, d, put } = setup(['Show/Show - 01.mkv'])
  await d.add({ link: 'c', episodes: [{ episode: 1 }] })
  await d.add({ link: 'd', episodes: [{ episode: 1 }] }) // a re-upload of the same batch
  put('Show/Show - 01.mkv')
  await d.remove('c')
  assert.ok(fs.existsSync(path.join(dir, 'Show/Show - 01.mkv')))
  await d.remove('d')
  assert.ok(!fs.existsSync(path.join(dir, 'Show/Show - 01.mkv')))
})
