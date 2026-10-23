import { LANGS } from './lang.js'

// Pull the release group and quality tags out of a torrent title.
const TAGS = [
  [/\b(2160|1080|720|540|480)p\b/i, m => `${m[1]}p`, 'res'],
  [/\b(HEVC|x265|H\.?265)\b/i, () => 'HEVC', 'codec'],
  [/\bAV1\b/i, () => 'AV1', 'codec'],
  [/\b10.?bit\b/i, () => '10 Bit', 'codec'],
  [/\bAAC/i, () => 'AAC', 'audio'],
  [/\bFLAC\b/i, () => 'FLAC', 'audio'],
  [/\bOpus\b/i, () => 'Opus', 'audio'],
  // Dolby Digital Plus: "DDP2.0", "DDP5.1", "DD+", "EAC3", "E-AC-3"
  [/\b(?:DDP|E-?AC-?3)(?=\d|\b)|\bDD\+/i, () => 'DDP', 'audio'],
  // "Dual Audio", "Dual-Audio", or just "DUAL" as in "WEB-DL.DUAL.AAC2.0"
  [/\bDual(?:[\s._-]?Audio)?\b/i, () => 'Dual Audio', 'audio'],
  // "Multi Audio", "Multi-Audio", or a bare "MULTi" (several audio languages); never the "Multi" of "Multi-Subs"
  [/\bMulti(?:[\s._-]?Audio)?\b(?![\s._-]?Sub)/i, () => 'Multi Audio', 'audio'],
  [/\bMulti(?:ple)?[\s._-]?Sub(?:s|titles?)?\b/i, () => 'Multi Subs', 'audio']
]

// Audio languages (ISO 639-2, as in Settings) a release's names imply. `dub` = an extension that only returns dubs
// found it. Dual/Multi audio = Japanese + English; "<Language> Dub" / "<Language> Audio" = that language; a dub that
// names no language = English; anything else = Japanese, the norm for anime releases.
export function audioLanguages (titles, dub = false) {
  const langs = new Set()
  for (const raw of titles) {
    const t = raw.replace(/[._]/g, ' ')
    const labels = parseRelease(raw).tags.map(x => x.label)
    if (labels.includes('Dual Audio') || labels.includes('Multi Audio')) { langs.add('jpn'); langs.add('eng') }
    for (const [code, [name]] of Object.entries(LANGS)) {
      if (new RegExp(`\\b${name}[\\s-]*(dub(bed)?|audio)\\b|\\b(dub|audio)[\\s:(-]*${name}\\b`, 'i').test(t)) langs.add(code)
    }
    // scene style: the audio language's code right before the audio format, "WEB-DL.JPN.AAC2.0", "ENG.DDP5.1"
    for (const [code, [, ...alts]] of Object.entries(LANGS)) {
      const codes = [code, ...alts.filter(a => a.length === 3)].join('|')
      if (new RegExp(`\\b(${codes})[\\s-]+(AAC|DDP|E-?AC-?3|AC-?3|FLAC|OPUS|DTS|MP3)`, 'i').test(t)) langs.add(code)
    }
    if (/\beng[\s-]*dub(bed)?\b/i.test(t)) langs.add('eng')
    if (/\bdub(bed)?\b/i.test(t) && ![...langs].some(l => l !== 'jpn')) langs.add('eng')
  }
  if (dub) langs.add('eng')
  if (!langs.size) langs.add('jpn')
  return langs
}

// Audio Kotakbase's player (Chromium) can't decode: Dolby (AC3, E-AC3/DDP, TrueHD) and DTS. A release whose names give
// only these plays silently; one that also names a playable format (AAC, FLAC, Opus, MP3) has a track that works.
const DOLBY_DTS = /\b(?:DDP|E-?AC-?3|AC-?3|TrueHD|DTS)(?=\d|\b)|\bDD\+|\bDD[257][\s.]\d/i
const PLAYABLE_AUDIO = /\b(?:AAC|FLAC|Opus|MP3|Vorbis)/i
export const unplayableAudio = titles => {
  const names = titles.map(t => t.replace(/[._]/g, ' '))
  return names.some(t => DOLBY_DTS.test(t)) && !names.some(t => PLAYABLE_AUDIO.test(t))
}

