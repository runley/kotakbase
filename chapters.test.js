import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { EbmlTagFactory, EbmlTagId } from 'ebml-stream'
import { chapterKind, readChapters } from './chapters.js'

// Build real MKV bytes: a Chapters element (one edition, the given atoms) followed by the start of a Cluster.
function mkv (atoms) {
  const data = (id, value) => { const t = EbmlTagFactory.create(id); t.data = value; return t }
  const master = (id, children) => { const t = EbmlTagFactory.create(id); t.Children = children; return t }
  const edition = master(EbmlTagId.EditionEntry, atoms.map(([title, startS, endS, hidden]) => master(EbmlTagId.ChapterAtom, [
    data(EbmlTagId.ChapterTimeStart, Math.round(startS * 1e9)),
    ...(endS != null ? [data(EbmlTagId.ChapterTimeEnd, Math.round(endS * 1e9))] : []),
    ...(hidden ? [data(EbmlTagId.ChapterFlagHidden, 1)] : []),
    master(EbmlTagId.ChapterDisplay, [data(EbmlTagId.ChapString, title)])
  ])))
  const cluster = master(EbmlTagId.Cluster, [data(EbmlTagId.Timecode, 0)])
  return Buffer.concat([master(EbmlTagId.Chapters, [edition]).encode(), cluster.encode()])
}

test('chapterKind', () => {
  assert.equal(chapterKind('Opening'), 'op')
  assert.equal(chapterKind('OP'), 'op')
  assert.equal(chapterKind('Intro'), 'op')
  assert.equal(chapterKind('Ending'), 'ed')
  assert.equal(chapterKind('ED'), 'ed')
  assert.equal(chapterKind('Credits'), 'ed')
  assert.equal(chapterKind('Part A'), null)
  assert.equal(chapterKind('Preview'), null)
  assert.equal(chapterKind('Edward arrives'), null)
})

test('readChapters from MKV bytes', async () => {
  const bytes = mkv([['Prologue', 0], ['Opening', 95.5], ['Part A', 185.5], ['Ending', 1300, 1390], ['Preview', 1390], ['Hidden', 5, null, true]])
  const list = await readChapters(Readable.from([bytes]))
  assert.deepEqual(list.map(c => [c.title, c.start, c.end, c.kind]), [
    ['Prologue', 0, 95.5, null],
    ['Opening', 95.5, 185.5, 'op'],
    ['Part A', 185.5, 1300, null],
    ['Ending', 1300, 1390, 'ed'],
    ['Preview', 1390, null, null]
  ])
})

test('readChapters stops at the video data when there are none', async () => {
  const cluster = EbmlTagFactory.create(EbmlTagId.Cluster)
  cluster.Children = []
  assert.deepEqual(await readChapters(Readable.from([cluster.encode(), Buffer.alloc(1000)])), [])
})
