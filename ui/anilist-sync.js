// AniList sync, only while signed in: Kotakbase's progress, Your List and ratings ⇄ the user's AniList anime list.
// Signed out, none of this runs. The token lives in the main process (anilist-auth.js); this side maps, merges and
// queues. The pure helpers are exported for the tests.
//
// An entry here is { status, progress, stars }: AniList's status (PAUSED and REPEATING count as CURRENT), episodes
// fully watched, and 0-5 stars (AniList's 0-100 score / 20).

import { t, language } from './i18n.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
export const toStars = score => score ? Math.min(5, Math.max(1, Math.round(score / 20))) : 0
const norm = status => status === 'PAUSED' || status === 'REPEATING' ? 'CURRENT' : status
// an AniList entry as saved: { entryId, status, progress, score }
const view = r => r ? { status: norm(r.status), progress: r.progress ?? 0, stars: toStars(r.score) } : null
export const same = (a, b) => !a === !b && (!a || (a.status === b.status && a.progress === b.progress && a.stars === b.stars))

// Kotakbase's state of one show as an entry; null when it has none. `show` (its details, if known) catches entries
// saved before the `finished` flag existed, like the app's isFinished.
export function localEntry (p, inList, stars = 0, show) {
  if (!p) return inList ? { status: 'PLANNING', progress: 0, stars } : null
  const ended = p.time >= (p.duration || 1) * 0.9 // its episode is watched too (the last one: the entry stays on it)
  // finished: false = imported from AniList as CURRENT with every episode watched, which stays CURRENT there
  const finished = p.finished ?? (show?.status === 'FINISHED' && show.episodes && p.episode >= show.episodes && ended)
  return { status: finished ? 'COMPLETED' : p.hidden ? 'DROPPED' : 'CURRENT', progress: ended ? p.episode : p.episode - 1, stars }
}

// What Kotakbase saves for an entry that came from AniList (not PLANNING: that's Your List). `p` is the progress entry
// already here; `episodes` the show's episode count, if known.
export function toLocal (e, p, episodes) {
  const caughtUp = e.status === 'COMPLETED' || (episodes && e.progress >= episodes)
  const entry = caughtUp ? { episode: Math.max(1, e.progress), time: 1, duration: 1 } : { episode: e.progress + 1, time: 0, duration: 1 }
  if (!caughtUp && p?.episode === entry.episode) Object.assign(entry, { time: p.time, duration: p.duration }) // keep the spot in it
  entry.finished = e.status === 'COMPLETED' || (caughtUp ? false : undefined)
  if (entry.finished === undefined) delete entry.finished
  if (e.status === 'DROPPED') entry.hidden = true
  return entry
}

// Pulling: what one show should become on both sides, from Kotakbase's entry, AniList's and AniList's as last synced
// (base); null = leave both alone. Progress: the further side, never lowered. Status and stars: whichever side changed
// since the last sync (so a drop or score changed on AniList's site comes here, and one made here goes there); with
// no base, or both changed, the side further along (status) or here (stars).
export function merge (L, remote, base) {
  const R = view(remote)
  const B = view(base)
  if (!R) return L && !same(L, B) ? L : null // not on AniList: send it, unless it was deleted there and is unchanged here
  if (!L) return same(R, B) ? null : R // not here: take it, unless it was taken off here and is unchanged there
  const pick = (k, tie) => L[k] === R[k] ? L[k] : B && R[k] === B[k] ? L[k] : B && L[k] === B[k] ? R[k] : tie
  const progress = Math.max(L.progress, R.progress)
  let status = pick('status', (R.progress > L.progress ? R : L).status)
  if (status === 'PLANNING' && progress) status = 'CURRENT'
  return { status, progress, stars: pick('stars', L.stars || R.stars) }
}

