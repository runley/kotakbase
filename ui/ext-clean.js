// Extension output is untrusted: keep only well-formed results. Run in the worker and again on the page, since the
// extension's code shares the worker and can post its own replies past the worker's check.
const ACCURACY = ['high', 'medium', 'low']
const TYPES = ['batch', 'best', 'alt']
const num = v => typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : 0

export function clean (results) {
  if (!Array.isArray(results)) return []
  return results.filter(r => r && typeof r.hash === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(r.hash) && typeof r.link === 'string' && /^(magnet:|https:\/\/)/i.test(r.link)).map(r => ({
    hash: r.hash.toLowerCase(),
    link: r.link,
    title: typeof r.title === 'string' ? r.title : r.hash,
    seeders: num(r.seeders),
    leechers: num(r.leechers),
    downloads: num(r.downloads),
    size: num(r.size),
    date: r.date instanceof Date && !isNaN(r.date) ? r.date : new Date(0),
    accuracy: ACCURACY.includes(r.accuracy) ? r.accuracy : 'low',
    type: TYPES.includes(r.type) ? r.type : undefined
  }))
}

// Manga extensions (type "manga"): what search, chapters and pages may return
const text = v => typeof v === 'string' ? v.slice(0, 300) : ''
const id = v => (typeof v === 'string' || typeof v === 'number') && String(v) ? String(v).slice(0, 500) : null
const https = v => typeof v === 'string' && /^https:\/\//i.test(v) ? v : ''
const list = (v, f) => Array.isArray(v) ? v.map(f).filter(Boolean) : []

// [{ id, title, cover, anilistId }]: one series on the site
export const cleanSeries = results => list(results, r => r && id(r.id) && {
  id: id(r.id), title: text(r.title) || id(r.id), cover: https(r.cover), anilistId: Number.isInteger(r.anilistId) ? r.anilistId : null
})
// [{ id, number, title, group, lang, date, mirror }]: number may be 10.5, or null (a oneshot, an extra); mirror: re-uploaded
// from another group
export const cleanChapters = results => list(results, r => r && id(r.id) && {
  id: id(r.id),
  number: typeof r.number === 'number' && isFinite(r.number) && r.number >= 0 ? r.number : null,
  title: text(r.title),
  group: text(r.group),
  lang: text(r.lang).toLowerCase(),
  date: r.date instanceof Date && !isNaN(r.date) ? r.date : null,
  mirror: r.mirror === true
})
// the chapter's page images, in order
export const cleanPages = results => list(results, https)
