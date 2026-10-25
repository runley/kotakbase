import * as ext from './extensions.js'
import * as player from './player.js'
import { parseRelease, releaseTags, audioLanguages, subLanguages, rankByLanguage, pickAuto, forThisEntry, otherEntryWords, unplayableAudio, entryNumbers } from './release.js'
import { LANGS, SIGNS } from './lang.js'
import { fromMal, malAnime } from './mal.js'
import { createSync } from './anilist-sync.js'
import { openRoom, parseCode, formatCode, inviteLink } from './room.js'

const $app = document.getElementById('app')
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
// parsed once, then kept in memory: progress() etc. are read per card, many times a render
// (callers that change a loaded object save it right after, so the copy here stays the saved one)
const stored = new Map()
const load = (key, def) => {
  if (!stored.has(key)) { try { stored.set(key, JSON.parse(localStorage.getItem(key))) } catch { stored.set(key, null) } }
  return stored.get(key) ?? def
}
let sync = null // AniList sync (anilist-sync.js): queues what changed, only while signed in
const save = (key, val) => {
  localStorage.setItem(key, JSON.stringify(val))
  stored.set(key, val)
  if (key === 'progress' || key === 'list' || key === 'ratings') sync?.changed()
}
const unstore = key => { localStorage.removeItem(key); stored.delete(key) }
// A brand-new install: every start saves the extension list (once extensions.js has booted them, after this runs),
// so a profile without one has never run Kotakbase. Updated installs always have it.
const firstLaunch = localStorage.getItem('extensions') === null

// ---- AniList ----
const FIELDS = `id idMal title { romaji english native userPreferred } synonyms coverImage { large extraLarge color } bannerImage
  description(asHtml: false) episodes format status season seasonYear averageScore genres duration
  nextAiringEpisode { episode } startDate { year month day } tags { name isMediaSpoiler }`
// Just what cards and the home hero show, for long lists (home rows, View More, search): a top-100 list with
// descriptions and tags is several times bigger. The show page and anything needing the rest fetch FIELDS (see full).
const LIST_FIELDS = `id title { romaji english native userPreferred } coverImage { large extraLarge color } bannerImage
  episodes format status season seasonYear averageScore genres nextAiringEpisode { episode } startDate { year month day }`
const full = m => !!m && 'synonyms' in m // fetched with FIELDS, not LIST_FIELDS

async function anilist (query, variables = {}, tries = 0) {
  const res = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  // AniList allows ~30-90 requests a minute; past that it says 429 and when to come back (a minute at most)
  if (res.status === 429 && tries < 2) {
    await new Promise(resolve => setTimeout(resolve, Math.min(60, Number(res.headers.get('Retry-After')) || 60) * 1000))
    return anilist(query, variables, tries + 1)
  }
  const json = await res.json()
  if (json.errors) throw new Error(json.errors[0].message)
  return json.data
}
const page = (args, vars, variables, { perPage = 30, pageNum = 1, fields = FIELDS } = {}) => anilist(`query${vars ? `(${vars})` : ''} { Page(page: ${pageNum}, perPage: ${perPage}) { media(type: ANIME, isAdult: false, ${args}) { ${fields} } } }`, variables).then(d => d.Page.media)
// The first `limit` results of a list query; AniList hands out at most 50 per request, so the top 100 takes two.
// Home lists: shown instantly from what was saved last time, and re-downloaded once per app start in the background
// (saved for the next visit), so they're fresh each launch and every later visit that day needs no download.
// Your own rows aren't cached here: they come from local data.
const listCache = new Map() // query → promise of the list, for this app start
function top (args, vars, variables, limit) {
  const key = 'list:' + JSON.stringify([args, variables, limit, LIST_FIELDS.length]) // LIST_FIELDS: a code change re-fetches
  if (listCache.has(key)) return listCache.get(key)
  const download = () => {
    const promise = fetchTop(args, vars, variables, limit)
    promise.then(list => {
      // drop lists unused for 30 days (e.g. last season's) or saved with other fields by an older version; storage full → memory only
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('list:') && k !== key && (JSON.parse(k.slice(5)).at(-1) !== LIST_FIELDS.length || !(Date.now() - load(k, null)?.at < 30 * 24 * 3600 * 1000))) unstore(k)
      }
      try { save(key, { at: Date.now(), list }) } catch {}
    }, () => {})
    return promise
  }
  const saved = load(key, null)
  if (saved) {
    listCache.set(key, Promise.resolve(remember(saved.list, saved.at)))
    download().then(list => listCache.set(key, Promise.resolve(list)), () => {}) // keep the saved one if it fails
  } else {
    const promise = download()
    listCache.set(key, promise)
    promise.catch(() => listCache.delete(key))
  }
  return listCache.get(key)
}
async function fetchTop (args, vars, variables, limit) {
  // AniList now and then answers a busy moment with an empty list; these lists are never really empty, so ask once more
  const get = async pageNum => {
    const opts = { perPage: Math.min(50, limit), pageNum, fields: LIST_FIELDS }
    const list = await page(args, vars, variables, opts)
    return list.length ? list : new Promise(resolve => setTimeout(() => resolve(page(args, vars, variables, opts)), 1000))
  }
  const pages = await Promise.all(Array.from({ length: Math.ceil(limit / 50) }, (_, i) => get(i + 1)))
  return remember(pages.flat().slice(0, limit))
}
const cache = new Map()
const cacheAt = new Map() // when each show's details were fetched
// a list's lighter copy never replaces full details already here
const remember = (list, at = Date.now()) => { list.forEach(m => { if (full(m) || !full(cache.get(m.id))) { cache.set(m.id, m); cacheAt.set(m.id, at) } }); return list }
const ROW_LIMIT = 20 // cards per home row; "View More" shows up to 100
const trending = (limit = ROW_LIMIT) => top('sort: TRENDING_DESC', '', undefined, limit)
const allTimePopular = (limit = ROW_LIMIT) => top('sort: POPULARITY_DESC', '', undefined, limit)
const seasonal = (limit = ROW_LIMIT) => {
  const d = new Date()
  const season = ['WINTER', 'WINTER', 'SPRING', 'SPRING', 'SPRING', 'SUMMER', 'SUMMER', 'SUMMER', 'FALL', 'FALL', 'FALL', 'WINTER'][d.getMonth()]
  const year = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear()
  return top('sort: POPULARITY_DESC, season: $s, seasonYear: $y', '$s: MediaSeason, $y: Int', { s: season, y: year }, limit)
}
// Saved details of every show you've watched, listed or have in History, so Continue Watching, Your List and History
// appear instantly and still work while AniList is down. Loaded at start; refreshed from AniList once per app start.
const SAVED = 'shows' // id -> [details, when fetched]
const launched = Date.now()
for (const [m, at] of Object.values(load(SAVED, {}))) remember([m], at)
let persistTimer
function persistShows () {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const keep = new Set([...Object.keys(progress()).map(Number), ...myList(), ...load('history', []).map(h => h.id)])
    const out = {}
    for (const id of keep) if (full(cache.get(id))) out[id] = [cache.get(id), cacheAt.get(id)]
    try { save(SAVED, out) } catch {} // storage full: they're still kept for this session
  }, 1000)
}
async function fetchIds (ids) {
  const chunks = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
  remember((await Promise.all(chunks.map(c => page('id_in: $ids', '$ids: [Int]', { ids: c }, { perPage: 50 })))).flat())
  persistShows()
}
// MyAnimeList's details (official API) when AniList can't answer; the MAL id comes from the saved copy or ani.zip.
// Remembered as fetched at time 0, so AniList is asked again as soon as it's back. Rows asking for the same show at
// once share one request (they go out one at a time). Off when no MyAnimeList Client ID was set up.
const malPending = new Map()
// urgent: a show being opened, asked for at once rather than behind the rows still loading in the background
function malFallback (id, urgent = false) {
  if (urgent) return malDetails(id, true)
  if (!malPending.has(id)) malPending.set(id, malDetails(id).finally(() => malPending.delete(id)))
  return malPending.get(id)
}
async function malDetails (id, urgent = false) {
  if (!window.native.malClientId) throw new Error('MyAnimeList fallback is off (no Client ID)')
  const zip = await aniZip(id)
  const mal = cache.get(id)?.idMal ?? zip.mappings?.mal_id
  if (!mal) throw new Error('No MyAnimeList id for this show')
  const m = fromMal(id, await malAnime(mal, window.native.malClientId, { urgent }), zip)
  if (m.isAdult) throw new Error('Adult title')
  remember([m], 0)
  persistShows()
  return m
}
const refreshing = new Set() // saved shows already being refreshed this app start
// onProgress(done, total): called as MyAnimeList fills in shows one by one (only when that fallback is used)
async function byIds (ids, onProgress) {
  if (!ids.length) return []
  // shows loaded this session or saved from an earlier one show straight away; only the others are asked for
  const missing = ids.filter(id => !full(cache.get(id)))
  if (missing.length) {
    try { await fetchIds(missing) } catch (e) {
      // AniList down: MyAnimeList, one show at a time (slower, but saved shows need nothing)
      let done = 0
      onProgress?.(0, missing.length)
      const got = await Promise.all(missing.map(id => malFallback(id).catch(() => null).finally(() => onProgress?.(++done, missing.length))))
      if (!got.some(Boolean) && missing.length === ids.length) throw e
    }
  }
  // copies saved by an earlier app start are refreshed in the background, once; a failure keeps the saved copy
  const stale = ids.filter(id => cacheAt.get(id) < launched && !refreshing.has(id))
  if (stale.length) { stale.forEach(id => refreshing.add(id)); fetchIds(stale).catch(() => stale.forEach(id => refreshing.delete(id))) }
  return ids.map(id => cache.get(id)).filter(Boolean)
}
// A show's page needs current details (episode count, next airing episode), so anything older than 5 minutes is
// fetched again; the cached copy is the fallback if that fails, and MyAnimeList if there's no copy at all.
async function media (id) {
  if (!full(cache.get(id)) || Date.now() - cacheAt.get(id) > 5 * 60 * 1000) {
    try { remember(await page('id: $id', '$id: Int', { id })); persistShows() } catch (e) {
      if (!full(cache.get(id))) await malFallback(id, true).catch(() => { throw e })
    }
  }
  return cache.get(id)
}

// Asked once per app start: the show page's Similar and Related tabs, and the Recommended row
const tabCache = new Map()
function once (key, fetch) {
  if (!tabCache.has(key)) {
    const promise = fetch()
    promise.catch(() => tabCache.delete(key))
    tabCache.set(key, promise)
  }
  return tabCache.get(key)
}
// AniList's user recommendations, best rated first
const similar = id => once('similar' + id, () =>
  anilist(`query($id: Int) { Media(id: $id) { recommendations(sort: RATING_DESC, perPage: 30) { nodes { mediaRecommendation { isAdult ${FIELDS} } } } } }`, { id })
    .then(d => remember(d.Media.recommendations.nodes.map(n => n.mediaRecommendation).filter(r => r && !r.isAdult))))
// The whole franchise, not just direct neighbours: follow seasons, side stories, spin-offs etc. outward one hop per
// request two hops at a time (crossovers via shared characters are left out), then list them in release order.
// "OTHER" links count too (Slime's first movie is only linked that way), except music videos, but aren't followed
// further, since they also link loosely related works.
const FRANCHISE = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'COMPILATION']
const related = id => once('related' + id, async () => {
  const seen = new Set([id])
  let next = [id]
  while (next.length && seen.size < 100) { // shortcut: stops at 100 entries, enough for any but the very longest franchises
    const edges = 'relations { edges { relationType node { id type format isAdult REST } } }'
    const d = await anilist(`query($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids) { ${edges.replace('REST', edges.replace(' REST', ''))} } } }`, { ids: next.slice(0, 50) })
    next = []
    const anime = e => e.node.type === 'ANIME' && !e.node.isAdult
    const inFranchise = e => anime(e) && FRANCHISE.includes(e.relationType)
    const loose = e => anime(e) && e.relationType === 'OTHER' && e.node.format !== 'MUSIC'
    for (const e of d.Page.media.flatMap(x => x.relations.edges)) {
      if (loose(e)) seen.add(e.node.id)
      if (!inFranchise(e)) continue
      seen.add(e.node.id) // its own relations came in the same answer
      for (const e2 of e.node.relations.edges) {
        if (seen.has(e2.node.id)) continue
        if (inFranchise(e2)) { seen.add(e2.node.id); next.push(e2.node.id) } else if (loose(e2)) seen.add(e2.node.id)
      }
    }
  }
  seen.delete(id)
  const date = m => (m.startDate.year ?? 9999) * 10000 + (m.startDate.month ?? 12) * 100 + (m.startDate.day ?? 31)
  return (await byIds([...seen])).sort((x, y) => date(x) - date(y))
})

