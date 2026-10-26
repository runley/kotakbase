import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { t, pickLanguage, useLanguage, LANGUAGES, EN } from './ui/i18n.js'
import { keys, DATA } from './scripts/i18n-keys.mjs'

test('pickLanguage: the saved choice, else the first system language Kotakbase has', () => {
  assert.equal(pickLanguage('de', ['uk-UA']), 'de')
  assert.equal(pickLanguage(null, ['fr-FR', 'uk-UA', 'en-US']), 'uk')
  assert.equal(pickLanguage(null, ['zh-HK']), 'zh-TW')
  assert.equal(pickLanguage(null, ['zh-Hant-TW']), 'zh-TW')
  assert.equal(pickLanguage(null, ['zh-CN']), 'zh-CN')
  assert.equal(pickLanguage(null, ['zh']), 'zh-CN')
  assert.equal(pickLanguage(null, ['kk-KZ']), 'kk')
  assert.equal(pickLanguage('xx', ['fr']), 'en')
})

test('t: placeholders, English plurals, and a language with several plural forms', () => {
  useLanguage('en', {})
  assert.equal(t('Episode {n}', { n: 4 }), 'Episode 4')
  assert.equal(t('{n} episodes', { n: 1 }), '1 episode')
  assert.equal(t('{n} episodes', { n: 12 }), '12 episodes')
  assert.equal(t('Not translated'), 'Not translated')
  useLanguage('ru', { '{n} episodes': { one: '{n} серия', few: '{n} серии', many: '{n} серий', other: '{n} серии' } })
  assert.equal(t('{n} episodes', { n: 1 }), '1 серия')
  assert.equal(t('{n} episodes', { n: 3 }), '3 серии')
  assert.equal(t('{n} episodes', { n: 11 }), '11 серий')
  assert.equal(t('Missing here'), 'Missing here') // falls back to English
  useLanguage('en', {})
})

test('keys: the lists translated by value are really in the code', () => {
  const src = fs.readFileSync('ui/app.js', 'utf8')
  const external = ['Hentai', 'high', 'medium', 'low'] // AniList's genres and the extensions' accuracy levels
  for (const k of DATA) assert.ok(src.includes(`'${k}'`) || external.includes(k), k)
  assert.ok(keys().length > 300)
})

// each translation file: every string, the same {placeholders}, plural forms the language uses, and nothing that would
// break the HTML it goes into (quotes in attributes, stray tags)
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join()
const tags = s => [...String(s).matchAll(/<[^>]+>/g)].map(m => m[0]).sort().join()
for (const code of Object.keys(LANGUAGES).filter(c => c !== 'en')) {
  test(`locale ${code}: complete and safe`, async () => {
    const { default: dict } = await import(`./ui/locales/${code}.js`)
    const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories
    const missing = keys().filter(k => !(k in dict))
    assert.deepEqual(missing, [], `${code} is missing ${missing.length} strings`)
    for (const [k, v] of Object.entries(dict)) {
      const values = typeof v === 'object' ? Object.entries(v) : [['', v]]
      if (typeof v === 'object') {
        assert.ok('other' in v, `${code} "${k}": a plural needs "other"`)
        for (const f of Object.keys(v)) assert.ok(forms.includes(f), `${code} "${k}": "${f}" isn't a plural form of ${code}`)
      }
      for (const [, s] of values) {
        assert.equal(typeof s, 'string', `${code} "${k}"`)
        assert.ok(s.trim(), `${code} "${k}" is empty`)
        assert.equal(placeholders(s), placeholders(typeof EN[k] === 'object' ? EN[k].other : k), `${code} "${k}": placeholders`)
        assert.equal(tags(s), tags(k), `${code} "${k}": HTML tags`)
        assert.ok(!/"/.test(s.replace(/<[^>]+>/g, '')), `${code} "${k}": no straight double quotes`)
      }
    }
  })
}
