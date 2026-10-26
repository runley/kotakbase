import assert from 'node:assert/strict'
import test from 'node:test'
import { redact, createLog } from './diagnostics.js'

test('redact hides the home folder in either slash style, and tokens', () => {
  const home = 'C:\\Users\\alice'
  const text = 'at C:\\Users\\alice\\AppData\\x.js and file:///C:/Users/alice/a.js and "C:\\\\Users\\\\alice\\\\b" ' +
    'https://x.co/cb#access_token=abc.def&expires=1 Authorization: Bearer eyJhbGciOi.x-y ?code=123'
  const out = redact(text, home)
  assert.ok(!out.includes('alice'), out)
  assert.ok(!/abc\.def|eyJhbGciOi|123/.test(out), out)
  assert.match(out, /~\\AppData/)
  assert.match(out, /expires=1/)
})

test('createLog keeps the newest lines and counts repeats', () => {
  const log = createLog(2)
  log.add('warn', ['a'])
  log.add('warn', ['a'])
  log.add('error', [new Error('b')])
  log.add('warn', ['c', { n: 1 }])
  const lines = log.lines()
  assert.equal(lines.length, 2)
  assert.match(lines[0], /error: Error: b/)
  assert.match(lines[1], /warn: c \{"n":1\}$/)
  const counted = createLog()
  counted.add('warn', ['x'])
  counted.add('warn', ['x'])
  assert.match(counted.lines()[0], /warn \(×2\): x/)
})
