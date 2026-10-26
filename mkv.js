import { EbmlTagId, Tools } from 'ebml-stream'

// Reading an MKV's index without playing it: the fonts embedded in it, wherever the muxer put them (many releases put
// the attachments after the video data, where reading subtitles from the start of the stream never gets to), and where
// the video really ends. Both jump straight there using the SeekHead (the file's index).
export const isFont = f => /font|ttf|otf|ttc/i.test(f.mimetype + f.filename)

function read (file, start, length) {
  return new Promise((resolve, reject) => {
    const parts = []
    file.createReadStream({ start, end: Math.min(start + length, file.length) - 1 })
      .on('data', d => parts.push(d)).on('end', () => resolve(Buffer.concat(parts))).on('error', reject)
  })
}

const hex = (buf, start, end) => parseInt(buf.toString('hex', start, end) || '0', 16)

// The element header at buf[i]: { id, size, data (where its content starts) }, or null if it runs past the buffer.
function header (buf, i) {
  const id = Tools.readVint(buf, i)
  const size = id && Tools.readVint(buf, i + id.length)
  if (!size) return null
  return { id: hex(buf, i, i + id.length), size: size.value, data: i + id.length + size.length }
}

function * children (buf, start, end) {
  for (let i = start; i < end;) {
    const h = header(buf, i)
    if (!h) return
    yield h
    if (h.size < 0) return // unknown size: nothing after it can be found this way
    i = h.data + h.size
  }
}

// Seek entries of a SeekHead's content -> [[elementId, position from the segment start]]
function seeks (buf, start, end) {
  const out = []
  for (const s of children(buf, start, end)) {
    if (s.id !== EbmlTagId.Seek) continue
    let id, pos
    for (const c of children(buf, s.data, s.data + s.size)) {
      if (c.id === EbmlTagId.SeekID) id = hex(buf, c.data, c.data + c.size)
      if (c.id === EbmlTagId.SeekPosition) pos = hex(buf, c.data, c.data + c.size)
    }
    if (id != null && pos != null) out.push([id, pos])
  }
  return out
}

// The element at position pos (from the segment start), whole: { buf, h } or null.
async function element (file, segment, pos, max) {
  const top = await read(file, segment + pos, 16)
  const h = header(top, 0)
  if (!h || h.size < 0 || h.size > max) return null
  return { buf: await read(file, segment + pos, h.data + h.size), h }
}

const uint = (buf, c) => hex(buf, c.data, c.data + c.size)

// The file's index: the head (the elements before the video data), the segment's header and every SeekHead entry;
// null when it isn't an MKV.
async function index (file) {
  const top = await read(file, 0, 256 * 1024)
  const ebml = header(top, 0)
  const segment = ebml && header(top, ebml.data + ebml.size)
  if (segment?.id !== EbmlTagId.Segment) return null
  const head = []
  let entries = []
  for (const c of children(top, segment.data, top.length)) {
    if (c.id === EbmlTagId.Cluster) break
    head.push(c)
    if (c.id === EbmlTagId.SeekHead) entries.push(...seeks(top, c.data, c.data + c.size))
  }
  // some muxers keep a second SeekHead at the end, pointed to by the first
  for (const [, pos] of entries.filter(([id]) => id === EbmlTagId.SeekHead)) {
    const more = await element(file, segment.data, pos, 1024 * 1024)
    if (more) entries = entries.concat(seeks(more.buf, more.h.data, more.buf.length))
  }
  return { top, head, segment: segment.data, entries }
}

// Where the video really ends, in seconds: the last entry of the Cues (the seek index the muxer writes from the video
// itself). Some releases state twice the real length in their header (Judas' Solo Leveling S2 v2: 47:16 for 23:38),
// and the player would trust that. null when there are no Cues or the file can't be read.
export async function readEnd (file) {
  try {
    const idx = await index(file)
    const at = idx?.entries.find(([id]) => id === EbmlTagId.Cues)
    const cues = at && await element(file, idx.segment, at[1], 16 * 1024 * 1024)
    if (!cues) return null
    const info = idx.head.find(c => c.id === EbmlTagId.Info)
    const scale = (info && [...children(idx.top, info.data, info.data + info.size)].find(c => c.id === EbmlTagId.TimecodeScale)) || null
    let last = null
    for (const p of children(cues.buf, cues.h.data, cues.buf.length)) {
      if (p.id !== EbmlTagId.CuePoint) continue
      for (const c of children(cues.buf, p.data, p.data + p.size)) if (c.id === EbmlTagId.CueTime) last = Math.max(last ?? 0, uint(cues.buf, c))
    }
    return last == null ? null : last * (scale ? uint(idx.top, scale) : 1e6) / 1e9
  } catch {
    return null
  }
}

// -> [{ filename, mimetype, data }] of the font attachments; [] when there are none or the file can't be read.
export async function readFonts (file) {
  try {
    const idx = await index(file)
    const at = idx?.entries.find(([id]) => id === EbmlTagId.Attachments)
    const attachments = at && await element(file, idx.segment, at[1], 256 * 1024 * 1024)
    if (!attachments) return []
    const { buf, h } = attachments
    const fonts = []
    for (const f of children(buf, h.data, buf.length)) {
      if (f.id !== EbmlTagId.AttachedFile) continue
      const file = { filename: '', mimetype: '', data: null }
      for (const c of children(buf, f.data, f.data + f.size)) {
        if (c.id === EbmlTagId.FileName) file.filename = buf.toString('utf8', c.data, c.data + c.size)
        if (c.id === EbmlTagId.FileMimeType) file.mimetype = buf.toString('latin1', c.data, c.data + c.size)
        if (c.id === EbmlTagId.FileData) file.data = buf.subarray(c.data, c.data + c.size)
      }
      if (file.data && isFont(file)) fonts.push(file)
    }
    return fonts
  } catch {
    return []
  }
}
