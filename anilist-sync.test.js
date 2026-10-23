import assert from 'node:assert/strict'
import test from 'node:test'
import { localEntry, toLocal, merge, pushTarget, saveVars, toStars, queue, dequeue, nextDelay, GAP } from './ui/anilist-sync.js'
import { parseRedirect, REDIRECT } from './anilist-auth.js'

const e = (status, progress, stars = 0) => ({ status, progress, stars })
const remote = (status, progress, score = 0) => ({ entryId: 9, status, progress, score })

test('localEntry: Kotakbase → AniList', () => {
  assert.equal(localEntry(undefined, false), null)
  assert.deepEqual(localEntry(undefined, true, 3), e('PLANNING', 0, 3)) // Your List, not started
  assert.deepEqual(localEntry({ episode: 5, time: 300, duration: 1400 }), e('CURRENT', 4)) // partway into 5: 4 fully watched
  assert.deepEqual(localEntry({ episode: 6, time: 0, duration: 1 }), e('CURRENT', 5)) // past 90% of 5 moves on to 6
  assert.deepEqual(localEntry({ episode: 12, time: 1300, duration: 1400 }), e('CURRENT', 12)) // last aired one watched, airing
  assert.deepEqual(localEntry({ episode: 12, time: 1, duration: 1, finished: true }, true, 5), e('COMPLETED', 12, 5))
  assert.deepEqual(localEntry({ episode: 6, time: 0, duration: 1, hidden: true }), e('DROPPED', 5)) // ✕ keeps progress
  // saved before the finished flag existed: done once the show has finished airing
  assert.deepEqual(localEntry({ episode: 12, time: 1, duration: 1 }, false, 0, { status: 'FINISHED', episodes: 12 }), e('COMPLETED', 12))
})

test('toLocal: AniList → Kotakbase, and back again unchanged', () => {
  assert.deepEqual(toLocal(e('CURRENT', 5)), { episode: 6, time: 0, duration: 1 })
  assert.deepEqual(toLocal(e('COMPLETED', 12)), { episode: 12, time: 1, duration: 1, finished: true })
  assert.deepEqual(toLocal(e('DROPPED', 3)), { episode: 4, time: 0, duration: 1, hidden: true })
  assert.deepEqual(toLocal(e('CURRENT', 12), undefined, 12), { episode: 12, time: 1, duration: 1, finished: false }) // every episode out watched
  // ...and it stays CURRENT once the show's details say it has finished airing, so nothing is sent for it
  assert.deepEqual(localEntry(toLocal(e('CURRENT', 12), undefined, 12), false, 0, { status: 'FINISHED', episodes: 12 }), e('CURRENT', 12))
  assert.deepEqual(toLocal(e('CURRENT', 5), { episode: 6, time: 200, duration: 1400 }), { episode: 6, time: 200, duration: 1400 }) // keeps the spot
  for (const x of [e('CURRENT', 5), e('COMPLETED', 12), e('DROPPED', 3), e('CURRENT', 0)]) assert.deepEqual(localEntry(toLocal(x)), { ...x, stars: 0 })
})

test('stars ⇄ score', () => {
  assert.deepEqual([0, 1, 20, 50, 69, 70, 100].map(toStars), [0, 1, 1, 3, 3, 4, 5])
  assert.equal(saveVars(1, e('CURRENT', 2, 4), remote('CURRENT', 1, 75)).scoreRaw, undefined) // 75 is already 4 stars: left alone
  assert.equal(saveVars(1, e('CURRENT', 2, 5), remote('CURRENT', 1, 75)).scoreRaw, 100)
  assert.equal(saveVars(1, e('CURRENT', 2, 0), remote('CURRENT', 1, 75)).scoreRaw, 0) // rating cleared
  assert.equal(saveVars(1, e('CURRENT', 2), remote('PAUSED', 1)).status, 'PAUSED') // AniList's own statuses stay
})

