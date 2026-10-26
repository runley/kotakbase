import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

// The installer only holds the files listed in package.json's build.files; a main-process module missing from that
// list builds fine and then crashes the installed app at start (beta.8 shipped without downloads.js).
test('every module the main process imports is packaged', () => {
  const { files } = JSON.parse(fs.readFileSync('package.json', 'utf8')).build
  const seen = new Set()
  const walk = file => {
    if (seen.has(file)) return
    seen.add(file)
    const src = fs.readFileSync(file, 'utf8')
    for (const [, dep] of src.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*|require\(\s*)['"]\.\/([^'"]+)['"]/g)) walk(dep)
  }
  walk('main.js')
  walk('preload.cjs')
  for (const f of seen) assert.ok(files.includes(f) || (f.startsWith('ui/') && files.includes('ui/**/*')), `${f} is imported by the main process but missing from build.files`)
})
