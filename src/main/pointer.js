// The assistant pointer outside MemoBrOS's own window.
//
// Two back ends draw it:
//  - "overlay": MemoBrOS's transparent click-through window (X11, Windows, macOS), handled in main.js.
//  - "gnome-extension": on native Wayland no application may draw above others, so the optional MemoBrOS Pointer
//    GNOME Shell extension draws it; this file talks to it over the session D-Bus with the `gdbus` tool.
// It never moves or replaces the real cursor, and never clicks: showing where something is and acting on it are
// separate, separately permitted things.
//
// Follow mode: the pointer accompanies the real cursor. Guide mode: it flies to a target and highlights it.
const { execFile } = require('child_process');

const DEST = 'org.memobros.Pointer', PATH = '/org/memobros/Pointer';
const str = (s) => JSON.stringify(String(s ?? '')); // a GVariant string literal

class ExtensionPointer {
  constructor(iconPath) { this.icon = iconPath; this.available = false; this.heartbeat = null; this.follow = false; }

  call(method, ...args) {
    return new Promise((resolve) => {
      execFile('gdbus', ['call', '--session', '--dest', DEST, '--object-path', PATH, '--method', `${DEST}.${method}`, '--', ...args.map(String)], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
  }
  // Is the extension installed, enabled and answering?
  async detect() {
    this.available = (await this.call('Ping')) !== null;
    clearInterval(this.heartbeat);
    // The extension hides everything when these stop, so a crashed MemoBrOS leaves nothing on screen.
    if (this.available) { this.heartbeat = setInterval(() => this.call('Ping').then((r) => { if (r === null) this.available = false; }), 5000); this.heartbeat.unref?.(); }
    return this.available;
  }
  async setFollow(on, { offsetX = 14, offsetY = 16, size = 48 } = {}) {
    this.follow = !!on;
    if (this.available) await this.call('SetFollow', on ? 'true' : 'false', str(this.icon), Math.round(offsetX), Math.round(offsetY), Math.round(size));
  }
  // The monitor a screenshot most likely shows: the one under the pointer, else the primary one.
  async monitor() {
    const out = await this.call('GetMonitors');
    try {
      const { monitors } = JSON.parse(/^\('(.*)',\)$/s.exec(out)[1].replace(/\\'/g, "'"));
      return monitors.find((m) => m.current) || monitors.find((m) => m.primary) || monitors[0];
    } catch { return null; }
  }
  // Screenshot pixels → desktop coordinates on that monitor.
  static map(shot, mon, x, y) { return { x: Math.round(mon.x + (x * mon.width) / shot.w), y: Math.round(mon.y + (y * mon.height) / shot.h) }; }

  async pointAt(shot, x, y, label, seconds = 9) {
    const mon = this.available && (await this.monitor());
    if (!mon) return false;
    const p = ExtensionPointer.map(shot, mon, x, y);
    return (await this.call('PointAt', p.x, p.y, str(label), seconds)) !== null;
  }
  async highlight(shot, box, label, seconds = 20) {
    const mon = this.available && (await this.monitor());
    if (!mon) return false;
    const a = ExtensionPointer.map(shot, mon, Math.min(box.x, box.x2), Math.min(box.y, box.y2)), b = ExtensionPointer.map(shot, mon, Math.max(box.x, box.x2), Math.max(box.y, box.y2));
    return (await this.call('Highlight', a.x, a.y, Math.max(8, b.x - a.x), Math.max(8, b.y - a.y), str(label), seconds)) !== null;
  }
  clear() { return this.available ? this.call('Clear') : Promise.resolve(null); }
  async stop() { clearInterval(this.heartbeat); if (this.available) { await this.call('SetFollow', 'false', str(''), 0, 0, 0); await this.call('Clear'); } }
}

// ---- installing the optional GNOME Shell extension from inside the app ------------------------------
// Each step runs only after the user approves it in MemoBrOS. Installing copies two files into the user's own
// extensions folder; enabling asks GNOME to load it; removing disables it and deletes those files.
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = 'memobros-pointer@memobros.app';
const source = () => path.join(__dirname, '..', '..', 'gnome-extension', UUID);
const target = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'gnome-shell', 'extensions', UUID);
const gnome = (...args) => new Promise((resolve) => execFile('gnome-extensions', args, { timeout: 5000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })));

async function extensionStatus() {
  const installed = fs.existsSync(path.join(target(), 'extension.js'));
  const info = installed ? await gnome('info', UUID) : { ok: false, out: '' };
  // GNOME only notices a newly copied extension at the next login, so "installed but unknown" means: log in again.
  return { uuid: UUID, folder: target(), installed, known: info.ok, enabled: info.ok && /(Enabled|Habilitad[oa]|Activad[oa]):\s*(Yes|Sí|Si)|State:\s*(ENABLED|ACTIVE)|Estado:\s*(ACTIVA|HABILITADA|ENABLED|ACTIVE)/i.test(info.out) };
}
function installExtension() {
  fs.mkdirSync(target(), { recursive: true });
  for (const f of fs.readdirSync(source())) fs.writeFileSync(path.join(target(), f), fs.readFileSync(path.join(source(), f)));
  return extensionStatus();
}
async function enableExtension() {
  const r = await gnome('enable', UUID);
  if (!r.ok) throw new Error(/exist|existe/i.test(r.out) ? 'GNOME does not know the extension yet. Log out and log in again, then press Enable.' : `GNOME could not enable the extension: ${r.out || 'the gnome-extensions tool is not available'}`);
  return extensionStatus();
}
async function removeExtension() {
  await gnome('disable', UUID);
  fs.rmSync(target(), { recursive: true, force: true });
  return extensionStatus();
}

module.exports = { ExtensionPointer, extensionStatus, installExtension, enableExtension, removeExtension };
