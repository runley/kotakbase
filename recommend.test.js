import assert from 'node:assert/strict'
import test from 'node:test'
import { rank, diverse, taste, vectors } from './ui/recommend.js'

const show = (id, genres, tags, extra = {}) => ({ id, genres, tags: tags.map(name => ({ name, rank: 80 })), ...extra })
// two tastes: a mecha war show and a slow romance
const mecha = show(1, ['Mecha', 'Action'], ['Robots', 'War', 'Military'])
const romance = show(2, ['Romance', 'Slice of Life'], ['Love Triangle', 'School', 'Iyashikei'])
const mechaLike = show(10, ['Mecha', 'Action'], ['Robots', 'Military', 'Space'])
const romanceLike = show(11, ['Romance', 'Drama'], ['Love Triangle', 'School'])
const neither = show(12, ['Sports'], ['Basketball', 'Teams'])
const sequel = show(13, ['Mecha', 'Action'], ['Robots', 'War', 'Military'], { related: [1] })
const sequel2 = show(14, ['Mecha', 'Action'], ['Robots', 'War', 'Military'], { related: [13] })

test('taste: your score weighs a show', () => {
  assert.deepEqual([100, 0, 40, 20].map(taste), [3, 1, 0, -1])
})

test('vectors: unit length, spoiler tags left out', () => {
  const v = vectors([mecha, romance, show(3, ['Mecha'], ['Robots'], { tags: [{ name: 'Twist', rank: 90, isMediaSpoiler: true }] })])
  assert.ok(Math.abs(Math.hypot(...v.get(1).values()) - 1) < 1e-9)
  assert.ok(!v.get(3).has('t:Twist'))
})

test('rank: each candidate near the show it is like; separate tastes stay separate', () => {
  const r = rank([mecha, romance], [mechaLike, romanceLike, neither])
  assert.deepEqual(r.map(x => [x.m.id, x.because]).sort(), [[10, 1], [11, 2]]) // nothing in common: not recommended
})

test('rank: started shows and their whole franchise are skipped', () => {
  const r = rank([mecha], [sequel2, sequel, mechaLike, mecha], { seen: [1] })
  assert.deepEqual(r.map(x => x.m.id), [10])
})

test('rank: one show per franchise among the candidates', () => {
  const part2 = show(15, ['Mecha', 'Action'], ['Robots', 'Military', 'Space'], { related: [10] })
  assert.deepEqual(rank([mecha], [mechaLike, part2]).map(x => x.m.id).length, 1)
})

test('rank: a show you scored low counts against shows like it', () => {
  const scores = { 1: 15, 2: 95 }
  const r = rank([mecha, romance], [mechaLike, romanceLike], { scores })
  assert.deepEqual(r.map(x => x.m.id), [11])
})

test('diverse: the best two near each show first', () => {
  const r = [1, 1, 1, 2].map((because, i) => ({ because, i }))
  assert.deepEqual(diverse(r).map(x => x.i), [0, 1, 3, 2])
})
