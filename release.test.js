import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRelease, releaseTags, audioLanguages, subLanguages, rankByLanguage, pickAuto, forThisEntry, otherEntryWords, unplayableAudio, entryNumbers, seasonsNamed } from './ui/release.js'

test('audioLanguages', () => {
  const langs = (...t) => [...audioLanguages(t)].sort()
  assert.deepEqual(langs('[SubsPlease] Nageki no Bourei wa Intai shitai - 23 (1080p)'), ['jpn'])
  assert.deepEqual(langs('Let.This.Grieving.Soul.Retire.S01E23.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG'), ['eng', 'jpn'])
  assert.deepEqual(langs('Re ZERO S04E11 1080p CR WEB-DL MULTi AAC2.0 H 264-VARYG'), ['eng', 'jpn'])
  assert.deepEqual(langs('[Yameii] Let This Grieving Soul Retire - S01E23 [English Dub] [CR WEB-DL 1080p]'), ['eng'])
  assert.deepEqual(langs('[Golumpa] Re ZERO Season 2 - 14 [CR-Dub 1080p x264 AAC]'), ['eng'])
  assert.deepEqual(langs('[Furretar] Frieren (Season 2) (Mainland Mandarin Chinese Dub)'), ['chi'])
  assert.deepEqual(langs('[Judas] Show - S02E10 [1080p][Multi-Subs]'), ['jpn']) // multi subs, not multi audio
  assert.deepEqual([...audioLanguages(['[Group] Show - 01 [1080p]'], true)].sort(), ['eng']) // from a dub-only extension
})

test('Auto Select follows the audio priority list, skipping releases with too few seeders', () => {
  const r = (title, seeders) => ({ title, seeders })
  const results = [ // already ranked best-first
    r('[SubsPlease] Show - 05 (1080p)', 900),
    r('[Group] Show - 05 [Dual Audio] (1080p)', 40),
    r('[Dubber] Show - 05 [English Dub]', 2)
  ]
  const audioOf = x => audioLanguages([x.title])
  const subsOf = x => subLanguages([x.title])
  const auto = (list, audio) => pickAuto(rankByLanguage(list, { audio, subs: [] }, audioOf, subsOf))
  assert.equal(auto(results, ['jpn']).seeders, 900)
  assert.equal(auto(results, ['eng', 'jpn']).seeders, 40) // dual has English and enough seeders
  // only the 2-seeder dub has English: too few, so the next language (Japanese) wins
  assert.equal(auto([results[0], results[2]], ['eng', 'jpn']).seeders, 900)
  // nothing in a preferred language: the top result
  assert.equal(auto(results, ['spa']).seeders, 900)
  // everything under the bar: still the top result rather than nothing
  assert.equal(auto([r('[A] Show - 05', 1)], ['eng']).seeders, 1)
})

test('subLanguages', () => {
  const subs = t => [...subLanguages([t])].sort()
  assert.deepEqual(subs('[LoliHouse] Show - 01 [WebRip 1080p HEVC-10bit AAC][简繁内封字幕]'), ['chi'])
  assert.deepEqual(subs('[Group] Show - 01 [1080p][CHS]'), ['chi'])
  assert.deepEqual(subs('Show S01E01 SUBFRENCH 1080p ADN WEB-DL AAC2.0'), ['fre'])
  assert.deepEqual(subs('[Darkmahou] Show S01E01 (1080p ADN WEB-DL AAC2.0 H.264 PT-BR).mkv'), ['por'])
  assert.deepEqual(subs('Show.S01E01.1080p.WEB-DL.ENG.AAC2.0.H.264.ESub'), ['eng'])
  assert.deepEqual(subs('[Erai-raws] Show - 06 [1080p][ENG][POR-BR][SPA-LA][CHI]'), ['chi', 'eng', 'por', 'spa'])
  assert.ok(subLanguages(['[Judas] Show - S02E10 [1080p][Multi-Subs]']).has('eng'))
  assert.deepEqual(subs('[SubsPlease] Show - 05 (1080p)'), []) // says nothing
  assert.deepEqual(subs('[Yameii] Show - S01E23 [English Dub] [CR WEB-DL 1080p]'), []) // a dub is audio, not subs
})

test('rankByLanguage: subtitles first puts Chinese subs on top, audio first keeps the dub order', () => {
  const r = (title, seeders) => ({ title, seeders })
  const results = [r('[SubsPlease] Show - 05 (1080p)', 900), r('[Group] Show - 05 [English Dub]', 50), r('[LoliHouse] Show - 05 [简繁内封字幕]', 30), r('[Dead] Show - 05 [CHS]', 0)]
  const audioOf = x => audioLanguages([x.title])
  const subsOf = x => subLanguages([x.title])
  const order = first => rankByLanguage(results, { audio: ['eng', 'jpn'], subs: ['chi'], first }, audioOf, subsOf).map(x => x.seeders)
  assert.deepEqual(order('subs'), [30, 50, 900, 0]) // Chinese subs first; a dead torrent stays last even with Chinese subs
  assert.deepEqual(order('audio'), [50, 30, 900, 0]) // English audio first, then Japanese with Chinese subs before without
})

