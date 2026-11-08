// The manga reader: a full-window overlay, like the player. Vertical (one long strip, for webtoons) or paged (right to
// left like printed manga, or left to right). It knows nothing of AniList or extensions: the app hands it the chapter
// rows and how to get a chapter's pages, and hears when one was read to its end.
import { t } from './i18n.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
let el = null
let s = null // what's open: the options, plus chapter index, pages, page, read (indexes already reported)

// opts: { title, chapters (rows: { number, title }), index, loadPages(row) → urls, onRead(row), mode, onMode(mode), onClose };
// mode: 'vertical' | 'rtl' | 'ltr'
export function openReader (opts) {
  closeReader()
  s = { ...opts, read: new Set() }
  el = document.createElement('div')
  el.className = 'reader'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', opts.title)
  document.body.append(el)
  el.onclick = click
  el.onchange = e => { if (e.target.matches('[data-r=mode]')) { s.mode = e.target.value; s.onMode(s.mode); draw() } }
  document.addEventListener('keydown', key)
  document.addEventListener('keyup', keyUp)
  addEventListener('blur', holdEnd) // the window lost focus with space down: its keyup won't come
  addEventListener('hashchange', closeReader) // Back (the mouse's too) leaves the reader, not the page under it
  chapter(s.index)
}

// e: the hashchange that closed it (the page under it is changing anyway: no onClose)
export function closeReader (e) {
  if (!el) return
  const after = e?.type === 'hashchange' ? null : s.onClose
  el.remove()
  el = s = null
  holdEnd()
  document.removeEventListener('keydown', key)
  document.removeEventListener('keyup', keyUp)
  removeEventListener('blur', holdEnd)
  removeEventListener('hashchange', closeReader)
  after?.()
}

const name = row => row.number != null ? t('Chapter {n}', { n: row.number }) : row.title || '—'

async function chapter (i) {
  s.index = i
  s.pages = null
  s.page = 0
  draw()
  const mine = s
  try {
    const pages = await s.loadPages(s.chapters[i])
    if (mine !== s || s.index !== i) return // closed, or moved on meanwhile
    if (!pages.length) throw new Error(t('Nothing here yet.'))
    s.pages = pages
  } catch (e) {
    if (mine === s && s.index === i) body().innerHTML = `<p class="err r-msg">${esc(e.message)}</p>`
    return
  }
  draw()
}

const body = () => el.querySelector('.r-body')