// Pushing one show Kotakbase changed: the entry to save on AniList, 'delete', or null (nothing to send). Progress is
// never lowered, and COMPLETED stays (replaying an earlier episode), except by an explicit "Mark unwatched" (unwatch).
// live: AniList's entry right now (it may have moved on the site since base); status and stars unchanged here keep it.
export function pushTarget (L, base, unwatch = false, live = base) {
  const B = view(base)
  const R = view(live)
  let T
  if (!L) {
    if (!R) return null
    if (unwatch) T = { status: 'PLANNING', progress: 0, stars: R.stars } // every episode unmarked: kept as planned, never deleted
    else return R.status === 'PLANNING' ? 'delete' : null // taken off Your List before starting it: the only delete
  } else if (!R || unwatch) T = L
  else {
    const keep = k => B && L[k] === B[k] ? R[k] : L[k]
    T = { status: keep('status'), progress: Math.max(L.progress, R.progress), stars: keep('stars') }
    if (R.status === 'COMPLETED' && T.status === 'CURRENT') T.status = 'COMPLETED'
    if (T.status === 'PLANNING' && T.progress) T.status = 'CURRENT'
  }
  return same(T, R) ? null : T
}

// SaveMediaListEntry's arguments: PAUSED / REPEATING on AniList stay as they are; the score is sent only when the stars
// changed, so a 75 set on AniList isn't rounded to 80
export function saveVars (mediaId, T, base) {
  const v = { mediaId, status: T.status === 'CURRENT' && norm(base?.status) === 'CURRENT' ? base.status : T.status, progress: T.progress }
  if (T.stars !== toStars(base?.score)) v.scoreRaw = T.stars * 20
  return v
}

// ---- outbox: shows with changes to send, persisted; one item per show, sent with the show's latest state ----
// n counts changes, so a change made while that show's request is out isn't dropped when the request returns
export const queue = (box, id, flags) => ({ ...box, [id]: { ...box[id], ...flags, n: (box[id]?.n ?? 0) + 1 } })
export const dequeue = (box, id, sent) => { if (box[id]?.n !== sent.n) return box; const { [id]: _, ...rest } = box; return rest }
export const GAP = 2000 // between requests: 30 a minute, inside AniList's limit even when it's degraded to 30
// how long to wait after a request with this status; fails = failures in a row so far (backoff while AniList is down)
export function nextDelay (status, retryAfter, fails) {
  if (status === 429) return Math.min(60, retryAfter || 60) * 1000
  if (status === 0 || status >= 500) return Math.min(5 * 60 * 1000, 5000 * 2 ** fails)
  return GAP
}

const LIST_QUERY = `query($userId: Int) { MediaListCollection(userId: $userId, type: ANIME) { lists { entries {
  id mediaId status progress score(format: POINT_100) updatedAt media { episodes isAdult } } } } }`
const ENTRY_FIELDS = 'id mediaId status progress score(format: POINT_100)'
const TYPES = { mediaId: 'Int', status: 'MediaListStatus', progress: 'Int', scoreRaw: 'Int' }
const fromApi = e => ({ entryId: e.id, status: e.status, progress: e.progress ?? 0, score: e.score ?? 0 })