test('parseRelease', () => {
  const a = parseRelease('[Erai-raws] Nageki no Bourei wa Intai shitai Part 2 - 08 [1080p CR WEBRip HEVC AAC][MultiSub]')
  assert.equal(a.group, 'Erai-raws')
  assert.deepEqual(a.tags.map(t => t.label), ['1080p', 'HEVC', 'AAC', 'Multi Subs'])
  const b = parseRelease('Let.This.Grieving.Soul.Retire.S01E21.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG')
  assert.equal(b.group, 'VARYG')
  assert.ok(b.tags.some(t => t.label === 'AAC'))
  assert.equal(parseRelease('Some Title').group, '')
  // AnimeTosho style: group suffix followed by bracketed notes
  assert.equal(parseRelease('Let This Grieving Soul Retire S01E23 1080p CR WEB-DL DUAL AAC2.0 H 264-VARYG (Nageki no Bourei wa Intai Shitai, Dual-Audio, Multi-Subs)').group, 'VARYG')
  assert.equal(parseRelease('Let.This.Grieving.Soul.Retire.S01E23.CR.WEB-DL.DUAL.AAC2.0.MSubs-ToonsHub.mkv').group, 'ToonsHub')
  assert.equal(parseRelease('Mob Psycho - 04 (1080p)').group, '')
  // group in the last bracket, but not tags/checksums there
  assert.equal(parseRelease('JoJos Bizarre Adventure (2012) S06E04 1080p NF WEB-DL (Multi-Subs) (Weekly) [Trix]').group, 'Trix')
  assert.equal(parseRelease('JoJo - Phantom Blood (BDRip 1080p x265)[SFX Subs](Dual-Audio)[MICO XD]').group, 'MICO XD')
  assert.equal(parseRelease('Cyberpunk Edgerunners - S01E01 (WEB 1080p) [ENG]').group, '')
  assert.equal(parseRelease('Show - 01 (1080p) [ABCD1234]').group, '')
  assert.equal(parseRelease('Show S01E01 1080p WEB-DL').group, '')
})

test('audio tags', () => {
  const labels = t => parseRelease(t).tags.map(x => x.label)
  // bare "DUAL" (VARYG / ToonsHub style)
  assert.ok(labels('Let.This.Grieving.Soul.Retire.S01E14.I.Want.to.Talk.About.My.Memories.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-VARYG').includes('Dual Audio'))
  assert.ok(labels('[Group] Show - 01 [Dual-Audio]').includes('Dual Audio'))
  // bare "MULTi" = several audio tracks, but "Multi-Subs" alone is subtitles only
  assert.deepEqual(labels('Show S04E11 1080p CR WEB-DL MULTi AAC2.0 H 264-VARYG').filter(l => l.startsWith('Multi')), ['Multi Audio'])
  assert.deepEqual(labels('[Judas] Show - S02E10 [1080p][Multi-Subs]').filter(l => l.startsWith('Multi')), ['Multi Subs'])
  assert.deepEqual(labels('[Erai-raws] Show - 01 [1080p][Multiple Subtitle]').filter(l => l.startsWith('Multi')), ['Multi Subs'])
  assert.ok(!labels('[SubsPlease] Show - 14 (1080p)').includes('Dual Audio'))
  // Dolby Digital Plus
  assert.ok(labels('Let.This.Grieving.Soul.Retire.S01E14.1080p.AMZN.WEB-DL.DDP2.0.H.264-VARYG.mkv').includes('DDP'))
  assert.ok(labels('Show S01E01 1080p WEB-DL DD+ 5.1').includes('DDP'))
  assert.ok(labels('[INDEX] Solo Leveling [JP.BD][1080p][FLAC+EAC3]').includes('DDP'))
  assert.ok(!labels('[DDPSubs] Show - 01 (1080p)').includes('DDP'))
  // tags merged across the names different extensions gave the same torrent
  assert.deepEqual(releaseTags(['Show S01E14 1080p AAC', 'Show.S01E14.1080p.DUAL.AAC']).map(x => x.label), ['1080p', 'AAC', 'Dual Audio'])
})

