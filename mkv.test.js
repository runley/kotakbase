import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { EbmlTagFactory, EbmlTagId } from 'ebml-stream'
import { readFonts, readEnd } from './mkv.js'

const data = (id, value) => { const t = EbmlTagFactory.create(id); t.data = value; return t }
const master = (id, children) => { const t = EbmlTagFactory.create(id); t.Children = children; return t }
const idBytes = id => Buffer.from(id.toString(16), 'hex')

// EBML header + Segment [SeekHead, Info, Cluster (video data), Attachments, Cues], the layout that left fonts unread.
// cueTimes: the Cues' entries (in timecode units; none: no Cues), scale: Info's TimecodeScale (none: no Info).
function mkv (files, { cueTimes, scale } = {}) {
  const attachments = master(EbmlTagId.Attachments, files.map(([name, mime, bytes]) => master(EbmlTagId.AttachedFile, [
    data(EbmlTagId.FileName, name), data(EbmlTagId.FileMimeType, mime), data(EbmlTagId.FileData, bytes)
  ]))).encode()
  const cues = cueTimes ? master(EbmlTagId.Cues, cueTimes.map(t => master(EbmlTagId.CuePoint, [data(EbmlTagId.CueTime, t)]))).encode() : Buffer.alloc(0)
  const info = scale ? master(EbmlTagId.Info, [data(EbmlTagId.TimecodeScale, scale)]).encode() : Buffer.alloc(0)
  const cluster = master(EbmlTagId.Cluster, [data(EbmlTagId.Timecode, 0), data(EbmlTagId.Void, Buffer.alloc(300 * 1024))]).encode()
  const seek = (id, pos) => master(EbmlTagId.Seek, [data(EbmlTagId.SeekID, idBytes(id)), data(EbmlTagId.SeekPosition, pos)])
  const seekHead = pos => master(EbmlTagId.SeekHead, [seek(EbmlTagId.Attachments, pos), ...(cueTimes ? [seek(EbmlTagId.Cues, pos + attachments.length)] : [])]).encode()
  let head = seekHead(0)
  head = seekHead(head.length + info.length + cluster.length) // its own length can change with the numbers it holds, so once more
  head = seekHead(head.length + info.length + cluster.length)
  const body = Buffer.concat([head, info, cluster, attachments, cues])
  const segment = Buffer.concat([Buffer.from('18538067', 'hex'), Buffer.from('01' + body.length.toString(16).padStart(14, '0'), 'hex'), body])
  const ebml = master(EbmlTagId.EBML, [data(EbmlTagId.DocType, 'matroska')]).encode()
  return Buffer.concat([ebml, segment])
}

const asFile = buf => ({ length: buf.length, createReadStream: ({ start, end }) => Readable.from([buf.subarray(start, end + 1)]) })

test('readFonts finds fonts stored after the video data, skipping other attachments', async () => {
  const ttf = Buffer.from('00010000aabbcc', 'hex')
  const fonts = await readFonts(asFile(mkv([['Dimbo Regular.ttf', 'font/ttf', ttf], ['cover.jpg', 'image/jpeg', Buffer.from('ffd8')], ['Rosario.otf', 'application/vnd.ms-opentype', Buffer.from('OTTO')]])))
  assert.deepEqual(fonts.map(f => f.filename), ['Dimbo Regular.ttf', 'Rosario.otf'])
  assert.deepEqual(Buffer.from(fonts[0].data), ttf)
})

test('readFonts: [] for files that are not MKV or have no attachments', async () => {
  assert.deepEqual(await readFonts(asFile(Buffer.from('not a video at all'))), [])
  assert.deepEqual(await readFonts(asFile(Buffer.alloc(0))), [])
})

test('readEnd: where the video really ends, from the Cues, whatever the header claims', async () => {
  assert.equal(await readEnd(asFile(mkv([], { cueTimes: [0, 500, 1417640], scale: 1000000 }))), 1417.64)
  assert.equal(await readEnd(asFile(mkv([], { cueTimes: [0, 2000] }))), 2) // no Info: the default scale, milliseconds
  assert.equal(await readEnd(asFile(mkv([], { cueTimes: [0, 1500], scale: 100000 }))), 0.15)
  assert.equal(await readEnd(asFile(mkv([]))), null) // no Cues
  assert.equal(await readEnd(asFile(Buffer.from('not a video at all'))), null)
})
