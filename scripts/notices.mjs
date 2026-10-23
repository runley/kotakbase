// Writes THIRD_PARTY_NOTICES.txt: the name, version, licence and licence text of every package the installer ships
// (production dependencies, plus JASSUB, which is bundled into ui/vendor). mpv's notice lives in licenses/.
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dirs = execSync('npm ls --omit=dev --all --parseable', { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean).slice(1) // the first line is Kotakbase itself
dirs.push(path.resolve('node_modules/jassub'))

const seen = new Set()
const parts = []
for (const dir of dirs.sort()) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const key = `${pkg.name}@${pkg.version}`
  if (seen.has(key)) continue
  seen.add(key)
  const file = readdirSync(dir).find(f => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
  const text = file && existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8').trim() : '(no licence file in the package)'
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  parts.push(`${key}\nLicence: ${pkg.license ?? 'see below'}${repo ? `\nSource: ${repo}` : ''}\n\n${text}`)
}

const head = `Kotakbase includes the following third-party software. Each is used under the licence shown with it.

JASSUB contains libass, FreeType, HarfBuzz, FriBidi and other libraries compiled to WebAssembly (ui/vendor/wasm), used
unmodified under their LGPL/GPL/MIT/ISC/Zlib/BSL licences; their source is at https://github.com/ThaUnknown/jassub.
mpv, shipped as the separate program mpv.exe, is covered in licenses/mpv-NOTICE.txt.
Electron and Chromium licences ship next to Kotakbase.exe (LICENSE.electron.txt, LICENSES.chromium.html).`
writeFileSync('THIRD_PARTY_NOTICES.txt', [head, ...parts].join(`\n\n${'='.repeat(80)}\n\n`) + '\n')
console.log(`THIRD_PARTY_NOTICES.txt: ${parts.length} packages`)
