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