const epCount = m => m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 1)
// episodes out so far: an airing show's planned total hasn't all aired yet
const airedCount = m => m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : epCount(m)
const title = m => m.title.english ?? m.title.userPreferred ?? m.title.romaji
const FORMAT = { TV: 'TV Series', TV_SHORT: 'TV Short', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special' }

// ---- local state: list + watch progress ----
const myList = () => load('list', [])
const progress = () => load('progress', {}) // id -> { episode, time, duration, at }
const ratings = () => load('ratings', {}) // id -> 1..5 stars
// Set progress by hand from an episode card: everything up to and including n watched, or n onwards unwatched
function markWatched (m, n) {
  const entry = n < epCount(m) ? { episode: n + 1, time: 0, duration: 1 } : { episode: n, time: 1, duration: 1, ...(m.status === 'FINISHED' && { finished: true }) }
  save('progress', { ...progress(), [m.id]: { ...entry, at: Date.now() } })
}
function markUnwatched (m, n) {
  sync?.unwatch(m.id) // the one change that also lowers AniList's progress
  const all = progress()
  if (n <= 1) delete all[m.id]
  else all[m.id] = { episode: n, time: 0, duration: 1, at: Date.now() }
  save('progress', all)
}
function toggleList (id) {
  const list = myList()
  save('list', list.includes(id) ? list.filter(x => x !== id) : [id, ...list])
}

// ---- views ----
// nope: a "Not interested" ✕ on the card (Recommended); an object, so .map(card) passing an index can't set it
// The cover: AniList's "large" (230px wide) unless the card is wider in screen pixels; sizes is --card-w in style.css
function card (m, { nope } = {}) {
  const p = progress()[m.id]
  return `<a class="card" href="#/anime/${m.id}">
    ${nope ? `<button class="card-x" data-nope="${m.id}" title="Not interested" aria-label="Not interested in ${esc(title(m))}">✕</button>` : ''}
    <img loading="lazy" src="${esc(m.coverImage.large)}" srcset="${esc(m.coverImage.large)} 230w, ${esc(m.coverImage.extraLarge)} 460w" sizes="clamp(140px, 7vw, 230px)" alt="">
    ${p ? `<div class="bar" style="width:${Math.min(100, (p.episode - 1 + p.time / (p.duration || 1)) / epCount(m) * 100)}%"></div>` : ''}
    <div class="t"><i style="background:${esc(m.coverImage.color ?? '#888')}"></i>${esc(title(m))}</div>
    <div class="m"><span>${esc(m.seasonYear ?? m.startDate?.year ?? '')}</span><span>${esc(FORMAT[m.format] ?? m.format ?? '')}</span></div>
  </a>`
}
// Rows of your own picks get "Surprise me" (opens a random one); Recommended cards get a "Not interested" ✕
const SURPRISE = ['list', 'recommended']
const surprise = kind => SURPRISE.includes(kind) ? `<button class="more surprise" data-surprise="${kind}">Surprise me</button>` : ''
// "Popular this season" leads with a lime tile, which also opens the full list, in place of the row's heading
const seasonName = () => ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Fall', 'Fall', 'Fall', 'Winter'][new Date().getMonth()]
const tile = () => `<a class="tile" href="#/more/season"><b>Popular this ${seasonName()}</b><span>The most-followed shows of the season</span><span class="tile-go">View all →</span></a>`
const row = (name, list, kind) => list.length ? `<section class="row">${kind === 'season' ? '' : `<div class="row-head"><h2>${esc(name)}</h2><span class="row-links">${surprise(kind)}<a class="more" href="#/more/${kind}">View More</a></span></div>`}<div class="cards">${kind === 'season' ? tile() : ''}${list.slice(0, ROW_LIMIT).map(m => card(m, { nope: kind === 'recommended' })).join('')}</div></section>` : ''

// "Your List" toggle: outlined bookmark, filled once saved
const listButton = (m, cls) => {
  const inList = myList().includes(m.id)
  return `<button class="${cls} list-btn ${inList ? 'on' : ''}" data-list="${m.id}" aria-pressed="${inList}" aria-label="Save to Your List" title="Save to Your List"><svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-6-4.5-6 4.5z"/></svg></button>`
}
const plain = s => (s ?? '').replace(/<[^>]*>/g, '')

// The home page's big box: where you left off, or (nothing started yet) the top trending show
function featureBox (m, p) {
  const ep = p ? Math.min(p.episode, epCount(m)) : 1
  const single = epCount(m) === 1 // a movie or one-off: no episode number
  const left = p && p.duration > 1 && p.time > 0 ? Math.max(1, Math.round((p.duration - p.time) / 60)) : 0
  const pct = p && p.duration > 1 ? Math.min(100, p.time / p.duration * 100) : 0
  const about = [m.seasonYear ?? m.startDate?.year, FORMAT[m.format] ?? m.format, ...(m.genres ?? []).slice(0, 3)].filter(Boolean).join(' · ')
  return `<img class="box-cover" src="${esc(m.coverImage.extraLarge)}" alt="">
    <div class="box-body">
      <span class="kicker">${p ? 'Continue watching' : 'Trending now'}</span>
      <h1><a href="#/anime/${m.id}">${esc(title(m))}</a></h1>
      <p class="muted">${p ? `${single ? 'Movie' : `Episode ${ep}`}${left ? ` · ${left} min left` : ''}` : esc(about)}</p>
      ${p ? `<div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}
      <div class="actions">
        <button class="btn" data-watch="${m.id}">${p ? (single ? 'Resume' : `Resume episode ${ep}`) : 'Watch now'}</button>
        <a class="btn ghost" href="#/anime/${m.id}">All episodes</a>
        ${listButton(m, 'sq')}
      </div>
    </div>`
}

// The home page's "Airing today" box: today's episodes of the shows you follow (the Schedule page's data)
function todayBox (items) {
  const end = new Date()
  end.setHours(24, 0, 0, 0)
  const list = items.filter(s => s.airingAt * 1000 < end).slice(0, 5)
  const time = at => new Date(at * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `<h2>Airing today</h2>
    ${list.map(s => `<a class="today" href="#/anime/${s.media.id}"><time>${time(s.airingAt)}</time><span><b>${esc(title(s.media))}</b><span class="muted">Episode ${s.episode}${s.airingAt * 1000 < Date.now() ? ' · out now' : ''}</span></span></a>`).join('') || '<p class="muted">None of your shows air today.</p>'}
    <a class="more" href="#/schedule">Full schedule →</a>`
}

async function home () {
  // each row is drawn as soon as it's in, so one slow AniList answer (Recommended takes two) holds up only its own row
  // your own rows say they're loading when they have shows to show, and count MyAnimeList's progress if AniList is down
  const loading = (k, done, total) => {
    const p = $app.querySelector(`[data-row="${k}"] [data-loading]`)
    if (p) p.textContent = `AniList isn't responding, so these come from MyAnimeList one show at a time: ${done} of ${total}…`
  }
  const cont = continueWatching((done, total) => loading(0, done, total))
  const rows = [
    ['Continue Watching', cont.then(l => l.slice(0, ROW_LIMIT)), 'continue'],
    ['Popular This Season', seasonal(), 'season'],
    ['Your List', byIds(myList().slice(0, ROW_LIMIT), (done, total) => loading(2, done, total)), 'list'],
    ['Recommended For You', recommended().catch(() => []), 'recommended'],
    ['Trending Now', trending(), 'trending'],
    ['All Time Popular', allTimePopular(), 'popular']
  ]
  const hasShows = [Object.values(progress()).some(p => !p.hidden), false, myList().length > 0]
  $app.innerHTML = `<section class="bento" aria-label="Overview"><div class="box box-feature"></div><div class="box box-today"><h2>Airing today</h2><p class="muted">Loading…</p></div></section>
    ${rows.map(([name], k) => `<div data-row="${k}">${hasShows[k] ? `<section class="row"><h2>${esc(name)}</h2><p class="muted" data-loading>Loading…</p></section>` : ''}</div>`).join('')}`
  const bento = $app.firstElementChild // this drawing of the page, to notice it was replaced meanwhile
  const filled = rows.map(([name, list, kind], k) => list.then(l => row(name, l, kind), e => `<section class="row"><h2>${esc(name)}</h2><p class="err">${esc(e.message)}</p></section>`)
    .then(html => { if (bento.isConnected) $app.querySelector(`[data-row="${k}"]`).outerHTML = html }))
  const feature = bento.querySelector('.box-feature')
  cont.catch(() => []).then(async l => {
    const m = l[0] ?? (await trending().catch(() => [])).find(x => x.bannerImage)
    if (!bento.isConnected) return
    if (m) feature.innerHTML = featureBox(m, l[0] ? progress()[m.id] : null)
    else feature.remove()
  })
  const today = bento.querySelector('.box-today')
  weekSchedule(false).then(items => { if (bento.isConnected) today.innerHTML = todayBox(items) },
    () => { if (bento.isConnected) today.innerHTML = '<h2>Airing today</h2><p class="muted">The schedule isn\'t available right now.</p><a class="more" href="#/schedule">Full schedule →</a>' })
  await Promise.all(filled) // the router restores the scroll position once the rows are there
}

const continueIds = () => Object.entries(progress()).sort((a, b) => b[1].at - a[1].at).map(([id]) => Number(id))
// a show is done once its final episode is 90% watched and it has finished airing (older entries carry no flag, so check)
const isFinished = m => { const p = progress()[m.id]; return !!p && (p.finished || (m.status === 'FINISHED' && p.episode >= epCount(m) && p.time >= p.duration * 0.9)) }
// hidden: removed from the row by the user; watching again saves a new entry without the flag, so it comes back
const inContinueWatching = m => { const p = progress()[m.id]; return !!p && !p.hidden && !isFinished(m) }
const continueWatching = async onProgress => (await byIds(continueIds(), onProgress)).filter(inContinueWatching)

// "Recommended For You": well-rated shows sharing the genres and tags that come up most among the shows you finished
// (started-but-unfinished ones don't count), weighted by your ratings, best match first; nothing you've already started
// or marked "Not interested".
async function recommended () {
  const done = (await byIds(continueIds())).filter(isFinished)
  if (!done.length) return []
  const genres = new Map()
  const tags = new Map()
  const bump = (map, k, w) => map.set(k, (map.get(k) ?? 0) + w)
  const rated = ratings()
  for (const m of done) {
    // your star rating weighs a show: 5★ counts three times, unrated once, 1★ counts against its genres and tags
    const w = rated[m.id] ? rated[m.id] - 2 : 1
    m.genres.forEach(g => bump(genres, g, w))
    m.tags.filter(t => !t.isMediaSpoiler).slice(0, 5).forEach(t => bump(tags, t.name, w)) // AniList lists a show's most fitting tags first
  }
  const most = (map, n) => [...map].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => k)
  // the top genres pick the candidates (tags are too narrow to search by); the tags then put the closest first
  const g = most(genres, 2)
  const seen = continueIds()
  const list = await once('recommended' + JSON.stringify([g, seen]), () =>
    page('sort: SCORE_DESC, genre_in: $g, id_not_in: $seen, popularity_greater: 20000', '$g: [String], $seen: [Int]', { g, seen }, { perPage: 50 }).then(remember))
  const nope = load('notInterested', [])
  const match = m => m.genres.reduce((s, x) => s + (genres.get(x) ?? 0), 0) + m.tags.reduce((s, x) => s + (tags.get(x.name) ?? 0), 0)
  return list.filter(m => !nope.includes(m.id)).sort((x, y) => match(y) - match(x))
}

// Shows you follow: in Continue Watching (not removed or finished) or Your List. Notifications and the schedule use these.
const followedIds = () => [...new Set([...continueIds().filter(id => !progress()[id].hidden && !progress()[id].finished), ...myList()])]

// New-episode notifications: on start and every 30 minutes, ask AniList (fresh, not the cache) how many episodes of
// your airing shows are out; a show that has more than last time gets a Windows notification. A show seen for the
// first time is only noted, so turning this on doesn't announce every show's back catalogue.
async function checkNewEpisodes () {
  if (!load('notify', true)) return
  const ids = followedIds()
  const shows = []
  for (let i = 0; i < ids.length; i += 50) shows.push(...await page('id_in: $ids, status: RELEASING', '$ids: [Int]', { ids: ids.slice(i, i + 50) }, { perPage: 50 }))
  remember(shows)
  const seen = load('airedSeen', {})
  const fresh = [] // [show, newest episode]
  for (const m of shows) {
    const n = airedCount(m)
    if (seen[m.id] != null && n > seen[m.id]) fresh.push([m, n])
    seen[m.id] = n
  }
  save('airedSeen', seen)
  // one notification however many came out, so they don't pile up on the desktop
  if (fresh.length === 1) {
    const [[m, n]] = fresh
    const note = new Notification(title(m), { body: `Episode ${n} is out`, icon: m.coverImage.extraLarge })
    note.onclick = () => { window.native.focus(); location.hash = `#/anime/${m.id}` }
  } else if (fresh.length) {
    const note = new Notification('New episodes', { body: newEpisodesText(fresh.map(([m]) => title(m))), icon: fresh[0][0].coverImage.extraLarge })
    note.onclick = () => { window.native.focus(); location.hash = '#/' } // Continue Watching / Your List are at the top
  }
}
// "A and B", "A, B and C", "A, B and 3 more"
function newEpisodesText (names) {
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}
setTimeout(() => { checkNewEpisodes().catch(() => {}); setInterval(() => checkNewEpisodes().catch(() => {}), 30 * 60 * 1000) }, 15000)
window.native.closeToTray(load('closeToTray', true)) // Settings → Closing the window
// the first time the window is closed, say where it went (it only hides to the tray)
window.native.on('hidden', () => {
  if (load('trayHint', false)) return
  save('trayHint', true)
  new Notification('Kotakbase is still running', { body: 'It\'s in the tray by the clock, still checking for new episodes. Right-click its icon to quit.' })
})

// The next 7 days of episodes from the start of today, for the shows you follow or (all) everything airing; asked once
// per app start and day (the Schedule page and the home page's "Airing today" box share it)
function weekSchedule (all) {
  const ids = followedIds()
  if (!all && !ids.length) return Promise.resolve([])
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = today / 1000
  return once(`schedule${all}${from}${ids}`, async () => {
    const out = []
    for (let p = 1; p <= 6; p++) { // shortcut: at most 300 episodes, more than any real week
      const d = await anilist(`query($p: Int, $from: Int, $to: Int${all ? '' : ', $ids: [Int]'}) { Page(page: $p, perPage: 50) { pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME${all ? '' : ', mediaId_in: $ids'}) { episode airingAt media { isAdult ${FIELDS} } } } }`, { p, from, to: from + 7 * 86400, ...(!all && { ids }) })
      out.push(...d.Page.airingSchedules.filter(s => !s.media.isAdult))
      if (!d.Page.pageInfo.hasNextPage) break
    }
    remember(out.map(s => s.media))
    return out
  })
}

