// The app in the user's language. t('English text') gives the translation (the English text is the key, so a missing
// translation shows English); {name} placeholders are filled in, and plural forms are picked by the language's own
// rules from vars.n. Languages live in ui/locales/<code>.js; English plurals in the EN table below.
export const LANGUAGES = {
  en: 'English',
  uk: 'Українська',
  kk: 'Қазақша',
  ru: 'Русский',
  de: 'Deutsch',
  es: 'Español',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語'
}

// English plural forms (everything else in English is the key itself)
export const EN = {
  '{n} episodes': { one: '{n} episode', other: '{n} episodes' },
  '{n} shows': { one: '{n} show', other: '{n} shows' },
  '{n} people in the room': { one: '{n} person in the room', other: '{n} people in the room' },
  '{n} episodes downloaded': { one: '{n} episode downloaded', other: '{n} episodes downloaded' },
  '{n} seeders': { one: '{n} seeder', other: '{n} seeders' },
  '{n} peers': { one: '{n} peer', other: '{n} peers' },
  '{n} stars': { one: '{n} star', other: '{n} stars' },
  '{n} changes waiting': { one: '{n} change waiting', other: '{n} changes waiting' },
  "{n} changes haven't reached AniList yet and will be dropped.": { one: "{n} change hasn't reached AniList yet and will be dropped.", other: "{n} changes haven't reached AniList yet and will be dropped." }
}

// The language to use: the one picked in Settings, else the first of the system's languages Kotakbase has
export function pickLanguage (saved, system = []) {
  if (saved && LANGUAGES[saved]) return saved
  for (const l of system) {
    const tag = String(l).toLowerCase()
    if (tag.startsWith('zh')) return /hant|tw|hk|mo/.test(tag) ? 'zh-TW' : 'zh-CN'
    const base = tag.split('-')[0]
    if (LANGUAGES[base]) return base
  }
  return 'en'
}

let lang = 'en'
let dict = {}
let plurals = new Intl.PluralRules('en')

export async function setLanguage (code) {
  lang = LANGUAGES[code] ? code : 'en'
  dict = lang === 'en' ? {} : (await import(`./locales/${lang}.js`).catch(() => ({ default: {} }))).default
  plurals = new Intl.PluralRules(lang)
}
export const language = () => lang
export const useLanguage = (code, table) => { lang = code; dict = table; plurals = new Intl.PluralRules(code) } // for tests

export function t (text, vars = {}) {
  let s = dict[text] ?? EN[text] ?? text
  if (typeof s === 'object') s = s[plurals.select(vars.n ?? 0)] ?? s.other ?? text
  return s.replace(/\{(\w+)\}/g, (all, k) => vars[k] ?? all)
}
