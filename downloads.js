// Downloads for watching offline. Unlike streams (throwaway, deleted when the player closes), these go to a folder
// that's kept (Videos\Kotakbase by default) and are listed in downloads.json. One entry per torrent, holding the
// episodes picked from it; a torrent stops (no more uploading) once its episodes are complete, and unfinished ones
// carry on when Kotakbase starts again.
import fs from 'node:fs'
import path from 'node:path'
import { findEpisode, pickFile, VIDEO, RISKY } from './episode.js'

// Which files of a torrent to download: one file asked for by index, one episode (the best match), or for several
// episodes (a season pack) each one found by its number. [] when nothing matches.
export function chooseFiles (files, { fileIndex, episodes }) {
  if (fileIndex != null) return files[fileIndex] && VIDEO.test(files[fileIndex].name) ? [{ file: files[fileIndex], episode: episodes[0]?.episode ?? null }] : []
  const found = episodes.length === 1
    ? [{ file: pickFile(files, episodes[0].episode, episodes[0].numbering), episode: episodes[0].episode }]
    : episodes.map(e => ({ file: findEpisode(files, e.episode, e.numbering), episode: e.episode }))
  const seen = new Set()
  return found.filter(f => f.file && VIDEO.test(f.file.name) && !seen.has(f.file) && seen.add(f.file))
}

// A file's place on disk, refusing any path that would land outside the download folder (names come from torrents)
export function inside (dir, rel) {
  if (!dir || !path.isAbsolute(dir)) return null
  const full = path.resolve(dir, rel)
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null
}

