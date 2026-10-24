import assert from 'node:assert/strict'
import test from 'node:test'
import { toActivity } from './discord.js'

const now = { title: 'Frieren', episode: 12, total: 28, cover: 'https://img/c.jpg', paused: false, time: 60, duration: 1440 }

test('toActivity: "Watching Frieren", the episode, the cover and a progress bar', () => {
  const a = toActivity(now)
  assert.equal(a.type, 3)
  assert.equal(a.status_display_type, 2)
  assert.equal(a.details, 'Frieren')
  assert.equal(a.state, 'Episode 12 / 28')
  assert.equal(a.assets.large_image, 'https://img/c.jpg')
  assert.equal(a.timestamps.end - a.timestamps.start, 1440 * 1000)
  assert.ok(Math.abs(a.timestamps.start - (Date.now() - 60_000)) < 1000)
})

test('toActivity: paused has no progress bar; a movie; short titles padded to Discord minimum; nothing playing', () => {
  assert.equal(toActivity({ ...now, paused: true }).timestamps, undefined)
  assert.equal(toActivity({ ...now, total: 1 }).state, 'Movie')
  assert.equal(toActivity({ ...now, title: 'K' }).details.length, 2)
  assert.equal(toActivity({ ...now, title: 'x'.repeat(300) }).details.length, 128)
  assert.equal(toActivity(null), null)
})