// Languages Crunchyroll-style "Multi Subs" releases usually carry besides English (the name doesn't list them)
export const MULTI_SUBS = ['spa', 'por', 'fre', 'ger', 'ita', 'rus', 'ara']
// Subtitle languages a release's names state (ISO 639-2, as in Settings); empty when they say nothing. Read from:
// Erai-style code lists ("[ENG][POR-BR][SPA-LA]"), "<Language> Subs", "ESub", "SUBFRENCH"/"VOSTFR", "PT-BR", and
// Chinese markers (CHS/CHT/BIG5, 简/繁/中字). "Multi Subs" counts as English; see MULTI_SUBS for the rest.
export function subLanguages (titles) {
  const langs = new Set()
  for (const raw of titles) {
    const t = raw.replace(/[._]/g, ' ')
    if (parseRelease(raw).tags.some(x => x.label === 'Multi Subs')) langs.add('eng')
    const codes = [...raw.matchAll(/\[([A-Z]{3})(?:-[A-Z]{2})?\]/g)].map(m => m[1].toLowerCase())
    for (const [code, [name, ...alts]] of Object.entries(LANGS)) {
      if (codes.length >= 2 && (codes.includes(code) || alts.some(a => codes.includes(a)))) langs.add(code)
      if (new RegExp(`\\b${name}[\\s-]*sub(s|bed|titles?)?\\b|\\bsub(s|titles?)?[\\s:(-]*${name}\\b`, 'i').test(t)) langs.add(code)
    }
    if (/\b(e|eng)[\s-]?subs?\b/i.test(t)) langs.add('eng')
    if (/\bsubfrench\b|\bvostfr\b/i.test(t)) langs.add('fre')
    if (/\bpt-br\b|\blegendado\b/i.test(t)) langs.add('por')
    if (/\b(chs|cht|big5)\b|[简繁]|中字|中文字幕/i.test(t)) langs.add('chi')
  }
  return langs
}

// Sort results by your language priority lists: audio first or subtitles first (Settings), then the other, keeping the
// incoming order (seeders, accuracy, …) between equals. A release with no seeders stays below every live one.
// `audioOf` / `subsOf` give a result's languages; a language missing from a list ranks after every listed one.
// `multiOf` says whether a result is "Multi Subs": the languages that usually means count, but half a step below a
// release that names them (e.g. PT-BR above Multi Subs for Portuguese).
export function rankByLanguage (results, { audio, subs, first = 'audio' }, audioOf, subsOf, multiOf = () => false) {
  const rank = (langs, prefs) => { const i = prefs.findIndex(p => langs.has(p)); return i === -1 ? prefs.length : i }
  const subRank = r => {
    const stated = rank(subsOf(r), subs)
    const guessed = multiOf(r) ? rank(new Set(MULTI_SUBS), subs) + 0.5 : Infinity
    return Math.min(stated, guessed)
  }
  const keyed = results.map((r, i) => {
    const a = rank(audioOf(r), audio)
    const s = subRank(r)
    return { r, i, k: first === 'subs' ? [s, a] : [a, s] }
  })
  keyed.sort((x, y) => (y.r.seeders > 0) - (x.r.seeders > 0) || x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.i - y.i)
  return keyed.map(x => x.r)
}

// Auto Select on language-ranked results: the first with enough seeders to stream (under `minSeeders` counts as
// unusable, so the next-best language gets its turn); none usable → the top result rather than nothing
export const pickAuto = (ranked, minSeeders = 5) => ranked.find(r => r.seeders >= minSeeders) ?? ranked[0]

// Tags from every copy of a release's name (extensions format the same torrent's name differently), without repeats.
export function releaseTags (titles) {
  const seen = new Map()
  for (const t of titles) for (const tag of parseRelease(t).tags) if (!seen.has(tag.label)) seen.set(tag.label, tag)
  return [...seen.values()]
}

