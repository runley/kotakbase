// "Recommended For You": k-nearest neighbours over AniList's genres and tags. Each show becomes a weighted list of
// its genres and tags (a tag weighs as much as AniList's rank says it fits, a common one less than a rare one); a
// candidate scores by how close it is to the k finished shows it's most like, each weighted by your score of it.
// Pure: app.js fetches the shows and draws the rows.

// how much a finished show counts: 100 → 3, unrated → 1, 40 → 0, 20 or less → against shows like it
export const taste = score => score ? (score - 40) / 20 : 1

const features = m => [
  ...(m.genres ?? []).map(g => ['g:' + g, 0.5]), // genres are broad: tags say more
  ...(m.tags ?? []).filter(x => !x.isMediaSpoiler).map(x => ['t:' + x.name, (x.rank ?? 60) / 100])
]

// show id → Map(feature → weight), unit length, with weights lowered for features most of these shows share
export function vectors (shows) {
  const df = new Map()
  for (const m of shows) for (const [k] of features(m)) df.set(k, (df.get(k) ?? 0) + 1)
  const out = new Map()
  for (const m of shows) {
    const v = new Map(features(m).map(([k, w]) => [k, w * Math.log(1 + shows.length / df.get(k))]))
    const len = Math.hypot(...v.values()) || 1
    for (const [k, w] of v) v.set(k, w / len)
    out.set(m.id, v)
  }
  return out
}

const cosine = (a, b) => { let s = 0; for (const [k, w] of a) s += w * (b.get(k) ?? 0); return s }

// Candidates you haven't started (and not in the same franchise as one you have), best first, each with the
// finished show it's most like (`because`). done: finished shows; scores: id → 1-100; seen: ids of every show started.
// recBy: id → how many of your shows AniList users recommend it for, a small boost.
export function rank (done, candidates, { scores = {}, seen = [], recBy = new Map(), k = 3 } = {}) {
  const skip = new Set(seen)
  // a sequel's sequel is still the same franchise: grow the skipped set through the candidates' relations
  for (let grew = true; grew;) {
    grew = false
    for (const c of candidates) if (!skip.has(c.id) && c.related?.some(id => skip.has(id))) { skip.add(c.id); grew = true }
  }
  const pool = [...new Map(candidates.filter(c => !skip.has(c.id)).map(c => [c.id, c])).values()]
  const vec = vectors([...done, ...pool])
  const out = []
  for (const c of pool) {
    const near = done.map(d => ({ d, sim: cosine(vec.get(c.id), vec.get(d.id)) })).sort((x, y) => y.sim - x.sim).slice(0, k)
    const score = near.reduce((s, n) => s + n.sim * taste(scores[n.d.id]), 0) / k + 0.02 * (recBy.get(c.id) ?? 0)
    const best = near.filter(n => taste(scores[n.d.id]) > 0).sort((x, y) => y.sim * taste(scores[y.d.id]) - x.sim * taste(scores[x.d.id]))[0]
    if (score > 0 && best) out.push({ m: c, score, because: best.d.id })
  }
  // one show per franchise: a candidate linked to a better-ranked one (86 and 86 Part 2) is left out
  const linked = new Set()
  return out.sort((x, y) => y.score - x.score).filter(({ m }) => {
    const dup = linked.has(m.id) || m.related?.some(id => linked.has(id))
    linked.add(m.id)
    m.related?.forEach(id => linked.add(id))
    return !dup
  })
}

// The main row: the best `per` near each finished show come first, then the rest, so one taste doesn't fill it
export function diverse (ranked, per = 2) {
  const count = new Map()
  const first = []
  const later = []
  for (const r of ranked) {
    const n = count.get(r.because) ?? 0
    count.set(r.because, n + 1)
    ;(n < per ? first : later).push(r)
  }
  return [...first, ...later]
}
