// Stats tab: the AniList query and the pure helpers that shape its answer and the watch history. No DOM here, so the
// tests can load it. AniList's stats scores are always 0-100, whatever score format the user picked.

const RANK = 'count meanScore minutesWatched'
export const STATS_QUERY = `query($userId: Int) {
  User(id: $userId) { name avatar { large } statistics { anime { count episodesWatched minutesWatched meanScore standardDeviation
    statuses { status minutesWatched }
    genres(sort: COUNT_DESC) { genre ${RANK} }
    tags(sort: COUNT_DESC, limit: 6) { tag { name } ${RANK} }
    studios(sort: COUNT_DESC, limit: 6) { studio { name } ${RANK} }
    voiceActors(sort: COUNT_DESC, limit: 6) { voiceActor { name { userPreferred } } ${RANK} }
    releaseYears { releaseYear ${RANK} mediaIds }
    startYears { startYear count }
  } } }
  MediaListCollection(userId: $userId, type: ANIME, status_not: PLANNING) { lists { entries {
    score(format: POINT_100) media { id averageScore popularity isAdult title { romaji english native userPreferred } coverImage { large color } }
  } } }
}`

// Shows rated by the user next to everyone's average. diff: the user's average distance from it (0-100 points);
// gems: shows rated 80+ that fewer than 50k people have; rows: the 3 most over- and 2 most under-rated, as shows
// with { you, avg, diff }.
export function crowd (lists) {
  const seen = new Map() // custom lists repeat entries
  for (const e of lists.flatMap(l => l.entries)) if (e.score && e.media?.averageScore && !e.media.isAdult) seen.set(e.media.id, e)
  const rated = [...seen.values()].map(e => ({ media: e.media, you: e.score, avg: e.media.averageScore, diff: e.score - e.media.averageScore }))
  if (!rated.length) return null
  const byDiff = rated.slice().sort((a, b) => b.diff - a.diff)
  const ups = byDiff.filter(r => r.diff > 0).slice(0, 3)
  const downs = byDiff.filter(r => r.diff < 0).slice(-2).reverse()
  return {
    diff: rated.reduce((s, r) => s + r.diff, 0) / rated.length,
    gems: rated.filter(r => r.you >= 80 && r.media.popularity < 50000).length,
    rows: [...ups, ...downs]
  }
}

// What the history (entries { id, episode, at }) says about when you watch: episodes per day for the last 26 weeks
// (oldest first, ending today, the first column starting on a Sunday), how many that is, the longest run of days in a
// row with an episode, the hour and weekday with the most, and the most episodes of one show in one day.
export function habits (history, now = Date.now()) {
  const dayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
  const perDay = new Map()
  const hours = Array(24).fill(0)
  const weekdays = Array(7).fill(0)
  const binges = new Map()
  for (const h of history) {
    const d = new Date(h.at)
    perDay.set(dayKey(h.at), (perDay.get(dayKey(h.at)) ?? 0) + 1)
    hours[d.getHours()]++
    weekdays[d.getDay()]++
    const k = dayKey(h.at) + '/' + h.id
    binges.set(k, (binges.get(k) ?? 0) + 1)
  }
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 25 * 7 - today.getDay())
  const days = []
  for (const d = start; d <= today; d.setDate(d.getDate() + 1)) days.push(perDay.get(dayKey(d)) ?? 0)
  const sorted = [...perDay.keys()].map(k => { const [y, m, d] = k.split('-'); return new Date(y, m, d).getTime() }).sort((a, b) => a - b)
  let streak = 0
  let run = 0
  sorted.forEach((t, i) => { run = i && Math.round((t - sorted[i - 1]) / 864e5) === 1 ? run + 1 : 1; streak = Math.max(streak, run) })
  const most = list => list.indexOf(Math.max(...list))
  let binge = null
  for (const [k, n] of binges) if (!binge || n > binge.n) binge = { id: Number(k.split('/')[1]), n }
  return { days, episodes: days.reduce((a, b) => a + b, 0), streak, hour: history.length ? most(hours) : null, weekday: history.length ? most(weekdays) : null, binge }
}

// Made-up stats in the shape STATS_QUERY returns, plus a watch history, for the blurred preview shown before signing in
const rank = (key, names, top) => names.map((n, i) => ({ [key]: n, count: Math.round(top * (1 - i * 0.13)), meanScore: 78 - i, minutesWatched: Math.round(top * 300 * (1 - i * 0.15)) }))
const cover = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="${color}"/></svg>`)}`
const show = (id, name, color, score, averageScore) => ({ score, media: { id, averageScore, popularity: 30000, title: { english: name, romaji: name }, coverImage: { large: cover(color) } } })
export const SAMPLE = {
  User: {
    name: 'You',
    avatar: { large: cover('#3b4a5c') },
    statistics: {
      anime: {
        count: 312, episodesWatched: 4120, minutesWatched: 98000, meanScore: 76.4, standardDeviation: 13.2,
        statuses: [{ status: 'PLANNING', minutesWatched: 21000 }],
        genres: rank('genre', ['Action', 'Fantasy', 'Comedy', 'Adventure', 'Drama', 'Romance', 'Slice of Life', 'Mystery'], 140),
        tags: rank('tag', ['Male Protagonist', 'Magic', 'School', 'Ensemble Cast', 'Tragedy', 'Isekai'].map(name => ({ name })), 120),
        studios: rank('studio', ['MAPPA', 'Madhouse', 'Kyoto Animation', 'Bones', 'Wit Studio', 'ufotable'].map(name => ({ name })), 20),
        voiceActors: rank('voiceActor', ['Kana Hanazawa', 'Yuuki Kaji', 'Saori Hayami', 'Jun Fukuyama', 'Rie Takahashi', 'Kenjirou Tsuda'].map(n => ({ name: { userPreferred: n } })), 30),
        releaseYears: Array.from({ length: 18 }, (_, i) => ({ releaseYear: 2008 + i, count: Math.round(3 + i * i / 6), meanScore: 72 + (i * 7 % 11), minutesWatched: Math.round((3 + i * i / 6) * 280), mediaIds: [i + 1] })),
        startYears: [{ startYear: 2023, count: 20 }, { startYear: 2024, count: 34 }, { startYear: 2025, count: 58 }]
      }
    }
  },
  MediaListCollection: {
    lists: [{
      entries: [show(16, 'Haibane Renmei', '#c9c3a8', 100, 79), show(17, 'Shiki', '#5c3b4a', 90, 74), show(18, 'Akudama Drive', '#8a3a1c', 90, 76),
        show(14, 'Darling in the Franxx', '#a83b5a', 50, 71), show(12, 'Sword Art Online', '#3b6ea8', 40, 70)]
    }]
  }
}
export const sampleHistory = (now = Date.now()) => Array.from({ length: 182 }, (_, d) => Array.from({ length: Math.max(0, Math.round((Math.sin(d * 1.7) + Math.sin(d * 0.31)) * 2.5)) }, (_, i) =>
  ({ id: 0, episode: i + 1, at: now - d * 864e5 - 3 * 36e5 + i * 6e4 }))).flat()