function draw () {
  cancelAnimationFrame(hold?.raf)
  hold = glide = null
  const row = s.chapters[s.index]
  const has = d => s.chapters[s.index + d]
  const modes = [['vertical', t('Vertical')], ['rtl', t('Right to left')], ['ltr', t('Left to right')]]
  el.innerHTML = `<div class="r-bar">
      <button data-r="close" aria-label="${t('Close')}" title="${t('Close')}">✕</button>
      <b>${esc(s.title)}</b><span class="muted">${esc(name(row))}</span>
      <span class="r-count"></span>
      <select data-r="mode" aria-label="${t('Reading mode')}">${modes.map(([k, l]) => `<option value="${k}" ${k === s.mode ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button data-r="prev" ${has(-1) ? '' : 'disabled'}>‹ ${t('Previous chapter')}</button>
      <button data-r="next" ${has(1) ? '' : 'disabled'}>${t('Next chapter')} ›</button>
    </div>
    <div class="r-body ${s.mode === 'vertical' ? 'vertical' : 'paged'}" tabindex="-1">${s.pages ? '' : `<p class="muted r-msg">${t('Loading…')}</p>`}</div>`
  if (!s.pages) return
  const b = body()
  b.focus() // arrow keys and space scroll the strip
  if (s.mode !== 'vertical') return show(s.page)
  b.innerHTML = s.pages.map((url, i) => `<img src="${esc(url)}" alt="" ${i < 3 ? '' : 'loading="lazy"'} data-i="${i}">`).join('') +
    `<div class="r-end">${has(1) ? `<button class="btn" data-r="next">${t('Next chapter')} ›</button>` : ''}</div>`
  // the page in view, for the counter; the end of the strip in view: read
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      if (e.target.matches('.r-end')) done()
      else count(+e.target.dataset.i)
    }
  }, { root: b, threshold: 0.01 })
  b.querySelectorAll('img, .r-end').forEach(x => seen.observe(x))
  if (s.page) b.querySelector(`[data-i="${s.page}"]`)?.scrollIntoView()
  count(s.page)
}

function count (i) {
  s.page = i
  el.querySelector('.r-count').textContent = t('Page {n} / {total}', { n: i + 1, total: s.pages.length })
}

// paged: one page, the next few loading meanwhile
function show (i) {
  count(i)
  body().innerHTML = `<img src="${esc(s.pages[i])}" alt="">`
  for (const url of s.pages.slice(i + 1, i + 4)) new Image().src = url
  if (i === s.pages.length - 1) done()
}

function done () {
  if (s.read.has(s.index)) return
  s.read.add(s.index)
  s.onRead(s.chapters[s.index])
}

// paged: past the last page goes on to the next chapter
function turn (d) {
  if (!s?.pages) return
  const i = s.page + d
  if (i >= 0 && i < s.pages.length) show(i)
  else if (s.chapters[s.index + d]) chapter(s.index + d)
}

function click (e) {
  const r = e.target.closest('[data-r]')?.dataset.r
  if (r === 'close') return closeReader()
  if (r === 'prev' || r === 'next') return chapter(s.index + (r === 'next' ? 1 : -1))
  // paged: the left half and right half of the page turn it, the way the book reads
  if (s.mode !== 'vertical' && e.target.closest('.r-body')) {
    const left = e.clientX < innerWidth / 2
    turn(left === (s.mode === 'rtl') ? 1 : -1)
  }
}

// vertical: holding space scrolls on at about reading speed until it's let go; a tap glides 60% of a screen. With
// shift, both go back up.
const READ_SPEED = 0.25 // screens a second while space is held
const TAP_MS = 200 // let go sooner than this: a tap
const STEP = 0.6
const GLIDE_MS = 350
let glide = null // { to, raf }
let hold = null // { dir, at, raf }
function holdStart (dir) {
  if (hold) return // the key's auto-repeat
  cancelAnimationFrame(glide?.raf)
  glide = null
  const b = body()
  let pos = b.scrollTop // kept as a fraction: a few pixels a frame would round away
  let last = performance.now()
  hold = { dir, at: last }
  const run = now => {
    pos = Math.max(0, Math.min(b.scrollHeight - b.clientHeight, pos + dir * READ_SPEED * b.clientHeight * (now - last) / 1000))
    b.scrollTop = pos
    last = now
    hold.raf = requestAnimationFrame(run)
  }
  hold.raf = requestAnimationFrame(run)
}
function holdEnd () {
  if (!hold) return
  cancelAnimationFrame(hold.raf)
  const { dir, at } = hold
  hold = null
  if (performance.now() - at < TAP_MS && el) step(dir)
}
const keyUp = e => { if (e.key === ' ') holdEnd() }
function step (d) {
  const b = body()
  const from = b.scrollTop
  const to = Math.max(0, Math.min(b.scrollHeight - b.clientHeight, (glide?.to ?? from) + d * b.clientHeight * STEP))
  cancelAnimationFrame(glide?.raf)
  const start = performance.now()
  const run = now => {
    const k = Math.min(1, (now - start) / GLIDE_MS)
    b.scrollTop = from + (to - from) * (1 - (1 - k) ** 3) // eases out
    glide = k < 1 ? { to, raf: requestAnimationFrame(run) } : null
  }
  glide = { to, raf: requestAnimationFrame(run) }
}

function key (e) {
  if (e.key === 'Escape') return closeReader()
  if (e.target.matches?.('select, button')) return // space presses those
  if (s.mode === 'vertical') {
    if (e.key === ' ' && s.pages) { e.preventDefault(); holdStart(e.shiftKey ? -1 : 1) }
    return
  }
  const rtl = s.mode === 'rtl'
  const d = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1, ' ': 1, PageDown: 1, PageUp: -1 }[e.key]
  if (d) { e.preventDefault(); turn(d) }
}