export function parseRelease (title) {
  // "[Group] Name ...", "Name ...-GROUP" (maybe followed by "(...)" / "[...]" notes or an extension), or "Name ... [Group]"
  const tail = title.replace(/(\s*(\([^)]*\)|\[[^\]]*\]))+\s*$/, '').replace(/\.(mkv|mp4)$/i, '')
  // "-DL" of "WEB-DL" etc. is a source tag, not a group
  const suffix = tail.match(/-([A-Za-z][A-Za-z0-9]*)$/)?.[1]?.replace(/^(DL|Rip|Raws?|Subs?|Dub|Audio)$/i, '') || undefined
  const last = title.match(/\[([^\]]+)\]\s*$/)?.[1]
  const lastIsGroup = last && !/^[0-9A-F]{8}$/i.test(last) && !/\d{3,4}p|\b(eng|jap|jpn|multi|sub|dub|batch|web|bd|hevc|x26[45]|aac|flac|\d+bit)\b|\//i.test(last)
  const group = title.match(/^\s*\[([^\]]+)\]/)?.[1] ?? (lastIsGroup ? last : suffix) ?? ''
  const tags = []
  for (const [re, label, kind] of TAGS) {
    const m = title.match(re)
    if (m) tags.push({ label: label(m), kind })
  }
  return { group, tags }
}

// ---- is a release for this show, or another entry of its franchise? ----
// The seasons a release names ("S02", "S02E05", "Season 2", "2nd Season"), or []. A pack names all it holds: "S01-S03",
// "Season 1-3", "Season 1+2", "S1 + OAD + S2". An episode's own SxxEyy decides alone, whatever its notes mention.
// (extensions keep their own copy: they are self-contained.)
export const seasonsNamed = title => {
  const t = title.replace(/[._]/g, ' ')
  const episode = t.match(/\bs(\d{1,2})e\d+/i)
  if (episode) return [Number(episode[1])]
  const seasons = new Set()
  for (const m of t.matchAll(/\b(?:s(\d{1,2})(?:p\d+)?(?:\s*[-~]\s*s(\d{1,2}))?|seasons?\s*(\d{1,2})(?:\s*[-~]\s*(\d{1,2}))?((?:\s*[+&]\s*\d{1,2}\b)*)|(\d{1,2})(?:st|nd|rd|th)\s+season)\b/gi)) {
    const from = Number(m[1] ?? m[3] ?? m[6]); const to = Number(m[2] ?? m[4] ?? from)
    for (let s = from; s <= to; s++) seasons.add(s)
    for (const n of m[5]?.match(/\d+/g) ?? []) seasons.add(Number(n))
  }
  return [...seasons]
}
const words = t => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
// words that say nothing about which entry it is
const GENERIC = new Set(['season', 'part', 'cour', 'movie', 'film', 'gekijouban', 'gekijoban', 'eiga', 'the', 'no', 'of', 'a', 'an', 'to', 'wa', 'ga', 'wo', 'ni', 'de', 'and', 'ova', 'oad', 'ona', 'special', 'specials', 'tv', 'series', 'final', 'ii', 'iii', 'iv', 'v'])
// For each other entry's title, the words this show's titles don't have ("Tensura Nikki" for The Slime Diaries when this
// is Slime season 1). Entries that differ only by season/part numbers give nothing; the season check handles those.
export function otherEntryWords (ownTitles, otherTitles) {
  const own = new Set(ownTitles.flatMap(words))
  return otherTitles.map(t => [...new Set(words(t))].filter(w => !own.has(w) && !GENERIC.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w)))
    .filter(ws => ws.join('').length >= 4)
}
// Keep a release unless its names put it in another season (when this show's is known) or another entry of the franchise
export function forThisEntry (titles, { seasons = [], others = [] }) {
  const known = seasons.filter(Boolean)
  const named = titles.flatMap(seasonsNamed)
  if (known.length && named.length && !named.some(s => known.includes(s))) return false
  const all = titles.map(t => new Set(words(t)))
  return !others.some(ws => all.some(set => ws.every(w => set.has(w))))
}

// Season and part/cour numbers an entry's own titles mention: "2nd Season Part 2", "Season 2", "Cour 2", "... 2".
export function entryNumbers (titles) {
  let season = null
  let part = null
  for (const t of titles) {
    season ??= Number(t.match(/(\d+)(?:st|nd|rd|th)\s+season/i)?.[1] ?? t.match(/\bseason\s*0?(\d+)/i)?.[1] ?? t.match(/\s(\d)\s*$/)?.[1]) || null
    part ??= Number(t.match(/(\d+)(?:st|nd|rd|th)\s+(?:part|cour)/i)?.[1] ?? t.match(/\b(?:part|cour)\s*0?(\d+)/i)?.[1]) || null
  }
  return { season, part }
}
