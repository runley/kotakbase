import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanDescription, fetchRussian } from './ui/shikimori.js'

test('cleanDescription: Shikimori markup becomes plain text', () => {
  assert.equal(cleanDescription('Отряд героя [character=186854]Химмеля[/character] вернулся. [i]Конец[/i] [[Фрирен]]'), 'Отряд героя Химмеля вернулся. Конец Фрирен')
  assert.equal(cleanDescription('[spoiler=спойлер]тайна[/spoiler]'), 'тайна')
  assert.equal(cleanDescription(null), '')
})

test('fetchRussian: one request per 50 ids, keeps only shows with a Russian title', async () => {
  const bodies = []
  const fake = async (url, { body }) => {
    bodies.push(JSON.parse(body).query)
    return { json: async () => ({ data: { animes: [{ malId: '1', russian: 'Ковбой Бибоп', description: '[i]Космос[/i]' }, { malId: '2', russian: '', description: '' }] } }) }
  }
  const ids = Array.from({ length: 60 }, (_, i) => i + 1)
  const got = await fetchRussian(ids, fake)
  assert.equal(bodies.length, 2)
  assert.match(bodies[0], /ids: "1,2,3/)
  assert.match(bodies[0], /censored: false/)
  assert.deepEqual(got.get('1'), { title: 'Ковбой Бибоп', description: 'Космос' })
  assert.ok(!got.has('2'))
})
