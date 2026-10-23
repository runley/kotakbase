import assert from 'node:assert/strict'
import test from 'node:test'
import { fromMal } from './ui/mal.js'

// shaped like GET api.myanimelist.net/v2/anime/52991?fields=MAL_FIELDS
const frieren = {
  id: 52991,
  title: 'Sousou no Frieren',
  main_picture: { medium: 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg', large: 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg' },
  alternative_titles: { synonyms: ['Frieren at the Funeral'], en: "Frieren: Beyond Journey's End", ja: '葬送のフリーレン' },
  start_date: '2023-09-29',
  synopsis: 'During their decade-long quest…',
  mean: 9.3,
  genres: [{ id: 2, name: 'Adventure' }, { id: 8, name: 'Drama' }, { id: 10, name: 'Fantasy' }, { id: 27, name: 'Shounen' }],
  media_type: 'tv',
  status: 'finished_airing',
  num_episodes: 28,
  start_season: { year: 2023, season: 'fall' },
  average_episode_duration: 1475,
  nsfw: 'white',
  rating: 'pg_13'
}

test('fromMal: a MyAnimeList show in the shape the app uses', () => {
  const m = fromMal(154587, frieren)
  assert.equal(m.id, 154587) // keyed by the AniList id, like everything else in the app
  assert.equal(m.idMal, 52991)
  assert.deepEqual(m.title, { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン', userPreferred: 'Sousou no Frieren' })
  assert.equal(m.coverImage.extraLarge, 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg')
  assert.deepEqual([m.format, m.status, m.season, m.seasonYear, m.episodes, m.duration, m.averageScore], ['TV', 'FINISHED', 'FALL', 2023, 28, 25, 93])
  assert.deepEqual(m.startDate, { year: 2023, month: 9, day: 29 })
  assert.deepEqual(m.synonyms, ['Frieren at the Funeral'])
  assert.equal(m.nextAiringEpisode, null)
  assert.equal(m.isAdult, false)
  assert.ok('synonyms' in m) // counts as full details
})

test('fromMal: an airing show counts its episodes out from ani.zip air dates; unknown counts and adult titles', () => {
  const zip = { episodes: { 1: { airDateUtc: '2026-10-01T15:00:00Z' }, 2: { airDateUtc: '2026-10-08T15:00:00Z' }, 3: { airDateUtc: '2026-10-15T15:00:00Z' }, S1: { airDateUtc: '2026-09-01T15:00:00Z' } } }
  const m = fromMal(1, { ...frieren, status: 'currently_airing', num_episodes: 0 }, zip, Date.parse('2026-10-10T00:00:00Z'))
  assert.equal(m.status, 'RELEASING')
  assert.equal(m.episodes, null) // MAL's 0 = not known yet
  assert.deepEqual(m.nextAiringEpisode, { episode: 3 }) // episodes 1 and 2 are out; the special S1 doesn't count
  assert.equal(fromMal(2, { ...frieren, rating: 'rx' }).isAdult, true)
  assert.equal(fromMal(3, { ...frieren, start_date: '2027' }).startDate.month, null) // only a year known
})

test('malAnime: at most 4 requests at once (an opened show goes straight away), all answered', async () => {
  const realFetch = globalThis.fetch
  let now = 0
  let most = 0
  globalThis.fetch = async url => {
    most = Math.max(most, ++now)
    await new Promise(resolve => setTimeout(resolve, 20))
    now--
    return new Response(JSON.stringify({ id: Number(url.match(/anime\/(\d+)/)[1]) }))
  }
  try {
    const { malAnime } = await import('./ui/mal.js')
    const background = Array.from({ length: 10 }, (_, i) => malAnime(i + 1, 'test-id'))
    const opened = malAnime(99, 'test-id', { urgent: true })
    const answers = await Promise.all([...background, opened])
    assert.deepEqual(answers.map(a => a.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99])
    assert.equal(most, 5) // 4 background slots + the opened show
  } finally { globalThis.fetch = realFetch }
})
