import assert from 'node:assert/strict'
import test from 'node:test'
import { pickSeries, chapterRows, titlesOf } from './ui/manga.js'
import { cleanSeries, cleanChapters, cleanPages } from './ui/ext-clean.js'

const m = { id: 30013, title: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' }, synonyms: ['OP'] }

test('titlesOf: every AniList name once', () => {
  assert.deepEqual(titlesOf(m), ['ONE PIECE', 'One Piece', 'OP'])
})

test('pickSeries: the AniList id, else an exact title, never a guess', () => {
  const a = { id: 'a', title: 'One Piece: Ace Story', anilistId: 1 }
  const b = { id: 'b', title: 'one-piece', anilistId: null }
  const c = { id: 'c', title: 'Whatever', anilistId: 30013 }
  assert.equal(pickSeries(m, [a, b, c]), c)
  assert.equal(pickSeries(m, [a, b]), b)
  assert.equal(pickSeries(m, [a]), null)
  assert.equal(pickSeries(m, [{ ...b, anilistId: 2 }]), null) // names another AniList entry: not this one
})

test('chapterRows: one per number, preferred language, oneshots last', () => {
  const ch = (id, number, lang, date = null) => ({ id, number, lang, date, title: '', group: '' })
  const rows = chapterRows([ch('2es', 2, 'es'), ch('1en', 1, 'en'), ch('1pt', 1, 'pt-br'), ch('x', null, 'en'), ch('1.5en', 1.5, 'en'),
    ch('2en-old', 2, 'en', new Date(1)), ch('2en-new', 2, 'en', new Date(2))], ['pt', 'en'])
  assert.deepEqual(rows.map(r => r.id), ['1pt', '1.5en', '2en-new', 'x'])
  assert.deepEqual(chapterRows([ch('a', 1, 'fr')], ['en']).map(r => r.id), ['a']) // nothing in your languages: show what there is
})

test('manga extension output: only well-formed results get through', () => {
  assert.deepEqual(cleanSeries([{ id: 5, title: 'X', cover: 'http://no', anilistId: 1.5 }, { title: 'no id' }, null]),
    [{ id: '5', title: 'X', cover: '', anilistId: null }])
  assert.deepEqual(cleanChapters([{ id: 'c', number: -1, lang: 'EN', date: 'x', mirror: 'yes' }]), [{ id: 'c', number: null, title: '', group: '', lang: 'en', date: null, mirror: false }])
  assert.deepEqual(cleanPages(['https://a/1.png', 'javascript:alert(1)', 5]), ['https://a/1.png'])
  assert.deepEqual(cleanPages('nope'), [])
})

test('chapterRows: a mirror copy gives way to the group upload when asked, never to a better language', () => {
  const c = (id, lang, date, mirror = false) => ({ id, number: 1, lang, date: new Date(date), mirror })
  const list = [c('own', 'en', '2024-01-01'), c('copy', 'en', '2025-01-01', true), c('es', 'es', '2026-01-01')]
  assert.equal(chapterRows(list, ['en', 'es'])[0].id, 'copy') // newest by default
  assert.equal(chapterRows(list, ['en', 'es'], true)[0].id, 'own')
  assert.equal(chapterRows([c('copy', 'en', '2025-01-01', true), c('es', 'es', '2026-01-01')], ['en', 'es'], true)[0].id, 'copy')
})
