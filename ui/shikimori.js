// Russian titles and descriptions from Shikimori (the big Russian anime site), by MyAnimeList id. Used only when the
// app is in Russian or Kazakh. Its GraphQL API needs no key; `censored: false` keeps it from hiding some ordinary shows
// (AniList already leaves out adult ones).
const API = 'https://shikimori.io/api/graphql'

// Shikimori's markup in descriptions ([character=123]Name[/character], [i], [spoiler]…) → plain text
export const cleanDescription = s => String(s ?? '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[\/?[a-z_]+(=[^\]]*)?\]/gi, '').replace(/\r\n/g, '\n').trim()

// ids → Map of malId → { title, description } for the ones Shikimori has (up to 50 per request)
export async function fetchRussian (ids, fetchImpl = fetch) {
  const out = new Map()
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).filter(id => Number.isInteger(+id))
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ animes(ids: "${chunk.join(',')}", limit: 50, censored: false) { malId russian description } }` }),
      signal: AbortSignal.timeout(6000)
    })
    const { data } = await res.json()
    for (const a of data?.animes ?? []) if (a.russian) out.set(String(a.malId), { title: a.russian, description: cleanDescription(a.description) })
  }
  return out
}
