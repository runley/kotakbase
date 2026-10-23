// MyAnimeList's official API (api.myanimelist.net/v2): the fallback for show details while AniList can't answer.
// Public data needs only the app's Client ID (X-MAL-CLIENT-ID); no user login. Without one, the fallback is off.

export const MAL_FIELDS = 'alternative_titles,main_picture,synopsis,mean,genres,media_type,status,num_episodes,start_date,start_season,average_episode_duration,nsfw,rating'
const FORMAT = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL', tv_special: 'SPECIAL', music: 'MUSIC' }
const STATUS = { finished_airing: 'FINISHED', currently_airing: 'RELEASING', not_yet_aired: 'NOT_YET_RELEASED' }

// A MyAnimeList anime (GET /v2/anime/{id}?fields=MAL_FIELDS) in the shape AniList gives the app (FIELDS), keyed by the
// AniList `id`. MyAnimeList has no "next airing episode", so for an airing show the episodes out are counted from
// ani.zip's air dates.
export function fromMal (id, d, zip = {}, now = Date.now()) {
  const [year, month, day] = (d.start_date ?? '').split('-').map(Number)
  const aired = Object.entries(zip.episodes ?? {}).filter(([k, e]) => /^\d+$/.test(k) && Date.parse(e.airDateUtc ?? e.airdate) <= now).length
  const status = STATUS[d.status] ?? null
  const alt = d.alternative_titles ?? {}
  return {
    id,
    idMal: d.id,
    title: { romaji: d.title, english: alt.en || null, native: alt.ja || null, userPreferred: d.title },
    synonyms: alt.synonyms ?? [],
    coverImage: { large: d.main_picture?.medium, extraLarge: d.main_picture?.large ?? d.main_picture?.medium, color: null },
    bannerImage: null,
    description: d.synopsis ?? '',
    episodes: d.num_episodes || null, // 0 = not known yet
    format: FORMAT[d.media_type] ?? null,
    status,
    season: d.start_season?.season?.toUpperCase() ?? null,
    seasonYear: d.start_season?.year ?? null,
    averageScore: d.mean ? Math.round(d.mean * 10) : null,
    genres: (d.genres ?? []).map(g => g.name),
    duration: d.average_episode_duration ? Math.round(d.average_episode_duration / 60) : null,
    nextAiringEpisode: status === 'RELEASING' && aired ? { episode: aired + 1 } : null,
    startDate: { year: year || null, month: month || null, day: day || null },
    tags: [],
    isAdult: d.nsfw === 'black' || d.rating === 'rx'
  }
}

// Up to 4 requests at once, no gap: measured well inside MyAnimeList's (unpublished) limit, which only kicked in after
// ~190 requests in 2 minutes, i.e. about three full first-launch home pages back to back. Past it, requests just hang.
const MAX_AT_ONCE = 4
let active = 0
const waiting = []
const takeSlot = () => active < MAX_AT_ONCE ? (active++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve))
const freeSlot = () => { const next = waiting.shift(); if (next) next(); else active-- } // the slot passes straight on
let downUntil = 0 // after MyAnimeList can't be reached, the next requests fail at once instead of each waiting it out
// One MyAnimeList anime by its id; gives up after 10 s, so an unreachable (or throttling) API can't leave a page
// hanging. `urgent` (a show being opened) goes at once instead of waiting for a slot behind background loads.
export async function malAnime (malId, clientId, { urgent = false } = {}) {
  if (!clientId) return Promise.reject(new Error('MyAnimeList fallback is off (no Client ID)'))
  const get = () => fetch(`https://api.myanimelist.net/v2/anime/${malId}?fields=${MAL_FIELDS}`, { headers: { 'X-MAL-CLIENT-ID': clientId }, signal: AbortSignal.timeout(10_000) })
    .catch(e => { downUntil = Date.now() + 2 * 60_000; throw e })
  const request = async () => {
    if (Date.now() < downUntil) throw new Error('MyAnimeList is unreachable')
    let res = await get()
    if (res.status === 429) { await new Promise(resolve => setTimeout(resolve, 1500)); res = await get() }
    if (!res.ok) throw new Error(`MyAnimeList returned ${res.status}`)
    return res.json()
  }
  if (urgent) return request()
  await takeSlot()
  try { return await request() } finally { freeSlot() }
}
