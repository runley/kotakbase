// Hayase-compatible extension manager: same manifest JSON, same gh:/npm:/http URL rules, same source API.
import { t } from './i18n.js'
const load = (key, def) => { try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def } }
const save = (key, val) => localStorage.setItem(key, JSON.stringify(val))

export const configs = load('extensions', {}) // id -> manifest entry
const codes = load('extensions-code', {}) // id -> js source
export const settings = load('extensions-options', {}) // id -> { enabled, options }
const workers = new Map()

const persist = () => { save('extensions', configs); save('extensions-code', codes); save('extensions-options', settings) }
const after = url => url.slice(url.indexOf(':') + 1)

// gh:user/repo[/path] and npm:pkg[/path] resolve through esm.sh, exactly like Hayase
function jsonUrl (url) {
  if (url.startsWith('http')) return url
  if (!/^(gh|npm):/.test(url)) throw new Error(t('Invalid URL'))
  const u = `https://esm.sh${url.startsWith('gh:') ? '/gh' : ''}/${after(url)}`
  return u.endsWith('.json') ? u : `${u}/index.json`
}

function jsUrl (url) {
  if (url.startsWith('http')) return url
  const parts = after(url).split('/')
  if (url.startsWith('gh:')) return `https://esm.sh/gh/${parts[0]}/${parts[1]}/es2022/${parts.slice(2).join('/')}.mjs`
  if (url.startsWith('npm:')) return `https://esm.sh/${parts[0]}/es2022/${parts.slice(1).join('/')}.mjs`
  throw new Error(t('Invalid URL'))
}

const REQUIRED = ['name', 'version', 'id', 'type', 'accuracy', 'icon', 'update', 'code']
const valid = c => c && typeof c === 'object' && REQUIRED.every(k => k in c)

async function fetchManifest (url) {
  const res = await fetch(jsonUrl(url.trim().replace(/\/+$/, '')))
  if (!res.ok) throw new Error(t('Manifest request failed ({status})', { status: res.status }))
  return [].concat(await res.json())
}

function startWorker (id, code) {
  workers.get(id)?.terminate()
  const w = new Worker(new URL('./ext-worker.js', import.meta.url), { type: 'module', name: id })
  let n = 0
  const pending = new Map()
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id)
    pending.delete(data.id)
    data.err ? p?.reject(new Error(data.err)) : p?.resolve(data.res)
  }
  w.call = (fn, ...args) => new Promise((resolve, reject) => {
    pending.set(++n, { resolve, reject })
    w.postMessage({ id: n, fn, args })
  })
  workers.set(id, w)
  return w.call('load', code).then(() => w)
}

const timeout = (p, ms, msg) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))])

async function install (config) {
  const res = await fetch(jsUrl(config.code))
  if (!res.ok) throw new Error(`${config.id}: code request failed (${res.status})`)
  const code = await res.text()
  const w = await startWorker(config.id, code)
  timeout(w.call('test'), 5000, 'test timed out').catch(e => console.warn(`Extension ${config.id} test failed:`, e.message))
  configs[config.id] = config
  codes[config.id] = code
  settings[config.id] ??= { enabled: true, options: {} }
}

// User pastes a manifest URL (same links that work in Hayase).
export async function importRepo (url) {
  const list = await fetchManifest(url)
  if (!list.every(valid)) throw new Error(t('Not a valid Hayase extension manifest'))
  const skipped = list.filter(c => configs[c.id]).map(c => c.id)
  for (const c of list.filter(c => !configs[c.id])) await install(c)
  persist()
  if (skipped.length) throw new Error(t('Already installed, delete first to replace: {names}', { names: skipped.join(', ') }))
}

export function remove (id) {
  workers.get(id)?.terminate()
  workers.delete(id)
  delete configs[id]
  delete codes[id]
  delete settings[id]
  persist()
}

export function setEnabled (id, enabled) { settings[id].enabled = enabled; persist() }
export function setOption (id, key, value) { settings[id].options[key] = value; persist() }

// On startup: boot saved extensions, then pull new versions from each manifest's update URL.
export const ready = (async () => {
  // older versions shipped Nyaa built in; it's an ordinary extension now
  for (const c of Object.values(configs)) if (c.builtin) { delete configs[c.id]; delete settings[c.id] }
  await Promise.allSettled(Object.values(configs).map(c => startWorker(c.id, codes[c.id])))
  const updates = [...new Set(Object.values(configs).map(c => c.update).filter(Boolean))]
  const lists = await Promise.allSettled(updates.map(fetchManifest))
  for (const c of lists.flatMap(r => r.value ?? [])) {
    const old = configs[c.id]
    if (valid(c) && old && old.update === c.update && old.version !== c.version) await install(c).catch(e => console.warn(e))
  }
  persist()
})()

const RANK = { high: 0, medium: 1, low: 2 }

// torrents with no seeders can't stream, so they sink below everything else
const rank = results => results.sort((a, b) => (b.seeders > 0) - (a.seeders > 0) || RANK[a.accuracy] - RANK[b.accuracy] || (b.type === 'best') - (a.type === 'best') || b.seeders - a.seeders)

// Ask every enabled torrent extension for sources; same query shape Hayase sends. onUpdate(results, errors) runs as
// each extension answers, so the first sources show without waiting for the slowest; the final list is returned.
export async function search (query, { movie, batch }, onUpdate) {
  await ready
  const errors = []
  const byHash = new Map()
  const jobs = []
  for (const [id, w] of workers) {
    const c = configs[id]
    if (c?.type !== 'torrent' || !settings[id]?.enabled) continue
    const defaults = Object.fromEntries(Object.entries(c.options ?? {}).map(([k, o]) => [k, o.default]))
    const opts = { ...defaults, ...settings[id].options }
    for (const fn of ['single', movie && 'movie', batch && 'batch'].filter(Boolean)) {
      jobs.push(timeout(w.call(fn, query, opts), 30000, 'timed out').then(results => {
        for (const r of results) {
          const prev = byHash.get(r.hash)
          // the same torrent from several extensions often comes with differently formatted names; keep them all
          if (prev) {
            prev.extensions.add(id)
            prev.seeders = Math.max(prev.seeders, r.seeders)
            prev.titles.add(r.title)
            // keep "batch"/"best" even if the first extension to answer didn't mark it; Seadex's "best" outranks other labels
            prev.type = r.type === 'best' ? 'best' : prev.type ?? r.type
          } else byHash.set(r.hash, { ...r, extensions: new Set([id]), titles: new Set([r.title]) })
        }
      // a site that's down answers with an HTML error page, which the extension then fails to read as JSON
      }, e => errors.push(`${c.name} (${fn}): ${/not valid JSON|Unexpected token '<'/.test(e.message) ? t("the site sent an error page instead of results (it's probably down; try again later)") : e.message}`)).then(() => onUpdate?.(rank([...byHash.values()]), errors)))
    }
  }
  if (!jobs.length) throw new Error(t('No torrent extensions enabled. Add one in Extensions.'))
  await Promise.all(jobs)
  const results = [...byHash.values()]
  // some extensions (Seadex) send no seeder counts; ask the trackers, as Hayase does, so those results aren't shown as dead
  const unknown = results.filter(r => !r.seeders).map(r => r.hash)
  if (unknown.length) {
    const counts = await window.native.scrape(unknown).catch(() => ({}))
    for (const r of results) {
      const c = counts[r.hash]
      if (c) Object.assign(r, { seeders: c.seeders, leechers: c.leechers, downloads: Math.max(r.downloads, c.downloads) })
    }
  }
  return { results: rank(results), errors }
}
