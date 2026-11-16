// Tests for "start with the system": which profile may manage the autostart entry, and when it is touched.
// Plain Node. Everything happens in temporary folders; the real autostart folder is never read or written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const autostart = require('../src/main/autostart');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-home-'));
const real = path.join(home, '.config', 'autostart', autostart.FILE); // stands in for the user's real entry
const base = { home, platform: 'linux', packaged: false, execPath: '/opt/electron', appPath: '/home/u/MemoBrOS' };
const installed = {}; // no MEMOBROS_USER_DATA, no MEMOBROS_TEST

test('the kind of profile is decided by how the app was started, not by folder names', () => {
  assert.deepEqual(autostart.profile(installed), { kind: 'installed', manages: true, dir: null, reason: '' });
  for (const env of [{ MEMOBROS_USER_DATA: '/tmp/x' }, { MEMOBROS_TEST: '1' }, { MEMOBROS_USER_DATA: path.join(home, '.config', 'MemoBrOS') }, { MEMOBROS_USER_DATA: '/tmp/x', MEMOBROS_TEST: '1' }]) {
    const p = autostart.profile(env);
    assert.deepEqual([p.kind, p.manages, p.dir], ['temporary', false, null], JSON.stringify(env)); assert.match(p.reason, /temporary profile/);
  }
  const granted = autostart.profile({ MEMOBROS_USER_DATA: '/tmp/x', MEMOBROS_AUTOSTART_DIR: '/tmp/own' });
  assert.deepEqual([granted.kind, granted.manages, granted.dir], ['temporary', true, path.resolve('/tmp/own')], 'a temporary profile only manages a folder it was explicitly given');
});

test('a temporary profile never writes, replaces or removes the real entry, whatever its settings say', () => {
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, 'the real entry\n');
  for (const env of [{ MEMOBROS_USER_DATA: '/tmp/x' }, { MEMOBROS_TEST: '1' }]) {
    for (const [was, on] of [[false, true], [true, false], [false, false], [true, true], [undefined, false]]) {
      for (const platform of ['linux', 'win32', 'darwin']) {
        const step = autostart.apply(autostart.plan({ ...base, env, platform, packaged: true, was, on }), () => { throw new Error('the login item must not be touched'); });
        assert.equal(step.action, 'none', `${JSON.stringify(env)} ${platform} ${was}→${on}`);
      }
    }
  }
  assert.equal(fs.readFileSync(real, 'utf8'), 'the real entry\n');
  // with a folder of its own it works there, and the real entry still stays as it was
  const own = path.join(home, 'own');
  const env = { MEMOBROS_USER_DATA: '/tmp/x', MEMOBROS_TEST: '1', MEMOBROS_AUTOSTART_DIR: own };
  autostart.apply(autostart.plan({ ...base, env, was: false, on: true }));
  assert.match(fs.readFileSync(path.join(own, autostart.FILE), 'utf8'), /^Exec="\/opt\/electron" "\/home\/u\/MemoBrOS" --hidden$/m);
  autostart.apply(autostart.plan({ ...base, env, was: true, on: false }));
  assert.ok(!fs.existsSync(path.join(own, autostart.FILE)));
  assert.equal(fs.readFileSync(real, 'utf8'), 'the real entry\n');
});

test('the installed profile still manages autostart: on writes the entry, off removes it', () => {
  fs.rmSync(real, { force: true });
  const on = autostart.plan({ ...base, env: installed, was: false, on: true });
  assert.deepEqual([on.action, on.file], ['write', real]);
  autostart.apply(on);
  const text = fs.readFileSync(real, 'utf8');
  assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=MemoBrOS\n/); assert.match(text, /^Exec="\/opt\/electron" "\/home\/u\/MemoBrOS" --hidden$/m); assert.match(text, /^X-GNOME-Autostart-enabled=true$/m);
  assert.match(autostart.plan({ ...base, env: installed, packaged: true, execPath: '/opt/MemoBrOS/memobros', was: false, on: true }).content, /^Exec="\/opt\/MemoBrOS\/memobros" --hidden$/m, 'an installed build starts itself');
  assert.match(autostart.plan({ ...base, env: { APPIMAGE: '/home/u/MemoBrOS.AppImage' }, packaged: true, was: false, on: true }).content, /^Exec="\/home\/u\/MemoBrOS\.AppImage" --hidden$/m, 'an AppImage starts the AppImage file');
  const off = autostart.plan({ ...base, env: installed, was: true, on: false });
  assert.deepEqual([off.action, off.file], ['remove', real]);
  autostart.apply(off);
  assert.ok(!fs.existsSync(real));
  autostart.apply(off); // removing what is not there is fine
});

test('the entry is only touched when the setting changes, so another copy of the app does not take it over', () => {
  fs.writeFileSync(real, 'written by the other copy\n');
  for (const [was, on] of [[true, true], [false, false]]) assert.equal(autostart.apply(autostart.plan({ ...base, env: installed, was, on })).action, 'none');
  assert.equal(fs.readFileSync(real, 'utf8'), 'written by the other copy\n', 'saving other settings leaves an existing entry alone, on or off');
});

test('Windows and macOS: the login item is set for an installed build only, and only on a change', () => {
  const calls = [];
  const run = (o) => autostart.apply(autostart.plan({ ...base, env: installed, ...o }), (x) => calls.push(x)).action;
  assert.equal(run({ platform: 'win32', packaged: true, was: false, on: true }), 'login-item');
  assert.equal(run({ platform: 'darwin', packaged: true, was: true, on: false }), 'login-item');
  assert.equal(run({ platform: 'win32', packaged: false, was: false, on: true }), 'none', 'a development run is not registered');
  assert.equal(run({ platform: 'win32', packaged: true, was: true, on: true }), 'none');
  assert.deepEqual(calls, [{ openAtLogin: true, args: ['--hidden'] }, { openAtLogin: false, args: ['--hidden'] }]);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
