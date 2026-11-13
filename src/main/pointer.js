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

module.exports = { ExtensionPointer };