export function createDownloads ({ client, store, defaultDir, trackers, isPlaying, onChange }) {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(store, 'utf8')) } catch {}
  // { id (info hash), mediaId, title, cover, magnet, dir, status: 'active' | 'paused' | 'done' | 'error', error,
  //   files: [{ index, episode, name, path, length, have }] }
  const items = Array.isArray(saved.items) ? saved.items : []
  let dir = typeof saved.dir === 'string' && path.isAbsolute(saved.dir) ? saved.dir : defaultDir
  const torrents = new Map() // id -> torrent, while downloading
  const waiting = [] // requests for a torrent the player is streaming: they start when it stops

  const save = () => {
    const tmp = store + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ dir, items }, null, 1))
    fs.renameSync(tmp, store)
  }
  const owns = t => [...torrents.values()].includes(t)
  // client.remove returns before the torrent has closed its files, and Windows won't delete an open file
  const drop = t => new Promise(resolve => client.remove(t, {}, () => resolve()).catch(() => resolve()))
  const rm = p => { if (p) try { fs.rmSync(p, { force: true }) } catch (e) { console.warn('Could not delete', p, e.message) } }

  const snapshot = () => items.map(it => {
    const t = torrents.get(it.id)
    return {
      id: it.id, mediaId: it.mediaId, title: it.title, cover: it.cover, magnet: it.magnet, status: waiting.some(w => w.id === it.id) ? 'waiting' : it.status, error: it.error,
      speed: t?.downloadSpeed ?? 0, peers: t?.numPeers ?? 0,
      files: it.files.map(f => {
        const tf = t?.files[f.index]
        const have = tf ? tf.downloaded : f.have
        return { index: f.index, episode: f.episode, name: f.name, length: f.length, have, done: have >= f.length, missing: it.status === 'done' && f.missing }
      })
    }
  })
  let timer = null
  const changed = () => {
    onChange(snapshot())
    // progress every second while anything downloads
    if (torrents.size && !timer) timer = setInterval(() => { if (!torrents.size) { clearInterval(timer); timer = null } onChange(snapshot()) }, 1000)
  }
  const remember = it => { const t = torrents.get(it.id); if (t) for (const f of it.files) f.have = t.files[f.index]?.downloaded ?? f.have }

  function addTorrent (link, at) {
    return new Promise((resolve, reject) => {
      const t = client.add(link, { path: at, deselect: true, announce: trackers })
      t.once('ready', () => resolve(t))
      t.once('error', reject)
    })
  }

  // Downloading an entry's files: select them, and stop the torrent once they're all there
  function run (it, t) {
    torrents.set(it.id, t)
    for (const f of it.files) t.files[f.index].select()
    const check = () => {
      if (!it.files.every(f => t.files[f.index].done)) return
      remember(it)
      it.status = 'done'
      it.error = null
      save()
      release(it.id)
      changed()
    }
    t.on('done', check)
    t.on('error', e => { it.status = 'error'; it.error = e.message; save(); changed() })
    check()
    changed()
  }

  // done or paused: drop the torrent (keeping the files), unless the player is reading from it right now
  async function release (id) {
    const t = torrents.get(id)
    if (!t || isPlaying(t)) return
    torrents.delete(id)
    const it = items.find(i => i.id === id)
    // pieces at the edges of wanted files also write into their neighbours: those partial files go too (listed first,
    // since a removed torrent forgets its files)
    const keep = new Set(it?.files.map(f => f.index))
    const extra = it?.status === 'done' ? t.files.filter((f, i) => !keep.has(i)).map(f => inside(it.dir, f.path)) : []
    await drop(t)
    extra.forEach(rm)
    if (extra.length) removeEmpty(it)
  }
  const removeEmpty = it => {
    for (const f of it.files) {
      let d = path.dirname(inside(it.dir, f.path) ?? it.dir)
      while (d.startsWith(path.resolve(it.dir) + path.sep)) { try { fs.rmdirSync(d) } catch { break } d = path.dirname(d) }
    }
  }

  async function start (it) {
    it.status = 'active'
    it.error = null
    try {
      run(it, await addTorrent(it.magnet, it.dir))
    } catch (e) {
      it.status = 'error'
      it.error = e.message
      changed()
    }
  }

  async function add (spec) {
    const streaming = await client.get(spec.link)
    if (streaming && !owns(streaming)) {
      // the player has this torrent open (with its own throwaway folder): start once the player lets go of it
      waiting.push({ ...spec, id: streaming.infoHash })
      changed()
      return { waiting: true }
    }
    let t = streaming ?? await addTorrent(spec.link, dir)
    const ours = !streaming
    let it = items.find(i => i.id === t.infoHash)
    // more episodes of a torrent downloaded before into another folder: back to that folder (nothing is selected yet)
    if (ours && it && path.resolve(it.dir) !== path.resolve(dir)) { await drop(t); t = await addTorrent(spec.link, it.dir) }
    const fail = async message => { if (ours) await client.remove(t, { destroyStore: true }); throw new Error(message) }
    const risky = t.files.filter(f => RISKY.test(f.name)).map(f => f.name)
    if (risky.length) await fail(`This torrent contains program files (${risky.slice(0, 3).join(', ')}), a common sign of a fake or malware, so it won't be downloaded. Pick another source.`)
    const picked = chooseFiles(t.files, spec)
    if (!picked.length) await fail(spec.episodes.length > 1 ? "None of this show's episodes were found in this torrent. Pick another source." : "There's no video for this episode in this torrent. Pick another source.")
    if (!it) {
      it = { id: t.infoHash, mediaId: spec.mediaId, title: spec.title, cover: spec.cover, magnet: t.magnetURI, dir, status: 'active', files: [] }
      items.push(it)
    }
    for (const { file, episode } of picked) {
      if (it.files.some(f => f.index === t.files.indexOf(file))) continue
      it.files.push({ index: t.files.indexOf(file), episode, name: file.name, path: file.path, length: file.length, have: 0 })
    }
    it.files.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
    it.status = 'active'
    save()
    if (torrents.get(it.id) === t) { for (const f of it.files) t.files[f.index].select(); changed() } // already downloading: just the new ones too
    else run(it, t)
    return { episodes: picked.length }
  }

  return {
    owns,
    list: snapshot,
    get dir () { return dir },
    setDir (d) { if (path.isAbsolute(d)) { dir = d; save() } },
    add,
    async pause (id) {
      const it = items.find(i => i.id === id)
      if (!it || it.status !== 'active') return
      remember(it)
      it.status = 'paused'
      save()
      await release(id)
      changed()
    },
    async resume (id) {
      const it = items.find(i => i.id === id)
      if (!it || !['paused', 'error'].includes(it.status)) return
      await start(it)
      save()
    },
    // one episode (index) or the whole entry, files included
    async remove (id, index) {
      const it = items.find(i => i.id === id)
      if (!it) return
      const gone = index == null ? it.files : it.files.filter(f => f.index === index)
      const wasActive = it.status === 'active'
      // Windows keeps a downloading file locked: stop the torrent first, then delete
      const t = torrents.get(id)
      if (t) { torrents.delete(id); await drop(t) }
      for (const f of gone) rm(inside(it.dir, f.path))
      removeEmpty(it)
      it.files = it.files.filter(f => !gone.includes(f))
      if (!it.files.length) items.splice(items.indexOf(it), 1)
      else if (wasActive) await start(it)
      save()
      changed()
    },
    // a downloaded episode as a file the player can read, like a torrent file
    local (id, index) {
      const it = items.find(i => i.id === id)
      const f = it?.files.find(x => x.index === index)
      const full = f && inside(it.dir, f.path)
      if (!full || !fs.existsSync(full) || fs.statSync(full).size !== f.length || !(it.status === 'done' || torrents.get(id)?.files[index].done)) return null
      return { name: f.name, length: f.length, full, createReadStream: ({ start, end } = {}) => fs.createReadStream(full, { start, end }) }
    },
    // the player stopped: finished torrents it was reading from can go, and waiting downloads can start
    async idle () {
      for (const it of items) if (it.status === 'done' && torrents.has(it.id)) await release(it.id)
      for (const w of waiting.splice(0)) await add(w).catch(e => { console.warn('Download failed:', e.message) })
      changed()
    },
    // on start: carry on with unfinished downloads, and notice finished files that were deleted outside Kotakbase
    resumeAll () {
      for (const it of items) {
        if (it.status === 'active') start(it)
        if (it.status === 'done') for (const f of it.files) { const p = inside(it.dir, f.path); f.missing = !p || !fs.existsSync(p) }
      }
      changed()
    },
    persist () { for (const it of items) remember(it); save() }
  }
}
