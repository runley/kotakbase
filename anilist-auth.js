// AniList sign-in (main process only): the token never reaches the page. Implicit grant, so no server and no client
// secret: AniList's sign-in page redirects to REDIRECT with the token in the URL fragment, and that redirect is caught
// before it loads. The token is kept encrypted with safeStorage (Windows DPAPI) in userData; the page gets only who is
// signed in, and signed-in GraphQL requests go through 'anilist-query'.
import electron from 'electron' // the default import: a plain `node --test` loads this file for parseRedirect too
import fs from 'node:fs'
import path from 'node:path'
import { t } from './ui/i18n.js'

export const REDIRECT = 'https://anilist.co/api/v2/oauth/pin' // registered with the app's Client ID on AniList

// The redirect to REDIRECT: { token, expires } (expires: ms timestamp), { error } if access was denied, or null for
// any other URL.
export function parseRedirect (url) {
  let u
  try { u = new URL(url) } catch { return null }
  if (u.origin + u.pathname !== REDIRECT) return null
  const hash = new URLSearchParams(u.hash.slice(1))
  const get = k => hash.get(k) ?? u.searchParams.get(k)
  if (get('error')) return { error: get('error_description') || get('error') }
  const token = hash.get('access_token')
  if (!token) return { error: 'AniList sent no access token' }
  const expiresIn = Number(hash.get('expires_in'))
  return { token, expires: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null }
}

export function setupAniList (clientId, parent) {
  const { app, BrowserWindow, ipcMain, safeStorage, session } = electron
  // ANILIST_URL: a local stand-in for AniList in end-to-end tests, honoured only when running from source
  const stub = !app.isPackaged && process.env.ANILIST_URL
  const AUTHORIZE = `${stub || 'https://anilist.co'}/api/v2/oauth/authorize`
  const GRAPHQL = stub ? `${stub}/graphql` : 'https://graphql.anilist.co'
  const PARTITION = 'persist:anilist' // the sign-in window's cookies, kept apart from the app's own
  const file = () => path.join(app.getPath('userData'), 'anilist-token')
  const read = () => { try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file()))) } catch { return null } }
  const write = data => fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(data)))

  const account = () => {
    if (!clientId) return { configured: false }
    const a = read()
    if (!a) return { configured: true }
    const expired = !a.token || (a.expires && a.expires < Date.now())
    return { configured: true, user: a.user, ...(expired ? { expired: true } : { expires: a.expires }) }
  }

  // { status: 200, data } or { status, error, retryAfter }; status 0 = AniList unreachable
  async function post (token, query, variables) {
    let res
    try {
      res = await fetch(GRAPHQL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) })
    } catch (e) { return { status: 0, error: e.message } }
    const json = await res.json().catch(() => null)
    const error = json?.errors?.[0]?.message
    if (res.ok && json?.data && !error) return { status: 200, data: json.data }
    const status = res.status === 401 || /invalid token|unauthori[sz]ed/i.test(error ?? '') ? 401 : res.ok ? 400 : res.status
    return { status, error: error ?? res.statusText, retryAfter: Number(res.headers.get('retry-after')) || null }
  }

  ipcMain.handle('anilist-account', account)

  ipcMain.handle('anilist-query', async (_, query, variables) => {
    const a = account()
    if (!a.user || a.expired) return { status: 401 }
    const r = await post(read().token, query, variables)
    // expired or revoked: forget the token, keep who it was so Settings can say "sign in again"
    if (r.status === 401) write({ user: a.user })
    return r
  })

  ipcMain.handle('anilist-signin', async () => {
    if (!clientId) return { error: 'AniList sign-in isn\'t set up in this build (no Client ID).' }
    if (!safeStorage.isEncryptionAvailable()) return { error: 'Windows can\'t encrypt the AniList sign-in on this PC, so it can\'t be kept.' }
    const got = await new Promise(resolve => {
      const w = new BrowserWindow({ parent: parent(), modal: true, width: 520, height: 760, autoHideMenuBar: true, title: t('Sign in with AniList'), webPreferences: { partition: PARTITION } })
      let done = false
      const finish = r => { if (done) return; done = true; resolve(r); if (!w.isDestroyed()) w.close() }
      // the redirect may come as a server redirect or as the page navigating; either way it's stopped before loading
      const check = (e, url) => { const r = parseRedirect(e.url ?? url); if (r) { e.preventDefault(); finish(r) } }
      w.webContents.on('will-redirect', check)
      w.webContents.on('will-navigate', check)
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      w.on('closed', () => finish({ error: null })) // closed by the user: not an error worth showing
      w.loadURL(`${AUTHORIZE}?client_id=${encodeURIComponent(clientId)}&response_type=token`).catch(() => {}) // aborted by the catch above
    })
    if (got.error !== undefined) return { error: got.error }
    const r = await post(got.token, '{ Viewer { id name avatar { medium } } }')
    if (r.status !== 200) return { error: `AniList didn't accept the sign-in (${r.error || r.status}).` }
    const { id, name, avatar } = r.data.Viewer
    write({ token: got.token, expires: got.expires, user: { id, name, avatar: avatar?.medium } })
    return account()
  })

  ipcMain.handle('anilist-signout', async () => {
    fs.rmSync(file(), { force: true })
    await session.fromPartition(PARTITION).clearStorageData() // AniList's own sign-in cookie too
    return account()
  })
}
