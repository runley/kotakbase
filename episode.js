// Guess the episode number from a release file name, e.g. "[Group] Show - 05 (1080p) [ABCD1234].mkv" -> 5
export function episodeOf (name) {
  const n = name.replace(/\[[^\]]*\]|\([^)]*\)|\.[a-z0-9]+$/gi, ' ')
  const m = n.match(/(?:^|[^a-z])(?:EP?|Episode)\s?(\d{1,4})(?!\d)/i) ?? n.match(/\s-\s(\d{1,4})(?!\d)/) ?? n.match(/.*\b(\d{1,4})(?:v\d)?\b/)
  return m ? Number(m[1]) : null
}

export const VIDEO = /\.(mkv|mp4|webm|m4v|avi|mov)$/i
// Programs and scripts: an anime release never needs one, so a torrent carrying one is almost certainly a fake
export const RISKY = /\.(exe|scr|bat|cmd|com|lnk|msi|vbs|ps1|pif|hta|jar)$/i

// "S02E05" → 2, a special's "S00E08" → 0, no SxxEyy → null
const fileSeason = name => { const m = name.match(/\bS(\d{1,2})E\d/i); return m ? Number(m[1]) : null }
// Specials (season 0) are never a regular episode: packs put them next to the episodes with the same numbers
// ("Specials/…S00E08" beside "…S02E08"), and S00 sorts first
const regular = videos => videos.filter(f => fileSeason(f.name) !== 0)

// Pick the file to play for an episode out of a torrent's file list. For a season that continues another, `ids` has
// the series-wide number (abs) and the TVDB season/episode; they're tried first, so a full-series pack doesn't play
// the earlier part's episode with the same per-entry number.
export function pickFile (files, episode, ids = {}) {
  const videos = sortedVideos(files)
  if (videos.length <= 1) return videos[0] // undefined when there's no video at all
  return findEpisode(files, episode, ids) || regular(videos)[episode - 1] || videos[0]
}

const sortedVideos = files => files.filter(f => VIDEO.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

// The file whose name says it's this episode, or null: no guessing by position, so "is the next episode in this pack?"
// is only answered yes when it really is.
export function findEpisode (files, episode, ids = {}) {
  const videos = regular(sortedVideos(files))
  const find = (n, season) => n && videos.find(f => episodeOf(f.name) === n && (!season || fileSeason(f.name) == null || fileSeason(f.name) === season))
  // the series-wide number never applies to a file naming this TVDB season, which numbers within it: in a season-2
  // pack of S02E01–S02E13, Solo Leveling S2's first episode (series-wide 13) is S02E01, and S02E13 is the finale
  const perSeason = ids.tvdbSeason && ids.abs !== ids.tvdbSeasonEpisode
  const abs = ids.abs && videos.find(f => episodeOf(f.name) === ids.abs && !(perSeason && fileSeason(f.name) === ids.tvdbSeason))
  return abs || find(ids.tvdbSeasonEpisode, ids.tvdbSeason) || find(episode) || null
}