// Airing schedule: the next 7 days of episodes, for the shows you follow or for everything airing
async function schedulePage () {
  const all = !!history.state?.scheduleAll
  const ids = followedIds()
  const tabs = `<div class="tabbar"><button class="${all ? '' : 'on'}" data-all="">Following</button><button class="${all ? 'on' : ''}" data-all="1">All airing</button></div>`
  $app.innerHTML = `<div class="page hist-page"><h2>Schedule</h2>${tabs}<p class="muted">Loading…</p></div>`
  $app.onclick = e => { const b = e.target.closest('[data-all]'); if (b) { history.replaceState({ ...history.state, scheduleAll: !!b.dataset.all }, ''); schedulePage() } }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const items = await weekSchedule(all)
  if (location.hash !== '#/schedule' || !!history.state?.scheduleAll !== all) return // moved on meanwhile
  const day = at => { const d = Math.round((new Date(at * 1000).setHours(0, 0, 0, 0) - today) / 864e5); return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : new Date(at * 1000).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) }
  const until = at => { const s = at - Date.now() / 1000; return s <= 0 ? 'Aired' : s < 3600 ? `in ${Math.ceil(s / 60)}m` : s < 86400 ? `in ${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : '' }
  let html = ''
  let current = ''
  for (const s of items) {
    if (day(s.airingAt) !== current) { current = day(s.airingAt); html += `<h3 class="hist-day">${esc(current)}</h3>` }
    html += `<a class="hist" href="#/anime/${s.media.id}">
      <img src="${esc(s.media.coverImage.large)}" alt="" loading="lazy">
      <span class="hist-main"><b>${esc(title(s.media))}</b><span class="muted">Episode ${s.episode}${s.media.episodes ? ` of ${s.media.episodes}` : ''}</span></span>
      <time>${new Date(s.airingAt * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}<br><span class="muted">${until(s.airingAt)}</span></time>
    </a>`
  }
  const empty = all ? 'Nothing airing this week.' : ids.length ? 'None of your shows air in the next 7 days.' : 'Shows in Continue Watching or Your List that are airing show up here.'
  $app.querySelector('.page').innerHTML = `<h2>Schedule</h2>${tabs}${html || `<p class="muted">${empty}</p>`}`
}

// History page: every watched episode, newest first, grouped by day
async function historyPage () {
  const history = load('history', []).slice().reverse()
  $app.innerHTML = '<div class="page"><h2>History</h2><p class="muted">Loading…</p></div>'
  const shows = new Map((await byIds([...new Set(history.map(h => h.id))])).map(m => [m.id, m]))
  const day = at => new Date(at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  let html = ''
  let current = ''
  for (const h of history) {
    const m = shows.get(h.id)
    if (!m) continue
    if (day(h.at) !== current) { current = day(h.at); html += `<h3 class="hist-day">${esc(current)}</h3>` }
    html += `<a class="hist" href="#/anime/${m.id}">
      <img src="${esc(m.coverImage.large)}" alt="" loading="lazy">
      <span class="hist-main"><b>${esc(title(m))}</b><span class="muted">Episode ${h.episode}${h.finished ? ' <span class="badge">Finished</span>' : ''}</span></span>
      <time>${new Date(h.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
    </a>`
  }
  $app.innerHTML = `<div class="page hist-page"><h2>History</h2>${html || '<p class="muted">Episodes you watch show up here.</p>'}</div>`
}

// "View More": a home row in full. AniList rows show their top 100; your own rows (progress, list) show everything.
const MORE = {
  continue: ['Continue Watching', continueWatching],
  hidden: ['Removed from Continue Watching', async () => (await byIds(continueIds())).filter(m => progress()[m.id].hidden && !isFinished(m))],
  list: ['Your List', () => byIds(myList())],
  recommended: ['Recommended For You', recommended],
  season: ['Popular This Season', () => seasonal(100)],
  trending: ['Trending Now', () => trending(100)],
  popular: ['All Time Popular', () => allTimePopular(100)]
}
async function morePage (kind) {
  const [name, load] = MORE[kind] ?? MORE.trending
  $app.innerHTML = `<div class="page"><h2>${esc(name)}</h2><p class="muted">Loading…</p></div>`
  const list = await load()
  // shows taken out of Continue Watching can be found (and opened, then put back) from there
  const hiddenLink = kind === 'continue' && Object.values(progress()).some(p => p.hidden) ? '<a class="more" href="#/more/hidden">Removed shows</a>' : ''
  const help = kind === 'hidden' ? '<p class="muted">Open a show and press ↺ to put it back. Watching it again also brings it back.</p>' : ''
  $app.innerHTML = `<div class="page"><div class="row-head"><h2>${esc(name)}</h2><span class="row-links">${hiddenLink}${list.length ? surprise(kind) : ''}</span></div>${help}<div class="grid">${list.map(m => card(m, { nope: kind === 'recommended' })).join('') || '<p class="muted">Nothing here yet.</p>'}</div></div>`
}

// Search page filters: [key, label, AniList argument, its GraphQL type, options as [value, label]]
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller']
const thisYear = new Date().getFullYear()
const FILTERS = [
  ['genre', 'Genre', 'genre', 'String', GENRES.map(g => [g, g])],
  ['year', 'Year', 'startDate_like', 'String', Array.from({ length: thisYear + 2 - 1960 }, (_, i) => String(thisYear + 1 - i)).map(y => [y + '%', y])],
  ['season', 'Season', 'season', 'MediaSeason', [['WINTER', 'Winter'], ['SPRING', 'Spring'], ['SUMMER', 'Summer'], ['FALL', 'Fall']]],
  ['format', 'Format', 'format', 'MediaFormat', Object.entries(FORMAT)],
  ['status', 'Status', 'status', 'MediaStatus', [['RELEASING', 'Airing'], ['FINISHED', 'Finished'], ['NOT_YET_RELEASED', 'Not yet aired']]],
  ['sort', 'Sort', null, null, [['POPULARITY_DESC', 'Popularity'], ['SCORE_DESC', 'Score'], ['TRENDING_DESC', 'Trending'], ['START_DATE_DESC', 'Newest'], ['TITLE_ROMAJI', 'Title']]]
]
async function search () {
  // what was searched is kept in this page's history entry, so Back from a show returns to the same results
  const state = { q: '', ...history.state?.search }
  $app.innerHTML = `<div class="page"><input class="search-input" placeholder="Search anime…" autofocus aria-label="Search anime" value="${esc(state.q)}">
    <div class="filters">${FILTERS.map(([key, label, , , options]) => `<label><span>${label}</span><select data-filter="${key}"><option value="">${key === 'sort' ? 'Best match' : 'Any'}</option>${options.map(([v, l]) => `<option value="${esc(v)}" ${state[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')}
      ${state.tag ? `<button class="chip tag-filter" data-clear-tag aria-label="Remove tag filter ${esc(state.tag)}">Tag: ${esc(state.tag)} ✕</button>` : ''}</div>
    <div class="grid"></div></div>`
  const input = $app.querySelector('input')
  const grid = $app.querySelector('.grid')
  let t
  let runId = 0
  const run = async () => {
    const id = ++runId
    history.replaceState({ ...history.state, search: state }, '')
    const args = []
    const vars = []
    const variables = {}
    if (state.q) { args.push('search: $q'); vars.push('$q: String'); variables.q = state.q }
    for (const [key, , arg, type] of [...FILTERS, ['tag', , 'tag', 'String']]) if (arg && state[key]) { args.push(`${arg}: $${key}`); vars.push(`$${key}: ${type}`); variables[key] = state[key] }
    const filtered = args.length > (state.q ? 1 : 0)
    // nothing typed or picked: trending, as before; with only filters, the most popular match first
    const list = !args.length && !state.sort ? await trending() : await page([`sort: ${state.sort || (state.q ? 'SEARCH_MATCH' : 'POPULARITY_DESC')}`, ...args].join(', '), vars.join(', '), variables, { perPage: 50, fields: LIST_FIELDS }).then(remember)
    if (id !== runId) return // a newer search finished first
    grid.innerHTML = list.map(card).join('') || `<p class="muted">Nothing found${filtered ? ' with these filters' : ''}.</p>`
  }
  input.oninput = () => { state.q = input.value.trim(); clearTimeout(t); t = setTimeout(run, 350) }
  $app.onchange = e => { const k = e.target.dataset.filter; if (k) { state[k] = e.target.value; run() } }
  $app.onclick = e => { const b = e.target.closest('[data-clear-tag]'); if (b) { delete state.tag; b.remove(); run() } }
  run()
}

const ago = date => {
  const days = (new Date(date) - Date.now()) / 864e5
  if (!isFinite(days)) return ''
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const a = Math.abs(days)
  return a >= 365 ? rtf.format(Math.round(days / 365), 'year') : a >= 30 ? rtf.format(Math.round(days / 30), 'month') : rtf.format(Math.round(days), 'day')
}

// Your 1-5 star rating of a show (feeds Recommended); shown once you've started it, and asked for once you finish it
function ratingStars (m) {
  const r = ratings()[m.id] ?? 0
  const label = r ? 'Your rating' : isFinished(m) ? 'Finished! How was it?' : 'Rate it'
  return `<div class="stars" role="group" aria-label="Your rating"><span class="muted">${label}</span>${[1, 2, 3, 4, 5].map(n =>
    `<button class="${n <= r ? 'on' : ''}" data-rate="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="${n === r}" title="${n === r ? 'Clear rating' : n + ' / 5'}">★</button>`).join('')}</div>`
}

// Episode cards (thumbnail, runtime, rating, title, progress, summary, air date), used on the show page and in the
// player's episode list; `highlight` is the episode outlined as current.
function episodeCards (m, zip, highlight) {
  const p = progress()[m.id]
  const watched = p?.episode ?? 1
  const fill = n => n < watched ? 100 : n === watched && p ? p.time / (p.duration || 1) * 100 : 0
  const movie = m.format === 'MOVIE' && epCount(m) === 1 // one big card with the wide, sharper banner art
  return Array.from({ length: epCount(m) }, (_, k) => k + 1).map(n => {
    const e = zip.episodes?.[n] ?? {}
    const name = e.title?.en ?? e.title?.['x-jat'] ?? `Episode ${n}`
    const len = e.runtime ?? e.length ?? m.duration
    return `<button class="epc ${n === highlight ? 'current' : ''} ${movie ? 'movie' : ''}" data-ep="${n}">
        <div class="thumb" style="background-image:url('${esc((movie && m.bannerImage) || e.image || m.coverImage.extraLarge)}')">
          ${len ? `<span class="len">${esc(len)}m</span>` : ''}${e.rating ? `<span class="rate">${esc(e.rating)}</span>` : ''}
        </div>
        <div class="body">
          <b>${n}. ${esc(name)}</b>${dlButton(m, n)}
          <div class="prog"><i style="width:${fill(n)}%"></i></div>
          <p>${esc(e.overview ?? e.summary ?? (movie ? (m.description ?? '').replace(/<[^>]+>/g, '') : ''))}</p>
          <small>${esc(ago(e.airDateUtc ?? e.airdate))}</small>
        </div>
      </button>`
  }).join('')
}

async function detail (id) {
  const [m, zip] = await Promise.all([media(id), aniZip(id)])
  const p = progress()[id]
  const current = p?.episode ?? 1
  const total = epCount(m)
  const status = m.status === 'RELEASING' ? 'Releasing' : (m.status ?? '').toLowerCase().replace(/^./, c => c.toUpperCase())
  $app.innerHTML = `<div class="show-banner" style="background-image:url('${esc(m.bannerImage ?? m.coverImage.extraLarge)}')"></div>
  <div class="show">
    <div class="show-head">
      <img src="${esc(m.coverImage.extraLarge)}" alt="">
      <div>
        <div class="show-native">${esc(m.title.native)}</div>
        <h1>${esc(title(m))}</h1>
        <div class="tags">
          <span class="pill">${p ? `${Math.min(current, total)} / ` : ''}${total} Episodes</span>
          <span class="pill">${esc(FORMAT[m.format] ?? m.format)}</span>
          <span class="pill">${esc(status)}</span>
          ${m.season ? `<span class="pill">${esc(m.season[0] + m.season.slice(1).toLowerCase())} ${m.seasonYear}</span>` : ''}
          ${m.averageScore ? `<span class="pill score">${m.averageScore}%</span>` : ''}
        </div>
        <p class="show-desc">${esc(plain(m.description))}</p>
      </div>
    </div>
    <div class="show-actions">
      <button class="btn" data-ep="${current}">▶ ${p ? `Continue · Ep ${current}` : 'Watch'}</button>
      ${listButton(m, 'sq')}
      ${inContinueWatching(m) ? '<button class="sq" data-hide-continue title="Remove from Continue Watching" aria-label="Remove from Continue Watching"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' : ''}
      ${!isFinished(m) && m.status !== 'NOT_YET_RELEASED' && !(p?.episode > airedCount(m)) ? `<button class="sq" data-watched-all title="Already watched: mark every episode watched" aria-label="Already watched"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>` : ''}
      ${p?.hidden && !isFinished(m) ? '<button class="sq" data-unhide title="Put back in Continue Watching" aria-label="Put back in Continue Watching"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg></button>' : ''}
      <button class="sq" data-download-season title="Download episodes to watch offline" aria-label="Download episodes">${DL_ICON}</button>
      ${p ? ratingStars(m) : ''}
    </div>
    <div class="chips">
      ${m.genres.map(g => `<button class="chip genre" data-genre="${esc(g)}" title="Search ${esc(g)} anime">${esc(g)}</button>`).join('')}
      ${m.tags.filter(t => !t.isMediaSpoiler).map(t => `<button class="chip" data-tag="${esc(t.name)}" title="Search anime tagged ${esc(t.name)}">${esc(t.name)}</button>`).join('')}
    </div>
    <div class="tabbar"><button class="on" data-tab="eps">Episodes</button><button data-tab="related">Related</button><button data-tab="similar">Similar</button></div>
    <div class="eps">${episodeCards(m, zip, current)}</div>
    <div class="grid" data-panel="related" hidden></div>
    <div class="grid" data-panel="similar" hidden></div>
  </div>`
  sharpen($app.querySelector('.show-banner'), m.id)
  // the open tab is kept in this page's history entry, so coming back to the page reopens it
  const showTab = tab => {
    history.replaceState({ ...history.state, tab }, '')
    $app.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('on', t.dataset.tab === tab))
    $app.querySelector('.eps').hidden = tab !== 'eps'
    $app.querySelectorAll('[data-panel]').forEach(g => { g.hidden = g.dataset.panel !== tab })
    const grid = $app.querySelector(`[data-panel="${tab}"]`)
    if (grid && !grid.dataset.loaded) {
      grid.dataset.loaded = 1
      grid.innerHTML = '<p class="muted">Loading…</p>'
      ;({ similar, related })[tab](m.id).then(list => { grid.innerHTML = list.map(card).join('') || `<p class="muted">No ${tab} anime found.</p>` },
        err => { delete grid.dataset.loaded; grid.innerHTML = `<p class="err">${esc(err.message)}</p>` })
    }
  }
  if (history.state?.tab) showTab(history.state.tab)
  $app.onclick = e => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab
    if (tab) return showTab(tab)
    const chip = e.target.closest('[data-genre], [data-tag]')
    if (chip) {
      // a new history entry with the filter preset, so Back returns to this show where it was scrolled
      history.replaceState({ ...history.state, scroll: $app.scrollTop }, '')
      history.pushState({ search: { q: '', ...chip.dataset } }, '', '#/search')
      return route()
    }
    if (e.target.closest('[data-hide-continue]')) {
      save('progress', { ...progress(), [m.id]: { ...progress()[m.id], hidden: true } })
      return route()
    }
    // seen elsewhere: counts as finished, so it leaves Continue Watching and Recommended and feeds Recommended instead;
    // an airing show is only caught up to what's out, and waits in Continue Watching for the next episode
    if (e.target.closest('[data-watched-all]')) {
      markWatched(m, airedCount(m))
      return route()
    }
    if (e.target.closest('[data-unhide]')) {
      const { hidden, ...entry } = progress()[m.id]
      save('progress', { ...progress(), [m.id]: entry })
      return route()
    }
    const rate = e.target.closest('[data-rate]')
    if (rate) {
      const n = +rate.dataset.rate
      const { [m.id]: old, ...rest } = ratings()
      save('ratings', old === n ? rest : { ...rest, [m.id]: n }) // clicking your current rating clears it
      return rate.closest('.stars').replaceWith(document.createRange().createContextualFragment(ratingStars(m)))
    }
    if (e.target.closest('[data-download-season]')) return sources(m, Math.min(current, epCount(m)), { download: 'season' })
    const dl = e.target.closest('[data-dl-ep]')
    if (dl) return sources(m, +dl.dataset.dlEp, { download: 'episode' })
    const b = e.target.closest('[data-ep]')
    if (b) sources(m, +b.dataset.ep)
  }
  // right-click an episode: mark it (and everything before it) watched, or it (and everything after it) unwatched
  $app.oncontextmenu = e => {
    const b = e.target.closest('.eps [data-ep]')
    if (!b) return
    e.preventDefault()
    const n = +b.dataset.ep
    contextMenu(e, [
      [`Mark watched up to episode ${n}`, () => markWatched(m, n)],
      [`Mark unwatched from episode ${n}`, () => markUnwatched(m, n)]
    ], route)
  }
}

// A small right-click menu of [label, action] items; `after` runs once an item was picked
function contextMenu (e, items, after) {
  document.querySelector('.app-cm')?.remove()
  const menu = document.createElement('div')
  menu.className = 'cm app-cm'
  menu.innerHTML = items.map(([label], i) => `<button data-i="${i}">${esc(label)}</button>`).join('')
  document.body.append(menu)
  menu.style.width = 'auto'
  menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 8) + 'px'
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 8) + 'px'
  const close = () => { menu.remove(); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', onKey, true); $app.removeEventListener('scroll', close) }
  const outside = ev => { if (!menu.contains(ev.target)) close() }
  const onKey = ev => { if (ev.key === 'Escape') close() }
  addEventListener('pointerdown', outside, true)
  addEventListener('keydown', onKey, true)
  $app.addEventListener('scroll', close)
  menu.onclick = ev => {
    const i = ev.target.closest('[data-i]')?.dataset.i
    if (i == null) return
    close()
    items[i][1]()
    after?.()
  }
  menu.querySelector('button').focus()
}

async function extensionsPage () {
  await ext.ready.catch(() => {})
  const list = Object.values(ext.configs)
  $app.innerHTML = `<div class="page">
    <h2>Extensions</h2>
    <p class="muted">Paste a Hayase extension manifest URL (https://…/index.json, gh:user/repo or npm:package).</p>
    <form class="add"><input placeholder="Manifest URL" aria-label="Manifest URL" required><button class="btn">Add</button></form>
    <div class="err" id="ext-err"></div>
    ${list.length ? '' : '<p class="muted">No extensions installed.</p>'}
    ${list.map(c => {
      const s = ext.settings[c.id]
      return `<div class="ext">
        <img src="${esc(c.icon)}" alt="">
        <div class="grow">
          <b>${esc(c.name)}</b> <span class="muted">v${esc(c.version)} · ${esc(c.type)} · ${esc(c.media ?? '')} · ${esc(c.accuracy)} accuracy</span>${c.deprecated ? '<span class="badge">Deprecated</span>' : ''}
          <div class="muted">${esc(c.description ?? '')}</div>
          ${c.type !== 'torrent' ? '<div class="muted">Only torrent extensions are used by Kotakbase.</div>' : ''}
          ${Object.entries(c.options ?? {}).map(([k, o]) => `<label>${esc(o.description ?? k)}
            ${o.type === 'boolean'
              ? `<input type="checkbox" data-opt="${esc(c.id)}" data-key="${esc(k)}" ${(s.options[k] ?? o.default) ? 'checked' : ''}>`
              : o.type === 'select'
                ? `<select data-opt="${esc(c.id)}" data-key="${esc(k)}">${(o.values ?? []).map(v => `<option ${(s.options[k] ?? o.default) === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
                : `<input type="${o.type === 'number' ? 'number' : 'text'}" data-opt="${esc(c.id)}" data-key="${esc(k)}" value="${esc(s.options[k] ?? o.default ?? '')}">`}
          </label>`).join('')}
        </div>
        <label><input type="checkbox" data-enable="${esc(c.id)}" ${s.enabled ? 'checked' : ''}> Enabled</label>
        <button class="btn ghost" data-remove="${esc(c.id)}">Delete</button>
      </div>`
    }).join('')}
  </div>`
  $app.querySelector('form').onsubmit = async e => {
    e.preventDefault()
    const err = document.getElementById('ext-err')
    err.textContent = 'Installing…'
    try { await ext.importRepo(e.target.querySelector('input').value) } catch (x) { return extensionsPage().then(() => { document.getElementById('ext-err').textContent = x.message }) }
    extensionsPage()
  }
  $app.onchange = e => {
    const t = e.target
    if (t.dataset.enable) ext.setEnabled(t.dataset.enable, t.checked)
    if (t.dataset.opt) ext.setOption(t.dataset.opt, t.dataset.key, t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value)
  }
  $app.onclick = e => { const id = e.target.closest('[data-remove]')?.dataset.remove; if (id) { ext.remove(id); extensionsPage() } }
}

// Ordered language preferences: the player uses the first one a release actually has.
function settingsPage () {
  // the subtitle list can also hold "Signs & Songs" (on-screen text and lyrics only), ranked like a language
  const names = { ...Object.fromEntries(Object.entries(LANGS).map(([k, [n]]) => [k, n])), [SIGNS]: 'Signs & Songs' }
  const section = (key, heading, help) => {
    const list = player.langPrefs(key)
    const rest = [...(key === 'subLangs' ? [SIGNS] : []), ...Object.keys(LANGS)].filter(k => !list.includes(k))
    return `<h3>${heading}</h3><p class="muted">${help}</p>
      <ol class="prio">${list.map((k, i) => `<li><b>${i + 1}</b><span>${esc(names[k] ?? k)}</span>
        <button data-key="${key}" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button data-key="${key}" data-move="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button data-key="${key}" data-del="${i}" aria-label="Remove">✕</button></li>`).join('')}</ol>
      <label class="prio-add"><select data-add="${key}" aria-label="Add a ${heading.toLowerCase()}"><option value="">+ Add language…</option>${rest.map(k => `<option value="${k}">${esc(names[k])}</option>`).join('')}</select></label>`
  }
  $app.innerHTML = `<div class="page settings"><h2>Settings</h2>
    ${section('audioLangs', 'Audio language', 'For releases with more than one audio track (e.g. dual audio). If none of these are in the file, its default track plays.')}
    ${section('subLangs', 'Subtitle language', 'The first of these the file has is turned on; Signs & Songs translates only on-screen text and lyrics. If none are in the file, a Signs & Songs track is used if there is one, otherwise subtitles stay off. Leave the list empty to always turn them off.')}
    <h3>Sort sources by</h3>
    <p class="muted">Which list puts a source on top in the source picker and Auto Select, when its name says what languages it has. The other list breaks ties.</p>
    ${[['audio', 'Audio language first'], ['subs', 'Subtitle language first']].map(([v, l]) => `<label class="check"><input type="radio" name="langFirst" value="${v}" ${load('langFirst', 'audio') === v ? 'checked' : ''}> ${l}</label>`).join('')}
    <h3>Player</h3>
    ${[['builtin', 'Built-in'], ['mpv', 'mpv: plays every audio and video format, including Dolby and DTS audio']].map(([v, l]) => `<label class="check"><input type="radio" name="player" value="${v}" ${load('player', 'builtin') === v ? 'checked' : ''}> ${l}</label>`).join('')}
    <label class="check"><input type="checkbox" data-mpv-auto ${load('mpvAuto', true) ? 'checked' : ''}> With the built-in player, use mpv for releases whose audio it can't play (Dolby, DTS)</label>
    ${hasMpv ? '' : '<p class="err">mpv is missing from this installation, so the built-in player is used.</p>'}
    <h3>Notifications</h3>
    <label class="check"><input type="checkbox" data-notify ${load('notify', true) ? 'checked' : ''}> Tell me when a new episode of a show I follow is out (checked every 30 minutes while Kotakbase is open)</label>
    <h3>Discord</h3>
    <label class="check"><input type="checkbox" data-discord ${load('discord', true) ? 'checked' : ''}> Show what I'm watching on my Discord profile (needs the Discord desktop app)</label>
    <h3>Closing the window</h3>
    <label class="check"><input type="checkbox" data-tray ${load('closeToTray', true) ? 'checked' : ''}> Keep Kotakbase running in the tray when the window is closed (quit from its tray icon). Turn off to quit on close.</label>
    <h3>AniList</h3>
    <div data-anilist></div>
    <h3>Updates</h3>
    <div data-updates></div>
    <h3>Your data</h3>
    <p class="muted">Back up your progress, list, history, ratings, extensions and settings to a file, or restore them from one.</p>
    <div class="actions"><button class="btn ghost" data-export>Export backup</button><button class="btn ghost" data-import>Import backup</button><input type="file" accept=".json,application/json" hidden data-import-file></div>
    <div class="err" id="data-err"></div>
  </div>`
  sync.settings($app.querySelector('[data-anilist]'))
  drawUpdate()
  const update = (key, fn) => { const list = player.langPrefs(key); fn(list); save(key, list); settingsPage() }
  $app.onclick = e => {
    if (e.target.closest('[data-export]')) return exportData()
    if (e.target.closest('[data-import]')) return $app.querySelector('[data-import-file]').click()
    const b = e.target.closest('button[data-key]')
    if (!b) return
    if (b.dataset.del) update(b.dataset.key, l => l.splice(+b.dataset.del, 1))
    if (b.dataset.move) update(b.dataset.key, l => { const i = +b.dataset.move; const j = i + +b.dataset.dir; [l[i], l[j]] = [l[j], l[i]] })
  }
  $app.onchange = e => {
    if (e.target.matches('[data-notify]')) return save('notify', e.target.checked)
    if (e.target.name === 'langFirst') return save('langFirst', e.target.value)
    if (e.target.name === 'player') return save('player', e.target.value)
    if (e.target.matches('[data-mpv-auto]')) return save('mpvAuto', e.target.checked)
    if (e.target.matches('[data-discord]')) return save('discord', e.target.checked)
    if (e.target.matches('[data-tray]')) { save('closeToTray', e.target.checked); return window.native.closeToTray(e.target.checked) }
    if (e.target.matches('[data-import-file]')) return importData(e.target.files[0]).catch(err => { document.getElementById('data-err').textContent = err.message })
    const k = e.target.dataset.add
    if (k && e.target.value) update(k, l => l.push(e.target.value))
  }
}

// Backup: everything Kotakbase keeps, except the home-row caches (re-downloaded anyway) and AniList sync's own state
// (tied to the sign-in, which isn't in the backup)
const backupKeys = () => Object.keys(localStorage).filter(k => !k.startsWith('list:') && !k.startsWith('anilist'))
function exportData () {
  const data = Object.fromEntries(backupKeys().map(k => [k, localStorage.getItem(k)]))
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([JSON.stringify({ kotakbase: 1, exported: new Date().toISOString(), data }, null, 1)], { type: 'application/json' }))
  link.download = `kotakbase-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 60000)
}
// A backup file replaces what's here (after asking); anything that isn't a Kotakbase backup is refused untouched
async function importData (file) {
  if (!file) return
  const notBackup = new Error('That file isn\'t a Kotakbase backup.')
  let backup
  try { backup = JSON.parse(await file.text()) } catch { throw notBackup }
  const data = backup?.kotakbase === 1 && backup.data
  if (!data || typeof data !== 'object' || !Object.values(data).every(v => typeof v === 'string')) throw notBackup
  if (!await ask('Import backup?', `<p>Your progress, list, history, ratings, extensions and settings will be replaced with the backup from ${esc(new Date(backup.exported).toLocaleString())}.</p>`, 'Replace')) return
  backupKeys().forEach(k => localStorage.removeItem(k))
  stored.clear()
  for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v)
  location.reload()
}

// ---- sources ----
const size = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB'

// ani.zip: per-episode titles/thumbnails/summaries plus AniDB/TVDB/etc ids that extensions use
const zipCache = new Map()
// AniList banners are only 1900×400, blurry when stretched over a big screen; TVDB's background art (via ani.zip)
// is usually 1920×1080. Swap it in once it has loaded; keep the AniList one when there is none.
// shortcut: TVDB art is per series, so a later season can get the first season's art; fine for a backdrop.
function sharpen (el, id) {
  aniZip(id).then(z => {
    const url = z.images?.find(i => i.coverType === 'Fanart')?.url
    if (!url || !el) return
    const img = new Image()
    img.onload = () => { el.style.backgroundImage = `url("${encodeURI(url)}")` }
    img.src = url
  })
}

const aniZip = id => {
  // episode titles/thumbnails for newly aired episodes: refetch after an hour
  const hit = zipCache.get(id)
  if (!hit || Date.now() - hit.at > 3600 * 1000) zipCache.set(id, { at: Date.now(), promise: fetch(`https://api.ani.zip/mappings?anilist_id=${id}`).then(r => r.json()).catch(() => ({})) })
  return zipCache.get(id).promise
}

async function mappings (id, episode) {
  try {
    const res = await aniZip(id)
    const ep = res.episodes?.[episode] ?? {}
    const mp = res.mappings ?? {}
    return { anidbAid: mp.anidb_id, anidbEid: ep.anidbEid, tvdbId: mp.thetvdb_id, tvdbEId: ep.tvdbId, imdbId: mp.imdb_id, tmdbId: mp.themoviedb_id, malId: mp.mal_id, kitsuId: mp.kitsu_id, absoluteEpisodeNumber: ep.absoluteEpisodeNumber, tvdbSeason: ep.seasonNumber, tvdbSeasonEpisode: ep.episodeNumber }
  } catch { return {} }
}

// Same title list Hayase builds: all titles + synonyms, plus "S2" variants of "Season 2" / "2nd Season".
function titles (m) {
  const out = []
  for (const t of new Set([...Object.values(m.title), ...m.synonyms].filter(t => t?.length > 3))) {
    for (const v of t.includes('-') ? [t, t.replaceAll('-', '')] : [t]) {
      out.push(v)
      const s = v.match(/Season (\d)/i) ?? v.match(/(\d)(?:nd|rd|th) Season/i)
      if (s) out.push(v.replace(s[0], `S${s[1]}`))
    }
  }
  return out
}

const ICON = {
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" class="fill"/><path d="m7.5 12.5 3 3 6-6.5" class="tick"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6v18h12V7zM14 3v4h4"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z" class="fill"/></svg>',
  best: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"/></svg>'
}
const RESOLUTIONS = [['2160', '2160p'], ['1080', '1080p'], ['720', '720p'], ['540', '540p'], ['480', '480p'], ['', 'Any']]
const MANUAL = /^(magnet:\?|[0-9a-f]{40}$|https?:\/\/\S+\.torrent(\?|$))/i
const seedClass = n => n >= 25 ? 'good' : n >= 5 ? 'ok' : 'bad'

// Results are sorted by the audio and subtitle priority lists in Settings (audio or subtitles first, also a setting),
// and Auto Select takes the top one that can stream. Results from dub-only extensions count as English audio.
const resultLanguages = r => audioLanguages([...(r.titles ?? [r.title])], [...r.extensions].some(id => ext.configs[id]?.media === 'dub'))
// a release that names no subtitle language is taken as English-subbed, the norm for the sources Kotakbase searches
const resultSubs = r => { const s = subLanguages([...(r.titles ?? [r.title])]); return s.size ? s : new Set(['eng']) }
const multiSubs = r => releaseTags([...(r.titles ?? [r.title])]).some(t => t.label === 'Multi Subs')
const byLanguage = results => rankByLanguage(results, { audio: player.langPrefs('audioLangs'), subs: player.langPrefs('subLangs'), first: load('langFirst', 'audio') }, resultLanguages, resultSubs, multiSubs)
const autoPick = results => pickAuto(results)

// mpv plays every audio format; the built-in player can't play Dolby (DDP, AC3, TrueHD) or DTS. Settings → Player.
let hasMpv = false
window.native.mpv.available().then(on => { hasMpv = on })
const autoMpv = () => hasMpv && load('mpvAuto', true)
const usesMpv = r => hasMpv && (load('player', 'builtin') === 'mpv' || (autoMpv() && unplayableAudio([...(r.titles ?? [r.title ?? ''])])))
// a release that would play without sound
const silent = r => !usesMpv(r) && unplayableAudio([...(r.titles ?? [r.title])])

// take the group from whichever extension's copy of the name it can be read from
const groupOf = r => [...(r.titles ?? [r.title ?? ''])].map(t => parseRelease(t).group).find(Boolean)
// The release group picked for a show, so its next episode offers that group first
function rememberSource (m, r) {
  const group = groupOf(r)
  if (group) save('sources', { ...load('sources', {}), [m.id]: { group } })
}

// Audio languages as short tags (JP, EN, CN, …), read from the release's names like Auto Select does
const SHORT = { jpn: 'JP', chi: 'CN', kor: 'KR' } // country-style where it's the familiar form; else the 2-letter code
const short = k => SHORT[k] ?? LANGS[k]?.[1]?.toUpperCase() ?? k
// audio: filled tags; subtitles: outlined, only when the name states them ("Multi Subs" already has its own tag)
const langTags = (r, multiSubs) => [...resultLanguages(r)].map(k => `<i class="lang" title="Audio: ${esc(LANGS[k]?.[0] ?? k)}">${esc(short(k))}</i>`).join('') +
  (multiSubs ? '' : [...subLanguages([...(r.titles ?? [r.title])])].map(k => `<i class="sub" title="Subtitles: ${esc(LANGS[k]?.[0] ?? k)}">${esc(short(k))}</i>`).join(''))

function sourceCard (r, k, lastUsed) {
  const tags = releaseTags([...(r.titles ?? [r.title])])
  const group = groupOf(r)
  const batch = r.type === 'batch'
  const exts = [...r.extensions].map(id => ext.configs[id]).filter(Boolean)
  return `<button class="rel" data-k="${k}">
    <span class="rel-check ${r.accuracy}" title="${esc(r.accuracy)} accuracy">${ICON.check}</span>
    <span class="rel-icon ${batch ? 'folder' : r.type === 'best' ? 'best' : ''}">${batch ? ICON.folder : r.type === 'best' ? ICON.best : ICON.file}</span>
    <span class="rel-main">
      <b>${esc(group || r.title)}${lastUsed ? '<span class="badge">Last used</span>' : ''}</b>
      <span class="rel-name">${esc(r.title)}</span>
      <span class="rel-meta">${batch ? '<i class="rel-batch">Batch</i> · ' : ''}<em class="${seedClass(r.seeders)}">${r.seeders} Seeders</em> · ${size(r.size)}${r.date.getTime() ? ` · ${esc(ago(r.date))}` : ''}</span>
    </span>
    <span class="rel-side">
      <span class="rel-exts">${exts.map(c => `<img src="${esc(c.icon)}" alt="${esc(c.name)}" title="${esc(c.name)}">`).join('')}</span>
      <span class="rel-tags">${silent(r) ? '<i class="noaudio" title="Its audio is Dolby (DDP, AC3, TrueHD) or DTS, which Kotakbase cannot play: the video would be silent">No audio</i>' : ''}${tags.map(t => `<i class="${t.kind}">${esc(t.label)}</i>`).join('')}${langTags(r, tags.some(t => t.label === 'Multi Subs'))}</span>
    </span>
  </button>`
}

// opts.download: 'season' or 'episode' picks a source to download instead of playing; opts.stream skips a download
function sources (m, startEpisode, opts = {}) {
  if (room && !room.isHost() && !opts.download) return notHost()
  const total = epCount(m)
  let episode = Math.min(Math.max(1, startEpisode), total)
  const have = !opts.download && !opts.stream && downloadedEpisode(m.id, episode)
  if (have) return play(m, episode, { link: have.magnet, title: have.name, local: have }, {}, have.index)
  let results = []
  let numbering = {} // other numbers for this episode when the season continues another: series-wide and TVDB season/episode
  let searchId = 0
  let lastGroup
  let searching = false // extensions are still answering
  let dead = 0 // sources hidden for having no seeders
  document.querySelector('.src-modal')?.remove() // only one source picker at a time
  const modal = document.createElement('div')
  modal.className = 'modal src-modal'
  modal.innerHTML = `<div class="src-box" role="dialog" aria-label="Select a source">
    <div class="src-head" style="background-image:url('${esc(m.bannerImage ?? m.coverImage.extraLarge)}')">
      <h2>${opts.download ? 'Download: ' : ''}${esc(title(m))}</h2>
      <button class="src-close" data-close aria-label="Close">✕</button>
      ${opts.download === 'season' ? '<p class="src-hint">Pick a batch (the folder icon) to download every episode out so far, or a single release for just this episode.</p>' : opts.download ? '<p class="src-hint">Pick a source to download this episode.</p>' : ''}
      <label class="src-filter"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <input placeholder="Filter by text, or paste a magnet link or torrent URL here to specify a torrent manually" aria-label="Filter or paste a magnet link"></label>
      <div class="src-opts">
        <label>Episode <input type="number" min="1" max="${total}" value="${episode}" class="src-ep"></label>
        <label>Resolution <select class="src-res">${RESOLUTIONS.map(([v, l]) => `<option value="${v}" ${load('resolution', '1080') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <button class="src-auto" disabled><span class="src-auto-label">Searching…</span></button>
    </div>
    <div class="err"></div>
    <div class="src-list"></div>
  </div>`
  document.body.append(modal)
  const $ = sel => modal.querySelector(sel)
  const filter = $('.src-filter input')
  const autoBtn = $('.src-auto')
  const choose = r => { modal.remove(); opts.download ? startDownload(m, episode, r, opts.download) : play(m, episode, r, numbering) }
  // closed without picking: leave the fullscreen kept from the last episode, unless a player is still open
  const cancel = () => { modal.remove(); if (document.getElementById('player').hidden) player.exitFullscreen() }

  function render () {
    const q = filter.value.trim()
    if (MANUAL.test(q)) {
      $('.src-list').innerHTML = `<button class="rel" data-manual><span class="rel-check high">${ICON.check}</span><span class="rel-icon">${ICON.file}</span>
        <span class="rel-main"><b>Play this torrent</b><span class="rel-name">${esc(q)}</span><span class="rel-meta">Press Enter or click to stream it as episode ${episode}</span></span></button>`
      return
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = results.map((r, k) => [r, k]).filter(([r]) => words.every(w => r.title.toLowerCase().includes(w)))
    $('.src-list').innerHTML = shown.length ? shown.map(([r, k]) => sourceCard(r, k, lastGroup && groupOf(r) === lastGroup)).join('') : `<p class="muted src-empty">${results.length ? 'No sources match the filter.' : searching ? 'Searching extensions…' : dead ? `No sources with seeders found (${dead} with none hidden). Try another resolution or episode.` : Object.keys(ext.configs).length ? 'No sources found.' : 'No extensions installed. Add one under <a href="#/extensions">Extensions</a> to find sources.'}</p>`
  }

  async function search () {
    const id = ++searchId
    results = []
    searching = true
    autoBtn.disabled = true
    $('.src-auto-label').textContent = 'Searching…'
    $('.src-list').innerHTML = '<p class="muted src-empty">Searching extensions…</p>'
    $('.err').textContent = ''
    try {
      const ids = await mappings(m.id, episode)
      numbering = numberingOf(ids)
      const query = { anilistId: m.id, media: m, titles: titles(m), episode, episodeCount: total, resolution: $('.src-res').value, exclusions: [], ...ids }
      const single = total === 1
      // Extensions that search by title also return other seasons ("S04E01" for season 1) and spin-offs ("Tensura
      // Nikki - 01" for Slime), so drop releases whose names say they're another entry of the franchise. The franchise
      // is looked up alongside the search; until it's in, only the season check applies.
      let others = []
      const seasons = [entryNumbers(query.titles).season, ids.tvdbSeason]
      const last = load('sources', {})[m.id]?.group
      lastGroup = last
      let raw = []
      const show = () => {
        if (id !== searchId || !modal.isConnected) return
        const matching = raw.filter(r => forThisEntry([...(r.titles ?? [r.title])], { seasons, others }))
        // no seeders = can't stream, so hidden; only once the search is done, since some extensions (Seadex) send 0
        // and the real count comes from the trackers at the end
        const found = searching ? matching : matching.filter(r => r.seeders > 0)
        dead = matching.length - found.length
        // your languages first (Settings); among equals, the release group used last time for this show, then the
        // extensions' order (both sorts are stable)
        const ranked = byLanguage(last ? [...found.filter(r => groupOf(r) === last), ...found.filter(r => groupOf(r) !== last)] : found)
        // Dolby/DTS-only audio plays silently in the built-in player, so those go below everything playable (Auto Select skips them too)
        results = [...ranked.filter(r => !silent(r)), ...ranked.filter(silent)]
        render()
      }
      const franchise = related(m.id).catch(() => []).then(list => { others = otherEntryWords(query.titles, list.flatMap(e => [e.title.romaji, e.title.english].filter(Boolean))); show() })
      // sources show as each extension answers; seeder counts the trackers fill in, and Auto Select, come with the final list
      const res = await ext.search(query, { movie: m.format === 'MOVIE' && !single, batch: !single && m.format !== 'MOVIE' }, list => { raw = list; show() })
      await franchise
      if (id !== searchId || !modal.isConnected) return
      searching = false
      raw = res.results
      show()
      // brand-new shows often aren't mapped yet, and most extensions search by AniDB/TVDB ids, so say why instead of only showing their errors
      const unmapped = !results.length && !ids.anidbAid && !ids.tvdbId && !ids.tmdbId
      $('.err').textContent = (unmapped ? 'This show isn\'t linked to AniDB/TVDB yet (common for brand-new releases), so most extensions can\'t search for it. Try again in a few days, or paste a magnet link above. Details: ' : '') + res.errors.join(' · ')
      autoBtn.disabled = !results.length
      $('.src-auto-label').textContent = results.length ? 'Auto Select Torrent' : 'No sources'
    } catch (e) {
      if (id !== searchId) return
      searching = false
      $('.src-list').innerHTML = `<p class="err src-empty">${esc(e.message)}</p>`
      $('.src-auto-label').textContent = 'No sources'
    }
  }

  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel() }
    if (e.key === 'Enter' && e.target === filter && MANUAL.test(filter.value.trim())) choose({ link: filter.value.trim() })
  })
  modal.onclick = e => {
    if (e.target === modal || e.target.closest('[data-close]')) return cancel()
    // downloading a season: a batch first, if there is one
    if (e.target.closest('.src-auto') && results[0]) return choose(opts.download === 'season' && results.some(r => r.type === 'batch') ? autoPick(results.filter(r => r.type === 'batch')) : autoPick(results))
    if (e.target.closest('[data-manual]')) return choose({ link: filter.value.trim() })
    const k = e.target.closest('[data-k]')?.dataset.k
    if (k != null) choose(results[k])
  }
  filter.oninput = render
  let t
  $('.src-ep').oninput = e => {
    const n = Number(e.target.value)
    if (!Number.isInteger(n) || n < 1 || n > total) return
    episode = n
    clearTimeout(t)
    t = setTimeout(search, 400)
  }
  $('.src-res').onchange = e => { save('resolution', e.target.value); search() }
  filter.focus()
  search()
}

// AniSkip: community-submitted opening/ending times by MyAnimeList id + episode, for files without chapters.
// The episode length makes it prefer times submitted for a file of the same length.
async function aniSkip (malId, episode, duration) {
  if (!malId) return []
  const res = await fetch(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types=op&types=ed&episodeLength=${Math.round(duration)}`)
  const { results = [] } = await res.json()
  return results.map(r => ({ title: r.skipType === 'op' ? 'Opening' : 'Ending', start: r.interval.startTime, end: r.interval.endTime, kind: r.skipType })).sort((a, b) => a.start - b.start)
}

// Episode list that slides in over the player (from its "Episode N / M" line); picking one opens its sources.
async function episodeDrawer (m, playing) {
  document.querySelector('.ep-drawer')?.remove()
  const drawer = document.createElement('div')
  drawer.className = 'ep-drawer'
  drawer.innerHTML = `<div class="ep-drawer-box" role="dialog" aria-label="Episodes">
    <div class="ep-drawer-head"><b>${esc(title(m))}</b><button class="src-close" data-close aria-label="Close">✕</button></div>
    <div class="ep-drawer-list"><p class="muted src-empty">Loading episodes…</p></div>
  </div>`
  document.body.append(drawer)
  const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close() } }
  const close = () => { drawer.remove(); document.removeEventListener('keydown', onKey, true) }
  document.addEventListener('keydown', onKey, true)
  drawer.onclick = e => {
    if (e.target === drawer || e.target.closest('[data-close]')) return close()
    const dl = e.target.closest('[data-dl-ep]')
    if (dl) { close(); return sources(m, Number(dl.dataset.dlEp), { download: 'episode' }) }
    const b = e.target.closest('[data-ep]')
    if (b) { close(); sources(m, Number(b.dataset.ep)) }
  }
  const list = drawer.querySelector('.ep-drawer-list')
  list.innerHTML = episodeCards(m, await aniZip(m.id), playing)
  list.querySelector('.epc.current')?.scrollIntoView({ block: 'center' })
}

// ---- player ----
// OVAs/specials/movies inside series packs are numbered differently from AniList ("OAD 5", "S00E04"), so for these
// the user picks the file. Regular episodes keep being matched automatically.
const PICK_FILE_FORMATS = ['OVA', 'SPECIAL', 'MOVIE']

// Resolves to a file index, undefined when there's only one video (nothing to choose), or null if cancelled.
function chooseFile (m, link) {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `<div class="src-box" role="dialog" aria-label="Choose a file">
      <div class="src-head" style="background-image:url('${esc(m.bannerImage ?? m.coverImage.extraLarge)}')">
        <h2>${esc(title(m))}</h2>
        <button class="src-close" data-close aria-label="Close">✕</button>
        <p class="muted src-hint">This torrent has several videos. Pick the one to play.</p>
        <label class="src-filter"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input placeholder="Filter files, e.g. OVA, OAD, special" aria-label="Filter files"></label>
      </div>
      <div class="src-list"><p class="muted src-empty">Loading the file list…</p></div>
    </div>`
    document.body.append(modal)
    const $ = sel => modal.querySelector(sel)
    let files = []
    const done = value => { modal.remove(); resolve(value) }
    const cancel = () => { window.native.filesCancel(); done(null) }
    const render = () => {
      const words = $('.src-filter input').value.toLowerCase().split(/\s+/).filter(Boolean)
      const shown = files.filter(f => words.every(w => f.path.toLowerCase().includes(w)))
      $('.src-list').innerHTML = shown.length
        ? shown.map(f => {
          const folder = f.path.split(/[\\/]/).slice(0, -1).join(' / ')
          return `<button class="rel" data-i="${f.index}"><span></span><span class="rel-icon">${ICON.file}</span>
            <span class="rel-main"><b>${esc(f.name)}</b><span class="rel-name">${esc(folder)}</span><span class="rel-meta">${size(f.size)}</span></span></button>`
        }).join('')
        : '<p class="muted src-empty">No files match the filter.</p>'
    }
    modal.onclick = e => {
      if (e.target === modal || e.target.closest('[data-close]')) return cancel()
      const i = e.target.closest('[data-i]')?.dataset.i
      if (i != null) done(Number(i))
    }
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') cancel() })
    $('.src-filter input').oninput = render
    $('.src-filter input').focus()
    window.native.files(link).then(list => {
      if (!modal.isConnected) return window.native.filesCancel()
      if (list.length <= 1) return done(undefined)
      files = list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      render()
    }, e => { $('.src-list').innerHTML = `<p class="err src-empty">Couldn't load the torrent: ${esc(e.message)}</p>` })
  })
}

// Watch history: one entry per episode watched past 90%, newest last; capped so it can't grow forever.
function logWatched (m, episode, last) {
  const history = load('history', [])
  history.push({ id: m.id, episode, at: Date.now(), finished: last && m.status === 'FINISHED' })
  save('history', history.slice(-2000))
}

// Numbers an episode goes by besides its own (for continued seasons), as the extensions and file matching use them
const numberingOf = ids => ({ abs: ids.absoluteEpisodeNumber, tvdbSeason: ids.tvdbSeason, tvdbSeasonEpisode: ids.tvdbSeasonEpisode })

// fromRoom: the Watch Together host picked this, so it plays here too
async function play (m, episode, result, numbering, fileIndex, fromRoom = false) {
  if (room && !room.isHost() && !fromRoom) return notHost()
  let logged = false // one history entry per playback
  rememberSource(m, result)
  if (fileIndex == null && PICK_FILE_FORMATS.includes(m.format)) {
    fileIndex = await chooseFile(m, result.link)
    if (fileIndex === null) return
  }
  room?.played({ mediaId: m.id, episode, link: result.link, title: result.title, fileIndex, numbering })
  const local = result.local ?? (fromRoom ? downloadedFile(result.link, fileIndex) : null)
  const follower = !!room && !room.isHost() // the host moves everyone to the next episode
  nowPlaying = { title: title(m), episode, total: epCount(m), cover: m.coverImage.extraLarge }
  const total = epCount(m)
  const prev = progress()[m.id]
  // Is the next episode in this same torrent (a season pack)? Then Next / the end of the episode plays it straight away,
  // and it starts downloading near the end of this one. Asked as playback starts (the main process answers once the
  // torrent is loaded), so the Next button knows any time.
  let next = null
  let prefetched = false
  const nextIds = episode < total ? mappings(m.id, episode + 1).then(numberingOf) : null
  const findNext = download => nextIds?.then(nb => window.native.nextFile(result.link, episode + 1, nb, download).then(index => { next = index == null ? null : { index, numbering: nb } })).catch(() => {})
  player.play({
    title: title(m),
    subtitle: `Episode ${episode} / ${total}`,
    link: result.link,
    episode,
    fileIndex,
    numbering,
    resume: prev?.episode === episode ? prev.time : 0,
    hasPrev: !follower && episode > 1,
    hasNext: !follower && episode < total,
    onProgress: (time, duration) => {
      const watched = time > duration * 0.9
      const last = episode >= total
      if (!prefetched && time > duration * 0.85) { prefetched = true; findNext(true) }
      if (watched && !logged) { logged = true; logWatched(m, episode, last) }
      const entry = watched && !last ? { episode: episode + 1, time: 0, duration: 1 } : { episode, time, duration }
      // the final episode of a show that has finished airing: it leaves Continue Watching
      if (watched && last && m.status === 'FINISHED') entry.finished = true
      save('progress', { ...progress(), [m.id]: { ...entry, at: Date.now() } })
    },
    onPrev: () => sources(m, episode - 1),
    onNext: () => next ? play(m, episode + 1, result, next.numbering, next.index) : sources(m, episode + 1),
    nextInTorrent: () => !!next,
    onTitle: () => { location.hash = `#/anime/${m.id}` },
    onEpisodes: () => episodeDrawer(m, episode),
    onSources: () => sources(m, episode, { stream: true }),
    local,
    skipTimes: duration => aniSkip(m.idMal, episode, duration),
    player: usesMpv(result) ? 'mpv' : 'builtin',
    autoMpv: autoMpv()
  })
  findNext(false) // after player.play has sent its play request, which the main process answers this after
}

// ---- downloads (offline) ----
let downloadList = [] // from the main process: [{ id, mediaId, title, cover, magnet, status, error, speed, peers, files: [{ index, episode, name, length, have, done, missing }] }]
const DL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>'

// a finished download of this episode, to play from disk
function downloadedEpisode (mediaId, episode) {
  for (const d of downloadList) {
    const f = d.mediaId === mediaId && d.files.find(x => x.episode === episode && x.done && !x.missing)
    if (f) return { id: d.id, index: f.index, magnet: d.magnet, name: f.name }
  }
  return null
}
// the same file of the same torrent, downloaded (a Watch Together host's pick you happen to have)
function downloadedFile (link, index) {
  const hash = String(link).match(/btih:([0-9a-f]{40})/i)?.[1]?.toLowerCase()
  const d = hash && downloadList.find(x => x.id === hash)
  const f = d?.files.find(x => x.index === index && x.done && !x.missing)
  return f ? { id: d.id, index: f.index } : null
}
// an episode's download state, for its card: '' (none), 'done', or a percentage
function episodeDownload (mediaId, episode) {
  for (const d of downloadList) {
    const f = d.mediaId === mediaId && d.files.find(x => x.episode === episode)
    if (f) return f.done && !f.missing ? 'done' : `${Math.floor(f.have / f.length * 100)}%`
  }
  return ''
}
const dlButton = (m, n) => {
  const s = episodeDownload(m.id, n)
  return `<span class="ep-dl ${s === 'done' ? 'done' : s ? 'busy' : ''}" data-dl-ep="${n}" data-media="${m.id}" role="button" title="${s === 'done' ? 'Downloaded' : s ? `Downloading: ${s}` : 'Download this episode'}">${s === 'done' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : s ? `<small>${s}</small>` : DL_ICON}</span>`
}

const totals = list => {
  const files = list.flatMap(d => d.files)
  const active = list.filter(d => d.status === 'active' || d.status === 'waiting')
  const want = active.flatMap(d => d.files)
  return { done: files.filter(f => f.done && !f.missing).length, active: active.length, pct: want.length ? Math.floor(want.reduce((a, f) => a + Math.min(f.have, f.length), 0) / want.reduce((a, f) => a + f.length, 0) * 100) : 0 }
}
function onDownloads (list) {
  downloadList = list
  const t = totals(list)
  const pill = document.getElementById('dl-pill')
  pill.textContent = t.active ? `${t.pct}%` : t.done ? String(t.done) : ''
  pill.parentElement.classList.toggle('busy', !!t.active)
  pill.parentElement.title = t.active ? `Downloading: ${t.pct}%` : t.done ? `${t.done} episodes downloaded` : 'Downloads'
  // episode cards on a show page: their download buttons follow along
  for (const el of document.querySelectorAll('[data-dl-ep]')) {
    const fresh = document.createRange().createContextualFragment(dlButton({ id: +el.dataset.media }, +el.dataset.dlEp)).firstChild
    if (fresh.outerHTML !== el.outerHTML) el.replaceWith(fresh)
  }
  if (location.hash === '#/downloads') downloadsPage(true)
}
window.native.downloads.list().then(onDownloads)
window.native.on('downloads', onDownloads)

async function startDownload (m, episode, r, mode) {
  // a season pack, from the show's Download button: every episode out so far; otherwise the one episode
  const season = mode === 'season' && r.type === 'batch'
  const eps = season ? Array.from({ length: airedCount(m) }, (_, k) => k + 1) : [episode]
  let fileIndex
  if (!season && PICK_FILE_FORMATS.includes(m.format)) {
    fileIndex = await chooseFile(m, r.link)
    if (fileIndex === null) return
  }
  const episodes = await Promise.all(eps.map(async e => ({ episode: e, numbering: numberingOf(await mappings(m.id, e)) })))
  try {
    const res = await window.native.downloads.add({ mediaId: m.id, title: title(m), cover: m.coverImage.extraLarge, link: r.link, episodes, fileIndex })
    rememberSource(m, r)
    notice(res.waiting ? 'That torrent is playing right now, so its download starts when you close the player.' : `Downloading ${res.episodes === 1 ? '1 episode' : `${res.episodes} episodes`}. See them under Downloads.`)
  } catch (e) {
    notice(`Couldn't download: ${e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`)
  }
}

// a short message at the bottom of the window
function notice (text) {
  const el = document.createElement('div')
  el.className = 'notice'
  el.setAttribute('role', 'status')
  el.textContent = text
  document.body.append(el)
  setTimeout(() => el.remove(), 5000)
}

let downloadsShape = ''
function downloadsPage (update = false) {
  const list = downloadList
  // redrawn every second while downloading: just the numbers, unless entries came or went (so clicks aren't lost)
  const shape = JSON.stringify(list.map(d => [d.id, d.status, d.error, d.files.map(f => [f.index, f.done, f.missing])]))
  if (update && shape === downloadsShape && $app.querySelector('.downloads')) {
    for (const d of list) {
      const s = $app.querySelector(`[data-dl-stat="${d.id}"]`)
      if (s) s.textContent = statusText(d)
      for (const f of d.files) {
        const bar = $app.querySelector(`[data-dl-bar="${d.id}:${f.index}"]`)
        if (bar) bar.style.width = `${Math.min(100, f.have / f.length * 100)}%`
        const t = $app.querySelector(`[data-dl-size="${d.id}:${f.index}"]`)
        if (t) t.textContent = fileText(f)
      }
    }
    return
  }
  downloadsShape = shape
  const shows = [...new Set(list.map(d => d.mediaId))]
  $app.innerHTML = `<div class="page downloads"><h2>Downloads</h2>
    <p class="muted">Episodes you download play from your computer, without internet. <span class="dl-dir"></span></p>
    <div class="actions"><button class="btn ghost" data-dl-open>Open folder</button><button class="btn ghost" data-dl-dir>Change folder</button></div>
    ${shows.length ? shows.map(id => {
      const items = list.filter(d => d.mediaId === id)
      return `<section class="box dl-show">
        <img src="${esc(items[0].cover)}" alt="">
        <div class="dl-body">
          <h3><a href="#/anime/${id}">${esc(items[0].title)}</a></h3>
          ${items.map(d => `<div class="dl-torrent">
            <div class="dl-head"><span class="muted" data-dl-stat="${d.id}">${esc(statusText(d))}</span>
              ${d.status === 'active' ? `<button class="btn ghost" data-dl-pause="${d.id}">Pause</button>` : ['paused', 'error'].includes(d.status) ? `<button class="btn ghost" data-dl-resume="${d.id}">Resume</button>` : ''}
              <button class="btn ghost" data-dl-del="${d.id}">Delete</button></div>
            ${d.files.map(f => `<div class="dl-file">
              <button class="dl-play" data-dl-play="${d.id}:${f.index}" ${f.done && !f.missing ? '' : 'disabled'} aria-label="Play episode ${f.episode ?? ''}"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg></button>
              <div class="dl-info"><b>${f.episode ? `Episode ${f.episode}` : esc(f.name)}</b><span class="muted" title="${esc(f.name)}">${esc(f.name)}</span>
                <div class="meter"><i data-dl-bar="${d.id}:${f.index}" style="width:${Math.min(100, f.have / f.length * 100)}%"></i></div></div>
              <span class="muted dl-size" data-dl-size="${d.id}:${f.index}">${esc(fileText(f))}</span>
              <button class="dl-x" data-dl-del="${d.id}:${f.index}" aria-label="Delete this episode" title="Delete this episode">✕</button>
            </div>`).join('')}
          </div>`).join('')}
        </div></section>`
    }).join('') : '<p class="muted">Nothing downloaded yet. On a show\'s page, use the download button next to Watch for a whole season, or the one on an episode for just that episode.</p>'}
  </div>`
  window.native.downloads.dir().then(d => { const el = $app.querySelector('.dl-dir'); if (el) el.textContent = `Saved in ${d}.` })
  $app.onclick = async e => {
    const b = e.target.closest('button')
    if (!b) return
    const d = b.dataset
    if (d.dlOpen != null) return window.native.downloads.open()
    if (d.dlDir != null) return window.native.downloads.chooseDir().then(dir => { $app.querySelector('.dl-dir').textContent = `New downloads go to ${dir}.` })
    if (d.dlPause) return window.native.downloads.pause(d.dlPause)
    if (d.dlResume) return window.native.downloads.resume(d.dlResume)
    if (d.dlPlay) {
      const [id, index] = d.dlPlay.split(':')
      const item = downloadList.find(x => x.id === id)
      const f = item?.files.find(x => x.index === +index)
      if (!f) return
      const m = await media(item.mediaId).catch(() => null)
      if (!m) return notice('Couldn\'t load this show\'s details, which the player needs. Try again when you\'re online.')
      return play(m, f.episode ?? 1, { link: item.magnet, title: f.name, local: { id, index: +index } }, {}, +index)
    }
    if (d.dlDel) {
      const [id, index] = d.dlDel.split(':')
      const item = downloadList.find(x => x.id === id)
      const f = index != null && item?.files.find(x => x.index === +index)
      const what = f ? (f.episode ? `episode ${f.episode}` : f.name) : `${item.files.length === 1 ? 'this episode' : `these ${item.files.length} episodes`} of ${item.title}`
      if (await ask('Delete download?', `<p>The video file${f || item.files.length === 1 ? '' : 's'} for ${esc(what)} will be deleted from your computer.</p>`, 'Delete')) window.native.downloads.remove(id, index == null ? undefined : +index)
    }
  }
}
function statusText (d) {
  const left = d.files.filter(f => !f.done).length
  if (d.status === 'waiting') return 'Starts when you close the player'
  if (d.status === 'paused') return `Paused · ${left} to go`
  if (d.status === 'error') return `Stopped: ${d.error}`
  if (d.status === 'done') return d.files.some(f => f.missing) ? 'Some files were deleted outside Kotakbase' : 'Downloaded'
  return `Downloading · ${(d.speed / 1e6).toFixed(1)} MB/s · ${d.peers} peers · ${left} to go`
}
const fileText = f => f.missing ? 'File missing' : f.done ? size(f.length) : `${size(Math.min(f.have, f.length))} of ${size(f.length)}`

// ---- Watch Together ----
let room = null // the room you're in, if any
let roomError = ''
const roomName = () => load('roomName', '') || `Guest ${Math.floor(100 + Math.random() * 900)}`

async function enterRoom (code) {
  if (room) return
  const name = roomName()
  save('roomName', name)
  roomError = ''
  try {
    room = await openRoom({
      code: code ?? undefined,
      name,
      getPlayer: player.current,
      onChange: drawRoom,
      onLoad: followHost,
      // others' messages pop up over the video too
      onChat: msg => { if (!msg.mine && player.current()) player.roomMessage(msg.name, msg.text) }
    })
    if (!code) room.claim()
  } catch (e) {
    roomError = `Couldn't start Watch Together: ${e.message}`
  }
  drawRoom()
}

// the host started something: play it here (the host's player is the clock, so it starts wherever they are)
function followHost (l) {
  document.querySelector('.src-modal')?.remove()
  media(l.mediaId).then(m => play(m, l.episode, { link: l.link, title: l.title }, l.numbering ?? {}, l.fileIndex, true))
    .catch(e => { roomError = `Couldn't open what the host is playing: ${e.message}`; drawRoom() })
}

function leaveRoom () {
  room?.leave()
  room = null
  drawRoom()
}

async function notHost () {
  if (await ask('The host picks what to watch', '<p>You\'re in a Watch Together room, so the host chooses the show, episode and source for everyone. Leave the room to watch something on your own.</p>', 'Leave room', 'Stay')) leaveRoom()
}

// An invite link opened Kotakbase (or reached it while running): join that room, asking first if you're in another
async function joinInvite (text) {
  const code = text && parseCode(text)
  if (!code) return
  if (location.hash !== '#/together') location.hash = '#/together'
  if (room?.code === code) return
  if (room && !await ask('Join another room?', `<p>You're in room ${esc(formatCode(room.code))}. Leave it and join ${esc(formatCode(code))}?</p>`, 'Join', 'Stay')) return
  leaveRoom()
  enterRoom(code)
}
window.native.takeInvite().then(joinInvite)
window.native.on('invite', () => window.native.takeInvite().then(joinInvite))

// the top bar's tab and the player show who's in the room; the page redraws when anything changes
function drawRoom () {
  const tab = document.querySelector('[data-nav="together"]')
  if (tab) tab.dataset.count = room ? room.members().length + 1 : ''
  const hostName = room && (room.isHost() ? 'you\'re the host' : `host: ${room.members().find(p => p.id === room.host)?.name ?? '…'}`)
  player.room(room && `${room.members().length + 1} watching · ${hostName}`, text => room?.say(text))
  if (location.hash === '#/together') togetherPage()
}

const roomNow = {} // mediaId -> title, for "Now watching"
const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
function togetherPage () {
  // redrawn whenever someone joins, leaves or writes: keep what's being typed, and the chat scrolled to the end
  const focused = document.activeElement?.matches?.('.together input') ? document.activeElement.dataset.field : null
  const typed = Object.fromEntries([...$app.querySelectorAll('.together input[data-field]')].map(i => [i.dataset.field, i.value]))
  const nameField = `<label class="field"><span>Your name</span><input data-field="name" maxlength="40" value="${esc(room?.me.name ?? roomName())}"></label>`
  if (!room) {
    $app.innerHTML = `<div class="page together"><h2>Watch Together</h2>
      <p class="muted lead">Watch with friends on other devices. The host picks the show, episode and source, and everyone's player follows: pausing, playing and seeking happen for everyone.</p>
      ${nameField}
      <div class="together-boxes">
        <section class="box"><h3>Start a room</h3><p class="muted">You'll be the host. Share the invite link or the room code with your friends.</p><button class="btn" data-create>Create room</button></section>
        <section class="box"><h3>Join a room</h3><p class="muted">Open the invite link someone shared, or enter their room code.</p>
          <form class="add" data-join><input data-field="code" placeholder="XXXX-XXXX-XXXX" aria-label="Room code" maxlength="40" autocomplete="off" spellcheck="false"><button class="btn">Join</button></form></section>
      </div>
      <p class="err">${esc(roomError)}</p></div>`
  } else {
    const people = [room.me, ...room.members()]
    const status = p => p === room.me ? '' : !p.known ? 'Connecting…' : p.buffering ? 'Loading…' : ''
    const l = room.load
    if (l && !(l.mediaId in roomNow)) { roomNow[l.mediaId] = ''; media(l.mediaId).then(m => { roomNow[l.mediaId] = title(m); drawRoom() }, () => {}) }
    const n = room.members().length
    const chat = room.chat()
    $app.innerHTML = `<div class="page together"><h2>Watch Together</h2>
      <section class="box room-head">
        <div><span class="kicker">Room code</span><b class="room-code">${esc(formatCode(room.code))}</b></div>
        <div class="actions"><button class="btn" data-copy="link">Copy invite link</button><button class="btn ghost" data-copy="code">Copy code</button><button class="btn ghost" data-leave>Leave room</button></div>
      </section>
      <p class="muted">${n ? `${n + 1} people in the room.` : room.net.trackers ? 'Waiting for others to join…' : 'Connecting…'}${room.isHost() ? ' You\'re the host: pick a show and episode as usual, and everyone here watches it with you.' : ''}</p>
      <div class="room-grid">
        <div>
          <h3>Now watching</h3>
          <p>${l ? `<a href="#/anime/${l.mediaId}">${esc(roomNow[l.mediaId] || 'Loading…')}</a> · Episode ${l.episode}` : '<span class="muted">Nothing yet. The host picks a show and episode as usual.</span>'}</p>
          ${l && !room.isHost() && !player.current() ? '<div class="actions"><button class="btn" data-rejoin>Watch with the room</button></div>' : ''}
          <h3>People</h3>
          <ul class="people">${people.map(p => `<li>
            <span class="avatar" aria-hidden="true">${esc((p.known === false ? '?' : p.name.trim()[0] || '?').toUpperCase())}</span>
            <span class="person"><b>${esc(p.known === false ? 'Someone' : p.name)}${p === room.me ? ' <span class="muted">(you)</span>' : ''}</b>${status(p) ? `<span class="muted">${status(p)}</span>` : ''}</span>
            ${p.id === room.host ? '<span class="badge host">Host</span>' : ''}
            ${room.isHost() && p !== room.me && p.known ? `<button class="btn ghost" data-host="${esc(p.id)}">Make host</button>` : ''}
          </li>`).join('')}</ul>
          ${nameField}
        </div>
        <section class="box room-chat" aria-label="Chat">
          <h3>Chat</h3>
          <div class="chat-log">${chat.map(c => `<p class="${c.mine ? 'mine' : ''}"><b>${esc(c.name)}</b> <time>${clock(c.at)}</time><span>${esc(c.text)}</span></p>`).join('') || '<p class="muted">No messages yet. While watching, the people icon at the top of the player opens a box to write in.</p>'}</div>
          <form class="add" data-chat><input data-field="chat" maxlength="300" placeholder="Say something…" aria-label="Message the room" autocomplete="off"><button class="btn">Send</button></form>
        </section>
      </div>
      <p class="err">${esc(roomError || room.problem)}</p></div>`
    const log = $app.querySelector('.chat-log')
    log.scrollTop = log.scrollHeight
  }
  for (const [k, v] of Object.entries(typed)) { const i = $app.querySelector(`[data-field="${k}"]`); if (i) i.value = v }
  if (focused) $app.querySelector(`[data-field="${focused}"]`)?.focus()
  $app.onclick = e => {
    if (e.target.closest('[data-create]')) return enterRoom(null)
    if (e.target.closest('[data-leave]')) return leaveRoom()
    const copy = e.target.closest('[data-copy]')
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy === 'link' ? inviteLink(room.code) : formatCode(room.code))
      const label = copy.textContent
      copy.textContent = 'Copied'
      return setTimeout(() => { copy.textContent = label }, 1500)
    }
    if (e.target.closest('[data-rejoin]')) return room.load && followHost(room.load)
    const h = e.target.closest('[data-host]')
    if (h) room.makeHost(h.dataset.host)
  }
  $app.onchange = e => {
    if (e.target.dataset.field !== 'name') return
    const n = e.target.value.trim().slice(0, 40)
    if (!n) return
    save('roomName', n)
    room?.rename(n)
  }
  $app.onsubmit = e => {
    e.preventDefault()
    if (e.target.matches('[data-chat]')) {
      const input = e.target.querySelector('input')
      const text = input.value
      input.value = '' // before saying it: saying redraws the page, which keeps what's typed
      return room?.say(text)
    }
    const code = parseCode($app.querySelector('[data-field="code"]').value)
    if (!code) { roomError = 'That isn\'t a room code. It looks like XXXX-XXXX-XXXX.'; return togetherPage() }
    enterRoom(code)
  }
}

// Discord's "Watching …" for what plays, checked every 5 s (main.js passes Discord only what changed)
let nowPlaying = null
setInterval(() => {
  const p = player.current()
  window.native.discord(p && nowPlaying && load('discord', true) ? { ...nowPlaying, paused: p.video.paused, time: p.video.currentTime, duration: p.video.duration } : null)
}, 5000)

// ---- routing + shared clicks ----
// Leaving a page by a link: note how far down it was in its history entry, so Back returns to the same spot
document.addEventListener('click', e => {
  if (e.target.closest('a[href^="#/"]')) history.replaceState({ ...history.state, scroll: $app.scrollTop }, '')
}, true)
document.addEventListener('click', e => {
  const nope = e.target.closest('[data-nope]')
  if (nope) {
    e.preventDefault() // it sits on the card's link
    save('notInterested', [...load('notInterested', []), +nope.dataset.nope])
    return nope.closest('.card').remove()
  }
  const s = e.target.closest('[data-surprise]')
  if (s) return MORE[s.dataset.surprise][1]().then(list => { if (list.length) location.hash = `#/anime/${list[Math.floor(Math.random() * list.length)].id}` })
  const w = e.target.closest('[data-watch]')
  if (w) { const id = +w.dataset.watch; return media(id).then(m => sources(m, Math.min(progress()[id]?.episode ?? 1, epCount(m)))) } // fresh details: episode count may have changed
  const l = e.target.closest('[data-list]')
  if (l) { toggleList(+l.dataset.list); l.setAttribute('aria-pressed', l.classList.toggle('on')) }
})

async function route () {
  const [, name, id] = location.hash.split('/')
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (name || 'home')))
  $app.onclick = null
  $app.onchange = null
  $app.oncontextmenu = null
  // the old page stays until the new one is drawn, so a slow one (a show AniList can't give us) shows a loading bar;
  // only past a moment, so quick pages don't flash it. Home draws at once and its rows say they're loading.
  const nav = ++navigation
  const busy = name ? setTimeout(() => document.body.classList.add('navigating'), 250) : null
  try {
    if (name === 'search') await search()
    else if (name === 'anime') await detail(Number(id))
    else if (name === 'more') await morePage(id)
    else if (name === 'extensions') await extensionsPage()
    else if (name === 'settings') settingsPage()
    else if (name === 'history') await historyPage()
    else if (name === 'schedule') await schedulePage()
    else if (name === 'together') togetherPage()
    else if (name === 'downloads') downloadsPage()
    else await home()
    // only once the new page is drawn: resetting earlier jumped the old page to its top while the new one loaded
    const scroll = history.state?.scroll ?? 0
    $app.scrollTop = scroll
    if (scroll) setTimeout(() => { $app.scrollTop = scroll }) // again after a reopened tab's cards are drawn
  } catch (e) {
    $app.innerHTML = `<div class="page err">${esc(e.message)}</div>`
  } finally {
    clearTimeout(busy)
    if (nav === navigation) document.body.classList.remove('navigating') // a later click owns the bar now
  }
}
let navigation = 0
window.onhashchange = route

