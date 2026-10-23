// Languages offered in settings, keyed by ISO 639-2 (what MKV tracks use), with the 639-1 and alt codes that also show up in files.
export const LANGS = {
  jpn: ['Japanese', 'ja'],
  eng: ['English', 'en'],
  spa: ['Spanish', 'es'],
  por: ['Portuguese', 'pt'],
  fre: ['French', 'fr', 'fra'],
  ger: ['German', 'de', 'deu'],
  ita: ['Italian', 'it'],
  rus: ['Russian', 'ru'],
  ara: ['Arabic', 'ar'],
  chi: ['Chinese', 'zh', 'zho'],
  kor: ['Korean', 'ko'],
  hin: ['Hindi', 'hi'],
  ind: ['Indonesian', 'id'],
  may: ['Malay', 'ms', 'msa'],
  tha: ['Thai', 'th'],
  vie: ['Vietnamese', 'vi'],
  pol: ['Polish', 'pl'],
  tur: ['Turkish', 'tr'],
  dut: ['Dutch', 'nl', 'nld'],
  swe: ['Swedish', 'sv']
}

// Which settings language a track is in, from its language code (e.g. "eng", "en-US") or, failing that, its name (e.g. "English subs").
export function langOf (track) {
  const code = (track.language ?? '').toLowerCase().split(/[-_]/)[0]
  for (const [key, [name, ...alts]] of Object.entries(LANGS)) {
    if (code && (code === key || alts.includes(code))) return key
    // underscores count as spaces: "CR_English" is a word boundary away from "English"
    if (!code && new RegExp(`\\b${name}\\b`, 'i').test((track.name ?? track.label ?? '').replaceAll('_', ' '))) return key
  }
  return null
}

// "Signs & Songs" in the subtitle priority list: a track with only on-screen text and lyrics translated
export const SIGNS = 'signs'
const isSigns = t => /\b(signs?|songs?)\b/i.test(t.name ?? t.label ?? '')

// The subtitle track to turn on, or null for off. Walks the priority list; for a language it takes that language's
// top full track (releases name tracks every which way, but put the default first), or its Signs & Songs track if
// that's all there is; SIGNS takes a Signs & Songs track. Nothing listed in the file: a Signs & Songs track if there
// is one, else off. An empty list means always off. A track with no language tag is English: the MKV rule.
export function pickSubTrack (tracks, prefs) {
  if (!prefs.length) return null
  const lang = t => langOf(t) ?? (t.language ? null : 'eng')
  for (const pref of prefs) {
    const found = pref === SIGNS ? tracks.filter(isSigns) : tracks.filter(t => lang(t) === pref)
    const full = pref === SIGNS ? found : found.filter(t => !isSigns(t))
    if (found.length) return full[0] ?? found[0]
  }
  return tracks.find(isSigns) ?? null
}

// mpv's track-list entries ({ id, type, lang, title, … }) of one type ('audio' or 'sub'), in the shape pickTrack,
// pickSubTrack and the track menus read (number is mpv's aid/sid)
export const fromMpv = (list, type) => list.filter(t => t.type === type).map(t => ({ number: t.id, language: t.lang, name: t.title, codec: t.codec, selected: t.selected }))

// Index of the track matching the highest-priority preferred language, or -1.
export function pickTrack (tracks, prefs) {
  for (const pref of prefs) {
    const i = tracks.findIndex(t => langOf(t) === pref)
    if (i !== -1) return i
  }
  return -1
}
