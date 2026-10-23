import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { chooseFiles, inside } from './downloads.js'

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