// load/save: the app's; show(id): its cached details; native: window.native.anilist; onImported: redraw after a pull
export function createSync ({ load, save, show, native, onImported, ask }) {
  const BASE = 'anilistBase' // { user, at, entries: { mediaId: AniList's entry as last synced } }
  const OUTBOX = 'anilistOutbox'
  let account = null
  let lastLocal = new Map() // id → JSON of its entry, to see which shows a save changed
  let applying = false
  let running = false
  let fails = 0
  let problem = '' // why the outbox is waiting
  let note = '' // the first sync's summary
  const listeners = new Set()
  const notify = () => listeners.forEach(f => f())

  const base = () => load(BASE, null)
  const signedIn = () => !!account?.user && !account.expired
  const active = () => signedIn() && base()?.user === account.user.id // signed in and the first sync is done
  const pending = () => Object.keys(load(OUTBOX, {})).length

  function locals () {
    const progress = load('progress', {})
    const list = new Set(load('list', []))
    const ratings = load('ratings', {})
    const ids = new Set([...Object.keys(progress), ...Object.keys(ratings)].map(Number).concat([...list]))
    return new Map([...ids].map(id => [id, localEntry(progress[id], list.has(id), ratings[id] ?? 0, show(id))]))
  }
  const snapshot = now => { lastLocal = new Map([...now].map(([id, e]) => [id, JSON.stringify(e)])) }

  function enqueue (id, flags = {}) {
    save(OUTBOX, queue(load(OUTBOX, {}), id, flags))
    notify()
    pump()
  }

  // the app saved progress, list or ratings: queue the shows whose entry changed (the player saves every few seconds,
  // but an entry changes only when an episode passes 90%)
  function changed () {
    if (!active() || applying) return
    const now = locals()
    for (const id of new Set([...now.keys(), ...lastLocal.keys()])) if (JSON.stringify(now.get(id) ?? null) !== (lastLocal.get(id) ?? 'null')) enqueue(id)
    snapshot(now)
  }
  // "Mark unwatched": the one change allowed to lower AniList's progress; called before the app saves it
  function unwatch (id) { if (active()) enqueue(id, { unwatch: true }) }

  async function sendOne (id, item) {
    const b = base()
    const old = b.entries[id]
    const L = locals().get(id) ?? null
    if (!pushTarget(L, old, item.unwatch)) return { status: 200, skipped: true }
    // the base is from the last pull, maybe days ago: target AniList's entry as it is now (none: 404)
    let r = await native.query(`query($userId: Int, $mediaId: Int) { MediaList(userId: $userId, mediaId: $mediaId) { ${ENTRY_FIELDS} } }`, { userId: b.user, mediaId: id })
    if (r.status !== 200 && r.status !== 404) return r
    const live = r.status === 200 && r.data?.MediaList ? fromApi(r.data.MediaList) : null
    const T = pushTarget(L, old, item.unwatch, live)
    if (!T) return { status: 200 }
    await new Promise(resolve => setTimeout(resolve, GAP))
    if (T === 'delete') {
      r = await native.query('mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }', { id: live.entryId })
      if (r.status === 200 || r.status === 404) { delete b.entries[id]; r.status = 200 }
    } else {
      const v = saveVars(id, T, live)
      const args = Object.keys(v)
      r = await native.query(`mutation(${args.map(k => `$${k}: ${TYPES[k]}`).join(', ')}) { SaveMediaListEntry(${args.map(k => `${k}: $${k}`).join(', ')}) { ${ENTRY_FIELDS} } }`, v)
      if (r.status === 200) b.entries[id] = fromApi(r.data.SaveMediaListEntry)
    }
    if (r.status === 200) save(BASE, { ...b, at: Date.now() })
    return r
  }

  // Sends the outbox one show at a time, paced; never awaited by the app
  async function pump () {
    if (running) return
    running = true
    try {
      while (active()) {
        const box = load(OUTBOX, {})
        const id = Object.keys(box)[0]
        if (!id) break
        const r = await sendOne(Number(id), box[id])
        if (r.status === 401) { account = await native.account(); break }
        const failed = r.status === 0 || r.status === 429 || r.status >= 500
        // anything else (sent, or refused, e.g. a show AniList no longer has) leaves the queue
        if (!failed) save(OUTBOX, dequeue(load(OUTBOX, {}), id, box[id]))
        problem = !failed ? '' : r.status === 429 ? t('AniList is busy, waiting a moment') : t('AniList unreachable')
        if (r.status >= 400 && !failed) console.warn('AniList refused a change:', r.error)
        notify()
        const wait = r.skipped ? 0 : nextDelay(r.status, r.retryAfter, fails)
        fails = !failed ? 0 : r.status === 429 ? fails : fails + 1
        await new Promise(resolve => setTimeout(resolve, wait))
      }
    } finally {
      running = false
      notify()
    }
  }

  // Pulls the whole list and merges it (the first time after asking); throws if AniList can't be reached
  async function pull () {
    const first = !active()
    const r = await native.query(LIST_QUERY, { userId: account.user.id })
    if (r.status === 401) { account = await native.account(); notify(); return }
    if (r.status !== 200) throw new Error(r.status === 0 ? t('AniList unreachable') : `AniList: ${r.error || r.status}`)
    const remote = new Map()
    for (const e of r.data.MediaListCollection.lists.flatMap(l => l.entries)) if (!e.media?.isAdult) remote.set(e.mediaId, e) // custom lists repeat entries
    const old = first ? {} : base().entries
    const box = first ? {} : load(OUTBOX, {})
    const local = locals()
    const imports = []
    const sends = []
    for (const id of new Set([...local.keys(), ...remote.keys()])) {
      if (box[id]) continue // a change here is still waiting to be sent: it's newer
      const L = local.get(id) ?? null
      const T = merge(L, remote.get(id) && fromApi(remote.get(id)), old[id])
      if (!T) continue
      if (!same(L, T)) imports.push([id, T])
      if (!same(view(remote.get(id) && fromApi(remote.get(id))), T)) sends.push(id)
    }
    const shows = n => `<b>${t('{n} shows', { n })}</b>`
    if (first && (imports.length || sends.length) && !await ask(t('First AniList sync for {name}', { name: account.user.name }),
      `<ul class="ask-list"><li>${t('{shows} from AniList go into Kotakbase', { shows: shows(imports.length) })}</li><li>${t('{shows} from Kotakbase go to your AniList list', { shows: shows(sends.length) })}</li></ul>
      <p class="muted">${t('Progress is never lowered on either side. Cancel signs you out and changes nothing.')}</p>`, t('Sync'), t('Cancel'))) {
      account = await native.signOut()
      notify()
      return
    }
    // AniList as it is now; an entry deleted on AniList and unchanged here keeps its old copy, so it isn't sent back
    const entries = Object.fromEntries([...remote].map(([id, e]) => [id, fromApi(e)]))
    for (const id in old) if (!remote.has(+id) && local.get(+id) && !sends.includes(+id)) entries[id] = old[id]
    save(BASE, { user: account.user.id, at: Date.now(), entries })
    if (imports.length) apply(imports, remote)
    snapshot(locals())
    if (first) {
      save(OUTBOX, {})
      note = t('Imported {imported}, sending {sent} to AniList.', { imported: t('{n} shows', { n: imports.length }), sent: sends.length })
    }
    sends.forEach(id => enqueue(id))
    if (imports.length) onImported?.()
    notify()
  }

  function apply (imports, remote) {
    const progress = load('progress', {})
    const list = load('list', [])
    const ratings = load('ratings', {})
    for (const [id, T] of imports) {
      const L = localEntry(progress[id], list.includes(id), ratings[id] ?? 0, show(id))
      if (T.status === 'PLANNING') { if (!list.includes(id)) list.push(id) } else if (!L || L.status !== T.status || L.progress !== T.progress) {
        const e = remote.get(id)
        progress[id] = { ...toLocal(T, progress[id], e?.media?.episodes ?? show(id)?.episodes), at: Math.max(progress[id]?.at ?? 0, (e?.updatedAt ?? 0) * 1000) || Date.now() }
      }
      if (T.stars) ratings[id] = T.stars
      else delete ratings[id]
    }
    applying = true
    try { save('progress', progress); save('list', list); save('ratings', ratings) } finally { applying = false }
  }

  let syncing = null
  const syncNow = () => {
    // pump: changes left waiting (by a 401, say) go out once AniList answers again
    syncing ??= pull().then(() => { if (!pending()) problem = ''; pump() }, e => { problem = e.message }).finally(() => { syncing = null; notify() })
    notify()
    return syncing
  }

  async function start () {
    account = await native.account()
    notify() // Settings may be open already
    if (!active()) return
    snapshot(locals())
    pump()
    setTimeout(syncNow, 5000) // after the home rows' own AniList requests
  }

  const ago = at => {
    const m = Math.round((Date.now() - at) / 60000)
    const rtf = new Intl.RelativeTimeFormat(language(), { numeric: 'auto' })
    return m < 1 ? t('just now') : m < 60 ? rtf.format(-m, 'minute') : m < 1440 ? rtf.format(-Math.round(m / 60), 'hour') : new Date(at).toLocaleDateString(language())
  }
  function statusText () {
    const n = pending()
    if (syncing) return t('Syncing…')
    if (n) return `${t('{n} changes waiting', { n })}, ${problem || t('sending…')}`
    if (problem) return t("Couldn't sync: {error}", { error: problem })
    return base()?.at ? t('Synced: {when}', { when: ago(base().at) }) : ''
  }

  // Settings → AniList, drawn into `el`; redrawn while it's on screen
  // AniList's sign-in window, then the first sync; { ok } or { ok: false, error } ('' when the window was just closed)
  async function signIn () {
    const r = await native.signIn()
    if (r.error != null || !r.user) return { ok: false, error: r.error ?? '' }
    // a different account than last time: its list is merged afresh
    if (base()?.user !== r.user.id) { save(BASE, null); save(OUTBOX, {}) }
    account = r
    syncNow()
    return { ok: true }
  }
  // can this build sign in (it has a client id), and isn't it signed in already?
  const canOffer = async () => { const a = await native.account(); return a.configured !== false && !a.user }

  function settings (el) {
    let error = ''
    const draw = () => {
      if (!el.isConnected) return listeners.delete(draw)
      const a = account
      const user = a?.user && `<img class="anilist-avatar" src="${esc(a.user.avatar)}" alt=""><b>${esc(a.user.name)}</b>`
      el.innerHTML = !a ? '' : !a.configured
        ? `<p class="muted">${t("AniList sync isn't set up in this build (no AniList Client ID).")}</p>`
        : !a.user
            ? `<p class="muted">${t('Keep your progress, Your List and ratings in sync with your AniList list. Kotakbase only changes the entries of shows you watch, list or rate here.')}</p>
              <div class="actions"><button class="btn" data-anilist-signin>${t('Sign in with AniList')}</button></div>`
            : a.expired
              ? `<div class="actions anilist-user">${user}</div><p class="err">${t('Your AniList sign-in expired or was revoked, so nothing is being synced.')}</p>
                <div class="actions"><button class="btn" data-anilist-signin>${t('Sign in again')}</button><button class="btn ghost" data-anilist-signout>${t('Sign out')}</button></div>`
              : `<div class="actions anilist-user">${user}<span class="muted">${esc(statusText())}</span></div>
                ${note ? `<p class="muted">${esc(note)}</p>` : ''}
                <div class="actions"><button class="btn ghost" data-anilist-sync ${syncing ? 'disabled' : ''}>${t('Sync now')}</button><button class="btn ghost" data-anilist-signout>${t('Sign out')}</button></div>`
      if (error) el.insertAdjacentHTML('beforeend', `<p class="err">${esc(error)}</p>`)
    }
    listeners.add(draw)
    el.onclick = async e => {
      if (e.target.closest('[data-anilist-signin]')) {
        error = ''
        const r = await signIn()
        if (!r.ok) { error = r.error; draw() }
        return
      }
      if (e.target.closest('[data-anilist-sync]')) return syncNow()
      if (e.target.closest('[data-anilist-signout]')) {
        const n = pending()
        if (n && !await ask(t('Sign out of AniList?'), `<p>${t("{n} changes haven't reached AniList yet and will be dropped.", { n })}</p>`, t('Sign out'))) return
        account = await native.signOut()
        save(BASE, null)
        save(OUTBOX, {})
        note = problem = ''
        notify()
      }
    }
    draw()
    const tick = setInterval(() => el.isConnected ? draw() : clearInterval(tick), 30000) // "Synced 2 min ago" moves on
  }

  return { start, changed, unwatch, settings, syncNow, signIn, canOffer }
}
