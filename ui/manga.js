// Manga reading: picking a manga extension's series for an AniList entry, and its chapter list. No DOM here, so the
// tests can load it.

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// AniList's names for an entry, as extensions search by them
export const titlesOf = m => [...new Set([m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])].filter(Boolean))]

// The series that is this entry: one naming its AniList id, else one whose title is one of AniList's (spelled
// loosely: case, spaces and punctuation don't count); null when nothing matches, rather than a guess
export function pickSeries (m, results) {
  const names = new Set(titlesOf(m).map(norm))
  return results.find(r => r.anilistId === m.id) ?? results.find(r => !r.anilistId && names.has(norm(r.title))) ?? null
}

// One row per chapter number, in reading order: the upload in the most preferred language (langs: 2-letter codes, best
// first; "pt-br" counts as "pt"), else the newest. Languages not in the list are dropped, unless none of the chapters
// is in one of them. Chapters without a number (extras, oneshots) each keep a row of their own, at the end.
export function chapterRows (chapters, langs) {
  const rank = c => { const i = langs.indexOf(c.lang.split('-')[0]); return i < 0 ? Infinity : i }
  const wanted = chapters.some(c => rank(c) < Infinity) ? chapters.filter(c => rank(c) < Infinity) : chapters
  const byNumber = new Map()
  for (const c of wanted) {
    const key = c.number ?? 'id:' + c.id
    const old = byNumber.get(key)
    if (!old || rank(c) < rank(old) || (rank(c) === rank(old) && (c.date ?? 0) > (old.date ?? 0))) byNumber.set(key, c)
  }
  return [...byNumber.values()].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
}
