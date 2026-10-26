// Every English string the app shows, as the translation files must cover it: the t('…') / tr('…') / tk('…') calls,
// index.html's marked text and labels, and the lists translated by value (genres, formats, filters, languages…).
// `node scripts/i18n-keys.mjs` prints them as JSON.
import fs from 'node:fs'
import { LANGS } from '../ui/lang.js'
import { EN } from '../ui/i18n.js'

const SOURCES = ['ui/app.js', 'ui/player.js', 'ui/anilist-sync.js', 'ui/extensions.js', 'ui/room.js', 'main.js', 'downloads.js', 'anilist-auth.js', 'discord.js']
// shown through t(variable): each must also appear in app.js, which i18n.test.js checks
export const DATA = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller', 'Hentai',
  'TV Series', 'TV Short', 'Movie', 'OVA', 'ONA', 'Special',
  'Releasing', 'Finished', 'Not yet released', 'Cancelled', 'On hiatus',
  'Winter', 'Spring', 'Summer', 'Fall',
  'Genre', 'Year', 'Season', 'Format', 'Status', 'Sort',
  'Airing', 'Not yet aired', 'Popularity', 'Score', 'Trending', 'Newest', 'Title',
  'high', 'medium', 'low',
  'Continue Watching', 'Removed from Continue Watching', 'Your List', 'Recommended For You', 'Trending Now', 'All Time Popular'
]

export function keys () {
  const out = new Set()
  const call = /\b(?:t|tr|tk)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
  for (const file of SOURCES) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(call)) out.add(m[2].replace(/\\(.)/g, '$1'))
  }
  const html = fs.readFileSync('ui/index.html', 'utf8')
  for (const m of html.matchAll(/data-t>([^<]+)</g)) out.add(m[1].trim())
  for (const m of html.matchAll(/(?:aria-label|title|placeholder)="([^"]+)"/g)) out.add(m[1])
  for (const k of DATA) out.add(k)
  for (const [name] of Object.values(LANGS)) out.add(name)
  for (const k of Object.keys(EN)) out.add(k)
  out.delete('Kotakbase')
  return [...out].sort()
}

if (process.argv[1]?.endsWith('i18n-keys.mjs')) console.log(JSON.stringify(keys(), null, 1))
