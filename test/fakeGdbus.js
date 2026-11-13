// Installs a stand-in `gdbus` in a folder (to be put first on PATH). It plays the MemoBrOS Pointer extension:
// logs every call and answers Ping and GetMonitors. Returns { dir, calls() }.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function fakeGdbus(monitors = [{ x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true, current: false }, { x: 1920, y: 0, width: 2560, height: 1440, scale: 1, primary: false, current: true }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gdbus-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'monitors.json'), JSON.stringify({ monitors }));
  fs.writeFileSync(path.join(dir, 'gdbus'), `#!/bin/sh
method=""; args=""; seen=0
for a in "$@"; do
  if [ "$seen" = 1 ]; then args="$args|$a"; fi
  case "$a" in org.memobros.Pointer.*) method="\${a#org.memobros.Pointer.}";; --) seen=1;; esac
done
echo "$method$args" >> "${log}"
case "$method" in
  Ping) echo "('1',)";;
  GetMonitors) printf "('%s',)\\n" "$(cat "${path.join(dir, 'monitors.json')}")";;
  *) echo "()";;
esac
`);
  fs.chmodSync(path.join(dir, 'gdbus'), 0o755);
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
};
