import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { EbmlTagFactory, EbmlTagId } from 'ebml-stream'
import { readFonts } from './fonts.js'

const data = (id, value) => { const t = EbmlTagFactory.create(id); t.data = value; return t }
const master = (id, children) => { const t = EbmlTagFactory.create(id); t.Children = children; return t }
const idBytes = id => Buffer.from(id.toString(16), 'hex')

// EBML header + Segment [SeekHead, Cluster (video data), Attachments], the layout that left fonts unread.
function mkv (files) {
  const attachments = master(EbmlTagId.Attachments, files.map(([name, mime, bytes]) => master(EbmlTagId.AttachedFile, [
    data(EbmlTagId.FileName, name), data(EbmlTagId.FileMimeType, mime), data(EbmlTagId.FileData, bytes)
  ]))).encode()
  const cluster = master(EbmlTagId.Cluster, [data(EbmlTagId.Timecode, 0), data(EbmlTagId.Void, Buffer.alloc(300 * 1024))]).encode()
  const seekHead = pos => master(EbmlTagId.SeekHead, [master(EbmlTagId.Seek, [
    data(EbmlTagId.SeekID, idBytes(EbmlTagId.Attachments)), data(EbmlTagId.SeekPosition, pos)
  ])]).encode()
  let head = seekHead(0)
  head = seekHead(head.length + cluster.length) // its own length can change with the number it holds, so once more
  head = seekHead(head.length + cluster.length)
  const body = Buffer.concat([head, cluster, attachments])
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
