// "Start with the system". Deciding what to do is kept apart from doing it, so the rules can be tested without
// touching anyone's desktop configuration. No Electron here.
//
// Two rules protect the user's real autostart entry:
//  1. Only the installed profile manages it. A run with its own settings folder (MEMOBROS_USER_DATA) or a test
//     run (MEMOBROS_TEST) is a temporary profile: it never writes, replaces or removes the entry, whatever its
//     settings say. This is decided by how the app was started, not by comparing folder names.
//     A temporary profile may be given a folder of its own to manage instead (MEMOBROS_AUTOSTART_DIR); that is
//     how the tests exercise the real code without reaching the real entry.
//  2. The entry is only touched when the user changes the setting. Saving other settings leaves it alone, so a
//     second copy of the app does not take over, or delete, an entry it did not create.
const fs = require('fs');
const path = require('path');

const FILE = 'memobros.desktop';

// → { kind: 'installed' | 'temporary', manages, dir (override or null), reason }
function profile(env = process.env) {
  const temporary = Boolean(env.MEMOBROS_USER_DATA || env.MEMOBROS_TEST);
  const dir = env.MEMOBROS_AUTOSTART_DIR ? path.resolve(env.MEMOBROS_AUTOSTART_DIR) : null;
  if (!temporary) return { kind: 'installed', manages: true, dir, reason: '' };
  if (dir) return { kind: 'temporary', manages: true, dir, reason: '' };
  return { kind: 'temporary', manages: false, dir: null, reason: 'This is a temporary profile (it uses its own settings folder), so it does not change whether MemoBrOS starts with the system.' };
}

// What saving the settings should do. `was`/`on`: the setting before and after the save.
// → { action: 'none' | 'write' | 'remove' | 'login-item', file?, content?, on?, why }
function plan({ was, on, env = process.env, platform = process.platform, home, packaged = false, execPath = '', appPath = '', appImage = env.APPIMAGE || '' }) {
  const p = profile(env);
  if (!p.manages) return { action: 'none', why: p.reason };
  if (Boolean(was) === Boolean(on)) return { action: 'none', why: 'the setting did not change' };
  if (platform === 'linux') {
    const file = path.join(p.dir || path.join(home, '.config', 'autostart'), FILE);
    if (!on) return { action: 'remove', file, why: 'the user turned it off' };
    const exec = appImage || (packaged ? execPath : `${execPath}" "${appPath}`);
    return { action: 'write', file, why: 'the user turned it on', content: `[Desktop Entry]\nType=Application\nName=MemoBrOS\nComment=Screen-aware AI buddy\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n` };
  }
  // Windows and macOS register the program itself, which only makes sense for an installed build.
  if (p.dir) return { action: 'none', why: 'a folder override only applies on Linux' };
  if (packaged || !on) return { action: 'login-item', on: Boolean(on), why: on ? 'the user turned it on' : 'the user turned it off' };
  return { action: 'none', why: 'not an installed build' };
}

// Carries out a plan. `setLoginItem` is Electron's app.setLoginItemSettings, passed in by the caller.
function apply(step, setLoginItem) {
  if (step.action === 'write') { fs.mkdirSync(path.dirname(step.file), { recursive: true }); fs.writeFileSync(step.file, step.content); }
  else if (step.action === 'remove') fs.rmSync(step.file, { force: true });
  else if (step.action === 'login-item') setLoginItem({ openAtLogin: step.on, args: ['--hidden'] });
  return step;
}

module.exports = { profile, plan, apply, FILE };
