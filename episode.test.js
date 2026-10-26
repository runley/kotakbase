import assert from 'node:assert/strict'
import test from 'node:test'
import { episodeOf, pickFile, findEpisode, RISKY } from './episode.js'

test('episodeOf', () => {
  assert.equal(episodeOf('[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv'), 5)
  assert.equal(episodeOf('Show.S02E11.1080p.WEB.x264.mkv'), 11)
  assert.equal(episodeOf('[Judas] Dandadan - S01E03v2.mkv'), 3)
  assert.equal(episodeOf('Kimi no Na wa 2016 Episode 12 [BD].mkv'), 12)
  assert.equal(episodeOf('Mob Psycho 100 - 07.mkv'), 7)
})

test('a special (S00Exx) is never played as the episode with the same number', () => {
  // iAHD Slime S02 pack: "Specials/…S00E08…" sorts before "…S02E08…"; episode 8 played the special
  const pack = 'That.Time.I.Got.Reincarnated.as.a.Slime'
  const files = [`${pack}.S00E08.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD.mkv`,
    ...Array.from({ length: 24 }, (_, i) => `${pack}.S02E${String(i + 1).padStart(2, '0')}.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD.mkv`)].map(name => ({ name }))
  const s02e08 = `${pack}.S02E08.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD.mkv`
  assert.equal(pickFile(files, 8).name, s02e08)
  assert.equal(pickFile(files, 8, { abs: 32, tvdbSeason: 2, tvdbSeasonEpisode: 8 }).name, s02e08)
  assert.equal(findEpisode(files, 8, { tvdbSeason: 2, tvdbSeasonEpisode: 8 }).name, s02e08) // the next-episode lookup
  // by position, too: the special doesn't shift the episodes
  const unnumbered = [{ name: 'Show.S00E01.Recap.mkv' }, { name: 'Show Part A.mkv' }, { name: 'Show Part B.mkv' }]
  assert.equal(pickFile(unnumbered, 1).name, 'Show Part A.mkv')
})

test('pickFile', () => {
  const files = ['NCOP.mkv', 'Show - 01.mkv', 'Show - 02.mkv', 'Show - 10.mkv', 'info.nfo'].map(name => ({ name }))
  assert.equal(pickFile(files, 2).name, 'Show - 02.mkv')
  assert.equal(pickFile(files, 10).name, 'Show - 10.mkv')
  assert.equal(pickFile([{ name: 'movie.mkv' }, { name: 'a.txt' }], 1).name, 'movie.mkv')
  // continued season in a full pack: episode 10 of cour 2 is file 23, not cour 1's 10
  const full = Array.from({ length: 24 }, (_, i) => ({ name: `Show - ${String(i + 1).padStart(2, '0')}.mkv` }))
  assert.equal(pickFile(full, 10, { abs: 23, tvdbSeason: 1, tvdbSeasonEpisode: 23 }).name, 'Show - 23.mkv')
  // a cour-2-only pack numbered per season still finds 10
  const cour2 = Array.from({ length: 11 }, (_, i) => ({ name: `Show S02E${String(i + 1).padStart(2, '0')}.mkv` }))
  assert.equal(pickFile(cour2, 10, { abs: 23, tvdbSeason: 1, tvdbSeasonEpisode: 23 }).name, 'Show S02E10.mkv')
  // Re:Zero S2 Part 2 ep 1 in an all-seasons pack: S02E14, not S01E14 or S02E01
  const all = [1, 2].flatMap(s => Array.from({ length: 25 }, (_, i) => ({ name: `Re Zero S0${s}E${String(i + 1).padStart(2, '0')}.mkv` })))
  assert.equal(pickFile(all, 1, { abs: 39, tvdbSeason: 2, tvdbSeasonEpisode: 14 }).name, 'Re Zero S02E14.mkv')
  // Solo Leveling S2 ep 1 (series-wide 13) in a season-2 pack numbered per season: S02E01, never the finale S02E13
  const solo = Array.from({ length: 13 }, (_, i) => ({ name: `Solo Leveling - S02E${String(i + 1).padStart(2, '0')}.mkv` }))
  const ids = { abs: 13, tvdbSeason: 2, tvdbSeasonEpisode: 1 }
  assert.equal(pickFile(solo, 1, ids).name, 'Solo Leveling - S02E01.mkv')
  assert.equal(findEpisode(solo, 1, ids).name, 'Solo Leveling - S02E01.mkv')
  // ... while a full-series pack numbered on from season 1 still gets file 13
  const series = Array.from({ length: 25 }, (_, i) => ({ name: `Solo Leveling - ${String(i + 1).padStart(2, '0')}.mkv` }))
  assert.equal(pickFile(series, 1, ids).name, 'Solo Leveling - 13.mkv')
})

test('findEpisode: only a real match, never a positional guess', () => {
  const pack = ['Show - 01.mkv', 'Show - 02.mkv', 'Show - 03.mkv'].map(name => ({ name }))
  assert.equal(findEpisode(pack, 3).name, 'Show - 03.mkv')
  assert.equal(findEpisode(pack, 4), null) // pickFile would fall back to a file here
  assert.equal(findEpisode([{ name: 'Show - 05.mkv' }], 6), null) // single-episode torrent
})

test('RISKY: programs and scripts, not videos, subtitles or fonts', () => {
  for (const name of ['Episode 01.mkv.exe', 'codec-installer.msi', 'Play Me.lnk', 'setup.bat', 'video.scr']) assert.ok(RISKY.test(name), name)
  for (const name of ['[SubsPlease] Show - 01 (1080p).mkv', 'Show - 01.ass', 'fonts/Arial.ttf', 'readme.txt', 'cover.jpg']) assert.ok(!RISKY.test(name), name)
})

test('pickFile: nothing to play in a torrent without a video', () => {
  assert.equal(pickFile([{ name: 'setup.exe' }, { name: 'readme.txt' }], 1), undefined)
})