test('forThisEntry: other seasons and spin-offs are not this show', () => {
  // Slime season 1 (TVDB season 1); its franchise includes later seasons, The Slime Diaries and Coleus no Yume
  const own = ['Tensei Shitara Slime Datta Ken', 'That Time I Got Reincarnated as a Slime']
  const others = otherEntryWords(own, [
    'Tensei Shitara Slime Datta Ken 2nd Season', 'That Time I Got Reincarnated as a Slime Season 3', // nothing distinctive
    'Tensura Nikki: Tensei Shitara Slime Datta Ken', 'The Slime Diaries: That Time I Got Reincarnated as a Slime',
    'Tensei shitara Slime Datta Ken: Coleus no Yume'
  ])
  assert.deepEqual(others, [['tensura', 'nikki'], ['diaries'], ['coleus', 'yume']])
  const ok = t => forThisEntry([t], { seasons: [null, 1], others })
  assert.equal(ok('[ToonsHub] That Time I Got Reincarnated as a Slime S04E01 1080p CR WEB-DL AAC2.0 H.264'), false)
  assert.equal(ok('That.Time.I.Got.Reincarnated.as.a.Slime.2018.S04E01-E24.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu'), false)
  assert.equal(ok('[Yameii] That Time I Got Reincarnated as a Slime - S03E01 [English Dub] [CR WEB-DL 1080p]'), false)
  assert.equal(ok('[SubsPlease] Tensura Nikki - Tensei Shitara Slime Datta Ken - 01 (1080p) [524D44AF].mkv'), false)
  assert.equal(ok('[ASW] Tensei shitara Slime Datta Ken - Coleus no Yume - 01 [1080p HEVC x265 10Bit][AAC]'), false)
  assert.equal(ok('[HorribleSubs] Tensei Shitara Slime Datta Ken - 01 [1080p].mkv'), true)
  assert.equal(ok('[BlackRabbit] That Time I Got Reincarnated as a Slime (2018) - S01 [Bluray-1080p][Dual Audio]'), true)
  assert.equal(ok('[Asakura] Tensei Shitara Slime Datta Ken S1 + OAD [BDRip 1920x1080 x265 10bit FLAC]'), true)
  // season unknown: a season number alone rules nothing out (releases number seasons their own way, e.g. JoJo "S06")
  assert.equal(forThisEntry(['JoJos Bizarre Adventure S06E03 1080p'], { seasons: [null, undefined], others: [] }), true)
  // a continued season known by two numbers (Nageki cour 2: AniList season 2, TVDB season 1) accepts either
  assert.equal(forThisEntry(['Let This Grieving Soul Retire S01E23 1080p'], { seasons: [2, 1] }), true)
})

test('forThisEntry: a multi-season pack is kept for every season it covers', () => {
  const ok = (t, s) => forThisEntry([t], { seasons: [null, s] })
  // packs listing their seasons one by one were read by the first only (Slime season 2 lost these)
  assert.equal(ok('[VCB-Studio] Tensei Shitara Slime Datta Ken / 転生したらスライムだった件 10-bit 1080p HEVC BDRip [S1 Rev + OAD Rev + S2 Fin]', 2), true)
  assert.equal(ok('[EMBER] That Time I Got Reincarnated as a Slime (2019-2021) (Season 1 + Season 2 Part 01 + Specials + OVA) [BDRip] [1080p Dual Audio HEVC 10 bits]', 2), true)
  assert.equal(ok('[Anime Time] Tensei Shitara Slime Datta Ken (S01+S02+Tensura Nikiki+OVAs) [BD] [Dual Audio][1080p]', 2), true)
  assert.equal(ok('[Grp] Show (Season 1+2+OVA+Specials) [BDRip]', 2), true)
  assert.equal(ok('[Grp] Show (Season 1+2+OVA+Specials) [BDRip]', 3), false)
  assert.equal(ok('[Judas] Tensei Shitara Slime Datta Ken (Season 1 + OADs) [BD 1080p] (Batch)', 2), false)
  // an episode's own SxxEyy decides, not a season its notes name
  assert.equal(ok('[ToonsHub] Show S04E11 1080p (Show 2nd Season Part 2)', 2), false)
  assert.equal(ok('[Grp] Show S01-S03 1080p BD', 2), true)
  assert.equal(ok('[Grp] Show S01-S03 1080p BD', 4), false)
  assert.equal(ok('Show.S01~S03.1080p.WEB-DL', 3), true)
  assert.equal(ok('[Grp] Show Season 1-3 Batch [1080p]', 2), true)
  assert.equal(ok('[Grp] Show Seasons 1-3 [1080p]', 4), false)
  // "S4 - 01" is season 4 episode 1, not a range
  assert.equal(ok('[SubsPlease] Show S4 - 01 (1080p)', 1), false)
  assert.equal(ok('[Grp] Show S01E01-E12 1080p', 1), true)
})

