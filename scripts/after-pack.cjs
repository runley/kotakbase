// electron-builder afterPack. Linux: Kotakbase starts through a small script that drops Steam's overlay (LD_PRELOAD)
// first. Steam preloads it into what it starts (Kotakbase as a non-Steam game on the Steam Deck), and it crashes
// Chromium's helper processes before any of the app's code runs.
const fs = require('node:fs')
const path = require('node:path')

exports.default = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'linux') return
  const name = packager.executableName
  const bin = path.join(appOutDir, name)
  fs.renameSync(bin, `${bin}-bin`)
  fs.writeFileSync(bin, `#!/bin/sh
case "$LD_PRELOAD" in *gameoverlayrenderer*) unset LD_PRELOAD ;; esac
exec "$(dirname "$(readlink -f "$0")")/${name}-bin" "$@"
`, { mode: 0o755 })
}
