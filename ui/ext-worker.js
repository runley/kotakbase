// Runs one extension's code, isolated from the page. Same contract as Hayase extensions:
// the module's default export has test(), single(), batch(), movie().
const ACCURACY = ['high', 'medium', 'low']
const TYPES = ['batch', 'best', 'alt']
const num = v => typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : 0
let mod

// extension output is untrusted: keep only well-formed results
function clean (results) {
  if (!Array.isArray(results)) return []
  return results.filter(r => r && typeof r.hash === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(r.hash) && typeof r.link === 'string' && r.link).map(r => ({
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

self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    let res
    if (fn === 'load') {
      const url = URL.createObjectURL(new Blob([args[0]], { type: 'text/javascript' }))
      mod = (await import(url)).default
      URL.revokeObjectURL(url)
    } else if (fn === 'test') {
      res = await mod.test()
    } else {
      const [query, options] = args
      res = clean(await mod[fn]({ ...query, fetch: self.fetch.bind(self) }, options))
    }
    self.postMessage({ id, res })
  } catch (e) {
    self.postMessage({ id, err: e?.message ?? String(e) })
  }
}