test('forThisEntry: a movie titled "Gekijouban …" is caught by its subtitle', () => {
  const others = otherEntryWords(['Tensei Shitara Slime Datta Ken 4th Season', 'That Time I Got Reincarnated as a Slime Season 4'],
    ['Gekijouban Tensei Shitara Slime Datta Ken: Guren no Kizuna-hen'])
  assert.equal(forThisEntry(['[Group] Tensei shitara Slime Datta Ken Movie: Guren no Kizuna-hen - 01 (1080p)'], { others }), false)
  assert.equal(forThisEntry(['[SubsPlease] Tensei Shitara Slime Datta Ken S4 - 01 (1080p)'], { others }), true)
})

test('audioLanguages: scene-style language code before the audio format', () => {
  const langs = t => [...audioLanguages([t])].sort()
  assert.deepEqual(langs('Even.the.Student.Council.Has.Its.Holes.S01E01.1080p.UNCENSORED.OV.WEB-DL.ENG.AAC2.0.H.264.ESub'), ['eng'])
  assert.deepEqual(langs('Even.the.Student.Council.Has.Its.Holes.S01E01.1080p.UNCENSORED.ADN.WEB-DL.JPN.AAC2.0.H.264'), ['jpn'])
  assert.deepEqual(langs('Show.S01E01.1080p.WEB-DL.GER.DDP5.1.H.264'), ['ger'])
  assert.deepEqual(langs('[Group] Show - 01 [1080p][AAC]'), ['jpn']) // nothing named: Japanese, as before
})

test('rankByLanguage: a release naming the language beats a "Multi Subs" guess, which beats English-only', () => {
  const r = (title, seeders) => ({ title, seeders })
  const results = [r('[SubsPlease] Show - 01 (1080p)', 500), r('[ToonsHub] Show S01E01 1080p CR WEB-DL (Multi-Subs)', 300), r('[Darkmahou] Show S01E01 (1080p PT-BR)', 40)]
  const order = subs => rankByLanguage(results, { audio: ['jpn'], subs, first: 'subs' }, x => audioLanguages([x.title]), x => { const s = subLanguages([x.title]); return s.size ? s : new Set(['eng']) }, x => releaseTags([x.title]).some(t => t.label === 'Multi Subs')).map(x => x.seeders)
  assert.deepEqual(order(['por', 'eng']), [40, 300, 500])
  assert.deepEqual(order(['eng']), [500, 300, 40]) // English: Multi Subs counts fully, so the incoming order stays
})

test('unplayableAudio: Dolby/DTS-only releases play silently in Chromium', () => {
  const no = t => unplayableAudio([t])
  assert.equal(no('That.Time.I.Got.Reincarnated.as.a.Slime.S02.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD'), true) // the user's silent release
  assert.equal(no('That.Time.I.Got.Reincarnated.as.a.Slime.2018.S04E01-E24.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu'), true)
  assert.equal(no('[EMBER] Hotel Inhumans S01E03 [1080p] [HEVC WEBRip DDP]'), true)
  assert.equal(no('[Erai-raws] Hotel Inhumans - 03 [1080p CR WEBRip HEVC EAC3][MultiSub]'), true)
  assert.equal(no('Show S01 1080p BluRay DTS-HD MA 5.1 x264'), true)
  assert.equal(no('Show S01E01 1080p WEB-DL DD5.1 H.264'), true)
  assert.equal(no('Show.S02.1080p.BluRay.Remux.AVC.FLAC.2.0-CRUCiBLE'), false)
  assert.equal(no('[SubsPlease] Show - 01 (1080p)'), false) // names no audio: assumed fine (it's almost always AAC)
  assert.equal(no('Show S01 BluRay FLAC 2.0 + TrueHD 5.1'), false) // has a FLAC track too
  assert.equal(unplayableAudio(['Show S01E01 DDP2.0', 'Show - 01 [AAC]']), false) // another extension's copy of the name says AAC
})

test('entryNumbers: season and part an entry names', () => {
  assert.deepEqual(entryNumbers(['Nageki no Bourei wa Intai Shitai 2', 'Let This Grieving Soul Retire Cour 2']), { season: 2, part: 2 })
  assert.deepEqual(entryNumbers(['Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2']), { season: 2, part: 2 })
  assert.deepEqual(entryNumbers(['Frieren']), { season: null, part: null })
})

test('seasonsNamed: the seasons a release names', () => {
  const titles = ['[VCB-Studio] Slime 10-bit 1080p HEVC BDRip [S1 Reseed + OAD Reseed + S2 Reseed + MOVIE + WEB + S3]', 'Show (Season 1+2+OVA)', 'Show Season 1-3', 'Show S01~S03', 'Show 2nd Season', 'Show.S02E05.1080p', 'Show S04E11 (2nd Season Part 2)', 'Show - 05 (1080p)']
  const expected = [[1, 2, 3], [1, 2], [1, 2, 3], [1, 2, 3], [2], [2], [4], []]
  titles.forEach((t, i) => assert.deepEqual(seasonsNamed(t).sort(), expected[i], t))
})
