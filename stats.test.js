import assert from 'node:assert/strict'
import test from 'node:test'
import { crowd, habits } from './ui/stats.js'

const entry = (id, score, averageScore, popularity = 100000) => ({ score, media: { id, averageScore, popularity } })

test('crowd: average distance from AniList, hidden gems, the most over- and under-rated', () => {
  const c = crowd([{ entries: [entry(1, 90, 70, 20000), entry(2, 40, 70), entry(3, 80, 80), entry(4, 0, 60), entry(1, 90, 70, 20000)] }])
  assert.equal(c.diff, (20 - 30 + 0) / 3) // unscored and repeated entries don't count
  assert.equal(c.gems, 1)
  assert.deepEqual(c.rows.map(r => r.media.id), [1, 2])
  assert.equal(crowd([{ entries: [entry(1, 0, 70)] }]), null)
})

test('habits: 26 weeks of days, streak, peak hour and weekday, biggest binge', () => {
  const now = new Date(2026, 9, 30, 20).getTime() // a Friday
  const at = (d, h) => new Date(2026, 9, d, h).getTime()
  const h = habits([
    { id: 7, at: at(27, 23) }, { id: 7, at: at(28, 23) }, { id: 7, at: at(28, 23) }, { id: 7, at: at(28, 22) },
    { id: 9, at: at(29, 23) }, { id: 9, at: at(20, 10) }
  ], now)
  assert.equal(h.days.length, 25 * 7 + 6) // full weeks back to a Sunday, then Sunday to Friday
  assert.equal(h.days.at(-3), 3) // the 28th
  assert.equal(h.episodes, 6)
  assert.equal(h.streak, 3) // 27, 28, 29
  assert.equal(h.hour, 23)
  assert.equal(h.weekday, 3) // Wednesday the 28th
  assert.deepEqual(h.binge, { id: 7, n: 3 })
  assert.equal(habits([], now).hour, null)
})