// Drag a row of cards sideways with the mouse; a drag doesn't count as a click on the card it ends on.
let drag = null
document.addEventListener('pointerdown', e => {
  const cards = e.pointerType === 'mouse' && e.button === 0 && e.target.closest('.cards')
  if (cards) drag = { cards, x: e.clientX, left: cards.scrollLeft, moved: false }
})
document.addEventListener('pointermove', e => {
  if (!drag) return
  const dx = e.clientX - drag.x
  if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; drag.cards.classList.add('dragging') }
  if (drag.moved) drag.cards.scrollLeft = drag.left - dx
})
document.addEventListener('pointerup', () => {
  if (!drag) return
  drag.cards.classList.remove('dragging')
  const moved = drag.moved
  setTimeout(() => { drag = null }) // after the click that follows pointerup
  if (!moved) drag = null
})
document.addEventListener('click', e => { if (drag?.moved) { e.preventDefault(); e.stopPropagation() } }, true)
// mouse back/forward buttons move through history; the full player is a history entry, so back docks it and forward restores it
document.addEventListener('mouseup', e => {
  if (e.button === 3) { e.preventDefault(); history.back() }
  if (e.button === 4) { e.preventDefault(); history.forward() }
})

// App updates (from GitHub releases): a section in Settings, and a notice in the corner once a new version is downloaded
let updateState = {}
let updateDismissed = false
function drawUpdate () {
  const u = updateState
  const el = document.querySelector('[data-updates]')
  if (el) {
    const text = { checking: 'Checking for updates…', downloading: `Downloading version ${u.version}…`, ready: `Version ${u.version} is downloaded.`, latest: 'You have the latest version.', error: `Couldn't check for updates: ${u.error}` }[u.status] ?? ''
    el.innerHTML = `<p class="muted">You have version ${esc(u.current ?? '')}. ${esc(text)}</p>
      <div class="actions">${u.status === 'ready' ? `<button class="btn" data-update-install>Restart to update</button>` : `<button class="btn ghost" data-update-check ${['checking', 'downloading'].includes(u.status) ? 'disabled' : ''}>Check for updates</button>`}</div>`
  }
  let toast = document.querySelector('.update-toast')
  if (u.status !== 'ready' || updateDismissed) return toast?.remove()
  if (!toast) {
    toast = document.createElement('div')
    toast.className = 'update-toast'
    toast.setAttribute('role', 'status')
    document.body.append(toast)
  }
  toast.innerHTML = `<span>Kotakbase ${esc(u.version)} is ready</span><button class="btn" data-update-install>Restart</button><button class="update-x" data-update-dismiss aria-label="Later" title="Later (installs when you quit)">✕</button>`
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-update-install]')) window.native.update.install()
  else if (e.target.closest('[data-update-check]')) window.native.update.check()
  else if (e.target.closest('[data-update-dismiss]')) { updateDismissed = true; drawUpdate() }
})
window.native.on('update', s => { updateState = { ...updateState, ...s }; drawUpdate() })
window.native.update.state().then(s => { updateState = { ...s, ...updateState, current: s.current }; drawUpdate() })

