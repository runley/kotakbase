import assert from 'node:assert/strict'
import test from 'node:test'
import { langOf, pickTrack, pickSubTrack, fromMpv, SIGNS } from './ui/lang.js'

test('langOf', () => {
  assert.equal(langOf({ language: 'jpn' }), 'jpn')
  assert.equal(langOf({ language: 'en-US' }), 'eng')
  assert.equal(langOf({ language: 'deu' }), 'ger')
  assert.equal(langOf({ language: '', name: 'English subs' }), 'eng')
  assert.equal(langOf({ language: 'und' }), null)
  assert.equal(langOf({ name: 'CR_English' }), 'eng') // Crunchyroll rips: no language code, underscore in the name
})

test('pickTrack follows priority order', () => {
  const tracks = [{ language: 'jpn' }, { language: 'eng' }]
  assert.equal(pickTrack(tracks, ['eng', 'jpn']), 1)
  assert.equal(pickTrack(tracks, ['spa', 'jpn']), 0)
  assert.equal(pickTrack(tracks, ['spa']), -1)
  // the user's file: English untagged, the rest tagged
  assert.equal(pickTrack([{ name: 'CR_English' }, { name: 'CR_Spanish', language: 'spa' }], ['eng']), 0)
})

test('pickSubTrack', () => {
  const name = (tracks, prefs) => pickSubTrack(tracks, prefs)?.name ?? null
  // the user's file: untagged Asakura tracks (English, by the MKV rule) plus German CR ones
  const file = [{ name: 'Full Subtitles [Asakura]' }, { name: 'Signs & Songs [Asakura]' }, { name: 'Full Subtitles [CR]', language: 'ger' }, { name: 'Signs & Songs [CR]', language: 'ger' }]
  assert.equal(name(file, ['eng']), 'Full Subtitles [Asakura]') // English's full track, not its signs track
  assert.equal(name(file, ['ger', 'eng']), 'Full Subtitles [CR]')
  assert.equal(name(file, [SIGNS, 'eng']), 'Signs & Songs [Asakura]') // Signs & Songs listed first
  assert.equal(name(file, ['spa']), 'Signs & Songs [Asakura]') // nothing listed in the file: signs instead of off
  assert.equal(name(file, []), null) // empty list: always off
  // names vary by release: the top English track wins whatever it's called
  assert.equal(name([{ name: 'Dialogue', language: 'eng' }, { name: 'Commentary', language: 'eng' }], ['eng']), 'Dialogue')
  // only a signs track in that language: better than nothing
  assert.equal(name([{ name: 'Signs', language: 'eng' }, { name: 'Full', language: 'ger' }], ['eng']), 'Signs')
  assert.equal(name([{ name: 'Full', language: 'ger' }], ['eng']), null) // nothing English, no signs track: off
  assert.equal(name([{ name: 'Full', language: 'und' }], ['eng']), null) // "und" means unknown, not English
})

test('fromMpv adapts mpv track-list for the pickers', () => {
  // a dual-audio release as mpv reports it: untagged signs track, English full subs, German subs
  const list = [
    { id: 1, type: 'video', codec: 'hevc' },
    { id: 1, type: 'audio', lang: 'jpn', title: 'Japanese', codec: 'truehd', selected: true },
    { id: 2, type: 'audio', lang: 'eng', codec: 'eac3' },
    { id: 1, type: 'sub', title: 'Signs & Songs', codec: 'ass' },
    { id: 2, type: 'sub', lang: 'eng', title: 'Full Subtitles', codec: 'ass' },
    { id: 3, type: 'sub', lang: 'ger', codec: 'ass' }
  ]
  const audio = fromMpv(list, 'audio')
  assert.deepEqual(audio.map(t => t.number), [1, 2])
  assert.equal(audio[pickTrack(audio, ['eng', 'jpn'])].number, 2) // aid 2
  assert.equal(audio[pickTrack(audio, ['jpn'])].number, 1)
  const subs = fromMpv(list, 'sub')
  assert.equal(pickSubTrack(subs, ['eng']).number, 2) // English's full track, not the untagged signs one
  assert.equal(pickSubTrack(subs, [SIGNS, 'eng']).number, 1)
  assert.equal(pickSubTrack(subs, ['ger']).number, 3)
  assert.equal(pickSubTrack(subs, ['spa']).number, 1) // nothing in that language: signs
  assert.deepEqual(fromMpv(list, 'audio')[0], { number: 1, language: 'jpn', name: 'Japanese', codec: 'truehd', selected: true })
})
