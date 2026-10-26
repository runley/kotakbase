// Settings → Copy diagnostics: recent warnings and errors, kept in memory only and copied by the user themselves
// into a bug report. Nothing is sent anywhere.

// Personal bits out of the text: the home folder (has the Windows user name) and any token in a URL or header.
export function redact (text, home) {
  let out = String(text)
  if (home) for (const h of new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')])) out = out.split(h).join('~')
  return out
    .replace(/(access_token|token|code|client_secret)=[^&\s"']+/gi, '$1=…')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1…')
}

// The last `max` lines, oldest first; a line repeated back to back is counted instead of stored again.
export function createLog (max = 100) {
  const lines = []
  return {
    add (level, parts) {
      const text = parts.map(p => p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : safeJson(p)).join(' ').slice(0, 2000)
      const last = lines.at(-1)
      if (last?.level === level && last.text === text) { last.count++; last.at = new Date(); return }
      lines.push({ at: new Date(), level, text, count: 1 })
      if (lines.length > max) lines.shift()
    },
    lines: () => lines.map(l => `${l.at.toISOString()} ${l.level}${l.count > 1 ? ` (×${l.count})` : ''}: ${l.text}`)
  }
}

function safeJson (v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}