// First launch, after the extensions step: offer AniList sync, so a watch history kept there comes in straight away.
// Skippable; Settings has the same button for later. Not offered when this build can't sign in, or already has.
async function offerAniList () {
  if (!await sync.canOffer().catch(() => false)) return
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.innerHTML = `<div class="welcome" role="dialog" aria-labelledby="anilist-offer-title">
    <h2 id="anilist-offer-title">Sync with AniList</h2>
    <p>Sign in with your AniList account to bring in your watch history, and to keep your progress, Your List and ratings in sync both ways from now on.</p>
    <p class="muted">You can also do this any time in Settings.</p>
    <div class="err"></div>
    <div class="welcome-actions"><button class="btn ghost" data-skip>Skip for now</button><button class="btn" data-signin>Sign in with AniList</button></div>
  </div>`
  document.body.append(modal)
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = e => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  modal.onclick = async e => {
    if (e.target === modal || e.target.closest('[data-skip]')) return close()
    const b = e.target.closest('[data-signin]')
    if (!b) return
    b.disabled = true
    b.textContent = 'Waiting for AniList…'
    const r = await sync.signIn()
    if (r.ok) return close() // the first sync asks before changing anything
    b.disabled = false
    b.textContent = 'Sign in with AniList'
    modal.querySelector('.err').textContent = r.error
  }
  modal.querySelector('[data-signin]').focus()
}

