// Opening desktop applications by name ("ARVI, abre Visual Studio Code"). On Linux this reads the standard
// .desktop entries and starts the chosen one the way the applications menu would, so it works the same on
// Wayland and X11 and needs no special permission. It can only start apps that are installed and listed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { plain } = require('./wake');

function dataDirs() {
  const home = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const system = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [home, ...system, '/var/lib/snapd/desktop', '/var/lib/flatpak/exports/share', path.join(home, 'flatpak', 'exports', 'share')].filter(Boolean).map((d) => path.join(d, 'applications'));
}

function parse(file) {
  const entry = { file };
  let inMain = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('[')) { inMain = line.trim() === '[Desktop Entry]'; continue; }
    if (!inMain) continue;
    const i = line.indexOf('=');
    if (i > 0) entry[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return entry;
}

function list() {
  const seen = new Map();
  for (const dir of dataDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue;
      try {
        const e = parse(path.join(dir, f));
        if (e.Type === 'Application' && e.Exec && e.NoDisplay !== 'true' && e.Hidden !== 'true') seen.set(f, { id: f, name: e.Name || f, names: Object.keys(e).filter((k) => k === 'Name' || k.startsWith('Name[') || k === 'GenericName' || k.startsWith('GenericName[')).map((k) => e[k]), exec: e.Exec, file: e.file });
      } catch { /* unreadable entry */ }
    }
  }
  return [...seen.values()];
}

const ALIASES = { 'vs code': 'visual studio code', vscode: 'visual studio code', code: 'visual studio code', chrome: 'google chrome', navegador: 'web browser', terminal: 'terminal', archivos: 'files' };

// Best installed app for a spoken name, or null.
function find(spoken) {
  const want = plain(spoken).replace(/^(la|el|the|app|aplicacion|application) /, '');
  const q = ALIASES[want] || want;
  if (!q) return null;
  let best = null;
  for (const app of list()) {
    const names = [...app.names, app.id.replace(/\.desktop$/, '').split('.').pop()].map(plain);
    let score = 0;
    for (const n of names) {
      if (n === q) score = Math.max(score, 100);
      else if (n.startsWith(q) || q.startsWith(n)) score = Math.max(score, 70 - Math.abs(n.length - q.length));
      else if (n.includes(q)) score = Math.max(score, 50 - Math.abs(n.length - q.length));
      else if (q.split(' ').every((w) => n.includes(w))) score = Math.max(score, 40);
    }
    if (score > 30 && (!best || score > best.score)) best = { ...app, score };
  }
  return best;
}

// Starts the app detached from MemoBrOS. Returns its display name.
function launch(app) {
  // Field codes (%u, %F, …) stand for files or URLs to open; there are none here.
  const argv = (app.exec.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, '')).filter((a) => !/^%[a-zA-Z]$/.test(a));
  if (!argv.length) throw new Error(`${app.name} has no command to start.`);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return app.name;
}

function open(spoken) {
  if (process.platform !== 'linux') throw new Error('Opening apps by name is only set up for Linux so far.');
  const app = find(spoken);
  if (!app) throw new Error(`I couldn't find an installed app called "${spoken}".`);
  return launch(app);
}

module.exports = { open, find, list };