test('merge: never lowers progress, takes the side that changed', () => {
  assert.deepEqual(merge(e('CURRENT', 3), remote('CURRENT', 7), null), e('CURRENT', 7)) // further along on AniList
  assert.deepEqual(merge(e('CURRENT', 9), remote('CURRENT', 7), remote('CURRENT', 7)), e('CURRENT', 9))
  assert.deepEqual(merge(e('CURRENT', 9), remote('COMPLETED', 12), null), e('COMPLETED', 12))
  assert.deepEqual(merge(null, remote('PLANNING', 0, 80), null), e('PLANNING', 0, 4)) // imported
  assert.deepEqual(merge(e('CURRENT', 2), null, null), e('CURRENT', 2)) // sent
  // dropped on AniList's site, unchanged here: comes here (progress kept)
  assert.deepEqual(merge(e('CURRENT', 5), remote('DROPPED', 5), remote('CURRENT', 5)), e('DROPPED', 5))
  // restored here (↺) after being dropped: goes to AniList as CURRENT
  assert.deepEqual(merge(e('CURRENT', 5), remote('DROPPED', 5), remote('DROPPED', 5)), e('CURRENT', 5))
  // rated on AniList's site: comes here; rated here: kept
  assert.deepEqual(merge(e('CURRENT', 5, 2), remote('CURRENT', 5, 100), remote('CURRENT', 5, 40)), e('CURRENT', 5, 5))
  assert.deepEqual(merge(e('CURRENT', 5, 3), remote('CURRENT', 5, 40), remote('CURRENT', 5, 40)), e('CURRENT', 5, 3))
  // deleted on AniList and unchanged here, or taken off here and unchanged there: left alone, not recreated
  assert.equal(merge(e('CURRENT', 5), null, remote('CURRENT', 5)), null)
  assert.equal(merge(null, remote('PLANNING', 0), remote('PLANNING', 0)), null)
  // both sides moved to the same place: nothing to do either way
  assert.deepEqual(merge(e('CURRENT', 5), remote('CURRENT', 5), remote('CURRENT', 3)), e('CURRENT', 5))
})

test('pushTarget: what a change here sends', () => {
  assert.deepEqual(pushTarget(e('CURRENT', 6), remote('CURRENT', 5)), e('CURRENT', 6))
  assert.equal(pushTarget(e('CURRENT', 5), remote('CURRENT', 5)), null) // nothing changed (a progress save mid-episode)
  // replaying an earlier episode doesn't lower AniList, nor un-complete it
  assert.equal(pushTarget(e('CURRENT', 2), remote('CURRENT', 8)), null)
  assert.equal(pushTarget(e('CURRENT', 0), remote('COMPLETED', 12)), null)
  // ...but "Mark unwatched" does
  assert.deepEqual(pushTarget(e('CURRENT', 2), remote('CURRENT', 8), true), e('CURRENT', 2))
  // everything unmarked: kept on AniList as planned, progress 0, never deleted
  assert.deepEqual(pushTarget(null, remote('CURRENT', 8, 60), true), e('PLANNING', 0, 3))
  // removed from Continue Watching / put back
  assert.deepEqual(pushTarget(e('DROPPED', 5), remote('CURRENT', 5)), e('DROPPED', 5))
  assert.deepEqual(pushTarget(e('CURRENT', 5), remote('DROPPED', 5)), e('CURRENT', 5))
  // taken off Your List before starting: the only delete; a started show isn't touched
  assert.equal(pushTarget(null, remote('PLANNING', 0)), 'delete')
  assert.equal(pushTarget(null, remote('CURRENT', 3)), null)
  assert.deepEqual(pushTarget(e('PLANNING', 0), null), e('PLANNING', 0))
})

test('outbox: one item per show, a change during a send survives it', () => {
  let box = queue({}, 1)
  box = queue(box, 2)
  box = queue(box, 1, { unwatch: true })
  assert.deepEqual(Object.keys(box), ['1', '2'])
  assert.deepEqual(box[1], { unwatch: true, n: 2 })
  const sent = box[1]
  const during = queue(box, 1) // changed again while its request was out
  assert.ok(dequeue(during, '1', sent)[1])
  assert.equal(dequeue(box, '1', sent)[1], undefined)
})

test('outbox: pacing, Retry-After and backoff', () => {
  assert.equal(nextDelay(200, null, 0), GAP)
  assert.ok(GAP >= 60000 / 30) // within AniList's degraded limit of 30 a minute
  assert.equal(nextDelay(429, 12, 0), 12000)
  assert.equal(nextDelay(429, null, 0), 60000)
  assert.deepEqual([0, 1, 2, 3].map(f => nextDelay(503, null, f)), [5000, 10000, 20000, 40000])
  assert.equal(nextDelay(0, null, 20), 5 * 60 * 1000) // capped at 5 minutes
})

test('parseRedirect: the token from the redirect fragment', () => {
  const r = parseRedirect(`${REDIRECT}#access_token=abc.def&token_type=Bearer&expires_in=31536000`)
  assert.equal(r.token, 'abc.def')
  assert.ok(Math.abs(r.expires - (Date.now() + 31536000e3)) < 5000)
  assert.deepEqual(parseRedirect(`${REDIRECT}?error=access_denied&error_description=The+user+denied+the+request`), { error: 'The user denied the request' })
  assert.deepEqual(parseRedirect(`${REDIRECT}#error=access_denied`), { error: 'access_denied' })
  assert.equal(parseRedirect('https://anilist.co/api/v2/oauth/authorize?client_id=1'), null)
  assert.equal(parseRedirect(`${REDIRECT}x#access_token=a`), null)
  assert.equal(parseRedirect('https://evil.example/api/v2/oauth/pin#access_token=a'), null)
  assert.equal(parseRedirect('not a url'), null)
})
