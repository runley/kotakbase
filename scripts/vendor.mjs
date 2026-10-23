// Bundles JASSUB (styled ASS subtitle renderer) into ui/vendor, keeping its relative layout so its default asset URLs resolve.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const src = 'node_modules/jassub/dist'
const out = 'ui/vendor'
const opts = { bundle: true, format: 'esm', logLevel: 'warning' }
await build({ ...opts, entryPoints: [`${src}/jassub.js`], outfile: `${out}/jassub.js` })
await build({ ...opts, entryPoints: [`${src}/worker/worker.js`], outfile: `${out}/worker/worker.js` })
cpSync(`${src}/wasm`, `${out}/wasm`, { recursive: true, filter: f => !f.endsWith('.js') && !f.endsWith('.map') && !f.endsWith('.ts') })
cpSync(`${src}/default.woff2`, `${out}/default.woff2`)

// mpv for the mpv player mode: a pinned Windows x64 build (shinchiro/mpv-winbuild-cmake, linked from mpv.io), checked
// against its SHA-256 and unpacked into vendor/mpv, which the installer ships as a resource. Not committed to git.
const MPV = {
  url: 'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261015/mpv-x86_64-20261015-git-492bae0768.7z',
  sha256: 'f9becefe40e2a29d2ce5f3ab231ff094f9cf3e4038ff014cfe4a0c09ad90e79e'
}
const mpvDir = 'vendor/mpv'
const stamp = path.join(mpvDir, 'version.txt')
if (process.platform === 'win32' && !(existsSync(stamp) && readFileSync(stamp, 'utf8') === MPV.url)) {
  console.log('Downloading mpv…')
  const res = await fetch(MPV.url)
  if (!res.ok) throw new Error(`mpv download failed: ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(data).digest('hex')
  if (sha !== MPV.sha256) throw new Error(`mpv download checksum mismatch: got ${sha}`)
  const tmp = mkdtempSync(path.join(tmpdir(), 'kotakbase-mpv-'))
  try {
    writeFileSync(path.join(tmp, 'mpv.7z'), data)
    rmSync(mpvDir, { recursive: true, force: true })
    mkdirSync(mpvDir, { recursive: true })
    // Windows' own tar (libarchive) reads 7z; Git Bash's GNU tar on PATH doesn't, hence the full path
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', path.join(tmp, 'mpv.7z'), '-C', mpvDir, 'mpv.exe', 'd3dcompiler_43.dll'])
    writeFileSync(stamp, MPV.url)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