// A yes/no question in the app's own popup instead of the native confirm() box; resolves true for OK.
// `body` is HTML, so callers escape anything that came from outside.
function ask (title, body, ok = 'OK', cancel = 'Cancel') {
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.innerHTML = `<div class="welcome" role="alertdialog" aria-modal="true" aria-labelledby="ask-title">
    <h2 id="ask-title">${esc(title)}</h2>${body}
    <div class="welcome-actions"><button class="btn ghost" data-answer="">${esc(cancel)}</button><button class="btn" data-answer="1">${esc(ok)}</button></div>
  </div>`
  document.body.append(modal)
  modal.querySelector('[data-answer="1"]').focus()
  return new Promise(resolve => {
    const done = yes => { modal.remove(); document.removeEventListener('keydown', onKey, true); resolve(yes) }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false) } }
    document.addEventListener('keydown', onKey, true)
    modal.onclick = e => {
      const b = e.target.closest('[data-answer]')
      if (b) done(!!b.dataset.answer)
      else if (e.target === modal) done(false)
    }
  })
}

// First launch only: Kotakbase ships no sources, so offer to add some straight away
function welcome () {
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.innerHTML = `<div class="welcome" role="dialog" aria-labelledby="welcome-title">
    <h2 id="welcome-title">Welcome to Kotakbase</h2>
    <p>Kotakbase finds episodes through extensions, and comes with none. Add at least one to start watching.</p>
    <p class="muted">Paste a Hayase extension link (https://…/index.json, gh:user/repo or npm:package). You can add or remove extensions any time under Extensions in the top bar.</p>
    <form class="add"><input placeholder="Extension link" aria-label="Extension link" required><button class="btn">Add</button></form>
    <div class="err"></div>
    <ul class="welcome-added"></ul>
    <div class="welcome-actions"><button class="btn ghost" data-skip>Skip for now</button></div>
  </div>`
  document.body.append(modal)
  const err = modal.querySelector('.err')
  const input = modal.querySelector('input')
  let added = 0
  const close = () => {
    modal.remove()
    document.removeEventListener('keydown', onKey)
    offerAniList() // the second step of the first launch
    if (!added) return
    // show what was installed
    if (location.hash === '#/extensions') route()
    else location.hash = '#/extensions'
  }
  const onKey = e => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  modal.onclick = e => { if (e.target === modal || e.target.closest('[data-skip]')) close() }
  // stays open after each link, so several can be added; Done closes it
  modal.querySelector('form').onsubmit = async e => {
    e.preventDefault()
    const add = e.target.querySelector('button')
    const before = new Set(Object.keys(ext.configs))
    add.disabled = true
    err.textContent = 'Installing…'
    try { await ext.importRepo(input.value); err.textContent = '' } catch (x) { err.textContent = x.message }
    add.disabled = false
    // a link can install some sources and still report others as already there, so list whatever is new either way
    const fresh = Object.values(ext.configs).filter(c => !before.has(c.id))
    if (!fresh.length) return
    added += fresh.length
    modal.querySelector('.welcome-added').insertAdjacentHTML('beforeend', fresh.map(c => `<li>✓ ${esc(c.name)}</li>`).join(''))
    modal.querySelector('[data-skip]').textContent = 'Done'
    input.value = ''
    input.placeholder = 'Another extension link (optional)'
    input.focus()
  }
  input.focus()
}
if (firstLaunch) welcome()
sync = createSync({ load, save, show: id => cache.get(id), native: window.native.anilist, onImported: route, ask })
sync.start()
route()
