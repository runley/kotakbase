import { EbmlStreamDecoder, EbmlTagId } from 'ebml-stream'

// Chapter names releases use for the opening and the ending/credits.
const OP = /\b(op|opening|intro)\b/i
const ED = /\b(ed|ending|credits|outro)\b/i
export const chapterKind = title => OP.test(title) ? 'op' : ED.test(title) ? 'ed' : null

const child = (tag, id) => tag?.Children?.find(c => c.id === id)

// A buffered MKV Chapters tag -> [{ title, start, end, kind }] in seconds (first edition, hidden chapters dropped).
// A chapter without an end runs to the next one; the last one's end is null (= end of the file).
export function chaptersFrom (tag) {
  const atoms = (child(tag, EbmlTagId.EditionEntry)?.Children ?? []).filter(c => c.id === EbmlTagId.ChapterAtom)
  const list = atoms
    .filter(a => !child(a, EbmlTagId.ChapterFlagHidden)?.data)
    .map(a => {
      const title = String(child(child(a, EbmlTagId.ChapterDisplay), EbmlTagId.ChapString)?.data ?? '')
      const end = child(a, EbmlTagId.ChapterTimeEnd)?.data
      return { title, start: Number(child(a, EbmlTagId.ChapterTimeStart)?.data ?? 0) / 1e9, end: end == null ? null : Number(end) / 1e9, kind: chapterKind(title) }
    })
    .sort((a, b) => a.start - b.start)
  list.forEach((c, i) => { c.end ??= list[i + 1]?.start ?? null })
  return list
}

// Chapters from the start of an MKV stream. Muxers write them before the first Cluster (the video data), so
// reading stops there; [] when the file has none or can't be read.
export function readChapters (stream) {
  return new Promise(resolve => {
    const decoder = new EbmlStreamDecoder({ bufferTagIds: [EbmlTagId.Chapters] })
    let done = false
    const finish = list => {
      if (done) return
      done = true
      stream.destroy()
      resolve(list)
    }
    decoder.on('data', tag => {
      if (tag.id === EbmlTagId.Chapters) finish(chaptersFrom(tag))
      else if (tag.id === EbmlTagId.Cluster) finish([])
    })
    decoder.on('error', () => finish([]))
    stream.on('error', () => finish([]))
    stream.on('end', () => setImmediate(() => finish([]))) // let the decoder flush first
    stream.pipe(decoder)
  })
}
