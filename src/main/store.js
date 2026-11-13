// Persistent state: settings, memory notes and skills. Everything lives under Electron's userData dir.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  // Which LLM answers. OpenRouter and OmniRoute speak the OpenAI chat format and offer free models.
  provider: 'openrouter', // openrouter | omniroute | anthropic
  providers: {
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
    omniroute: { baseUrl: 'http://localhost:20128/v1', model: 'auto' },
  },
  // The coding agent MemoBrOS drives over the Agent Client Protocol (ACP). Kiro CLI by default.
  codeAgent: {
    enabled: true, command: 'kiro-cli acp', cwd: '',
    validate: '', // optional check run in each agent's worktree and on the combined result, e.g. "npm test"
    protected: ['.env*', '*.pem', '*.key', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.github/workflows/**'], // agents' changes to these are never auto-integrated
  },
  // Kiro Crew is a separate orchestration gateway (not an ACP agent). MemoBrOS can start and stop it on request, nothing more.
  crewGateway: { command: 'kirocrew gateway' },
  mcpServers: [], // [{ id, name, type: 'stdio' | 'http', command, url, trust: 'ask' | 'always', enabled, allowedTools: [] }]
  sharedFolders: null, // folders background agents may pick upload files from; null → Documents, Downloads, Desktop
  model: 'claude-opus-5-5', // Anthropic model, when provider is anthropic
  dictationModel: 'claude-opus-5-5',
  sttProvider: 'local', // local | cloud
  sttLocalModel: 'base', // tiny | base | small (multilingual Whisper, run on this computer)
  sttBaseUrl: 'https://api.openai.com/v1',
  sttCloudModel: 'whisper-1',
  language: 'auto', // ISO code (es, en, fr, ...) or auto
  dictationPolish: true,
  confirmEachAction: false,
  // Capabilities are off until the user allows each one, the first time it is needed.
  permissions: { screen: false, microphone: false, control: false },
  // Wake word: local detection, off until switched on. `aliases` adds extra spellings a recogniser may produce.
  wake: { enabled: false, word: 'ARVI', aliases: '', debug: false },
  micDeviceId: '', // which microphone to use; empty means the system default
  voiceLanguages: ['es-MX', 'en-US'], // preferred voices, first is the default
  displayBackend: 'auto', // Linux: 'auto' (native Wayland on Wayland sessions) or 'x11' (through XWayland)
  window: { compact: false },
  launchAtLogin: false, // start hidden with the system so routines keep running
  speak: true,
  voice: '',
  speechRate: 1.05,
  maxAgentSteps: 30,
  hotkeys: {
    ask: 'CommandOrControl+Alt+Space',
    agent: 'CommandOrControl+Alt+A',
    dictate: 'CommandOrControl+Alt+D',
    next: 'CommandOrControl+Alt+N',
    panel: 'CommandOrControl+Alt+M',
    approve: 'CommandOrControl+Alt+Y',
    stop: 'CommandOrControl+Alt+.',
  },
};

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, value) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2));
}

// ---- settings -------------------------------------------------------------
let settings;
function getSettings() {
  if (!settings) {
    const saved = readJson('settings.json', {});
    settings = { ...DEFAULTS, ...saved, hotkeys: { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) }, providers: mergeProviders(DEFAULTS.providers, saved.providers), codeAgent: { ...DEFAULTS.codeAgent, ...(saved.codeAgent || {}) }, crewGateway: { ...DEFAULTS.crewGateway, ...(saved.crewGateway || {}) },
      permissions: { ...DEFAULTS.permissions, ...(saved.permissions || {}) }, wake: { ...DEFAULTS.wake, ...(saved.wake || {}) }, window: { ...DEFAULTS.window, ...(saved.window || {}) } };
  }
  return settings;
}
const mergeProviders = (a, b = {}) => Object.fromEntries(Object.keys(a).map((k) => [k, { ...a[k], ...(b[k] || {}) }]));
function sharedFolders() {
  const s = getSettings();
  return (s.sharedFolders || ['documents', 'downloads', 'desktop'].map((n) => { try { return app.getPath(n); } catch { return null; } })).filter(Boolean);
}
function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (patch.codeAgent) next.codeAgent = { ...getSettings().codeAgent, ...patch.codeAgent };
  if (patch.crewGateway) next.crewGateway = { ...getSettings().crewGateway, ...patch.crewGateway };
  for (const k of ['permissions', 'wake', 'window']) if (patch[k]) next[k] = { ...getSettings()[k], ...patch[k] };
  if (patch.providers) next.providers = mergeProviders(getSettings().providers, patch.providers);
  if (patch.hotkeys) next.hotkeys = { ...getSettings().hotkeys, ...patch.hotkeys };
  settings = next;
  writeJson('settings.json', next);
  return next;
}

// ---- secrets (API keys), encrypted with the OS keychain when available ------
function getSecret(name) {
  const env = { anthropic: process.env.ANTHROPIC_API_KEY, openrouter: process.env.OPENROUTER_API_KEY, omniroute: process.env.OMNIROUTE_API_KEY, stt: process.env.MEMOBROS_STT_API_KEY || process.env.OPENAI_API_KEY }[name];
  const stored = readJson('secrets.json', {})[name];
  if (!stored) return env || '';
  try {
    if (stored.enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
    if (stored.plain) return stored.plain;
  } catch { /* fall through to env */ }
  return env || '';
}
function setSecret(name, value) {
  const all = readJson('secrets.json', {});
  if (!value) delete all[name];
  else if (safeStorage.isEncryptionAvailable()) all[name] = { enc: safeStorage.encryptString(value).toString('base64') };
  else all[name] = { plain: value };
  writeJson('secrets.json', all);
}

// ---- memory ("Memo" remembers) ---------------------------------------------
function getMemory() { return readJson('memory.json', []); }
function addMemory(note) {
  const all = getMemory();
  const entry = { id: Date.now().toString(36), note: String(note).trim(), at: new Date().toISOString() };
  all.push(entry);
  writeJson('memory.json', all);
  return entry;
}
function deleteMemory(id) { writeJson('memory.json', getMemory().filter((m) => m.id !== id)); }

// ---- skills: markdown files with a tiny frontmatter -------------------------
const skillsDir = () => path.join(dir(), 'skills');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';

function parseSkill(text, id) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { id, name: meta.name || id, description: meta.description || '', body: (m ? m[2] : text).trim() };
}
function seedSkills() {
  if (fs.existsSync(skillsDir())) return;
  fs.mkdirSync(skillsDir(), { recursive: true });
  const bundled = path.join(__dirname, '..', '..', 'skills');
  for (const f of fs.readdirSync(bundled)) if (f.endsWith('.md')) fs.copyFileSync(path.join(bundled, f), path.join(skillsDir(), f));
}
function listSkills() {
  seedSkills();
  return fs.readdirSync(skillsDir()).filter((f) => f.endsWith('.md')).sort()
    .map((f) => parseSkill(fs.readFileSync(path.join(skillsDir(), f), 'utf8'), f.slice(0, -3)));
}
function saveSkill({ id, name, description, body }) {
  seedSkills();
  const newId = slug(name);
  if (id && id !== newId) fs.rmSync(path.join(skillsDir(), `${slug(id)}.md`), { force: true });
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  fs.writeFileSync(path.join(skillsDir(), `${newId}.md`), `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n---\n\n${String(body || '').trim()}\n`);
  return newId;
}
function deleteSkill(id) { fs.rmSync(path.join(skillsDir(), `${slug(id)}.md`), { force: true }); }

// ---- routines and upload grants ----------------------------------------------
const getRoutines = () => readJson('routines.json', []);
const saveRoutines = (list) => writeJson('routines.json', list);
const getGrants = () => readJson('grants.json', []);
const addGrant = (grant) => writeJson('grants.json', [...getGrants(), grant]);

module.exports = { DEFAULTS, sharedFolders, getRoutines, saveRoutines, getGrants, addGrant, getSettings, saveSettings, getSecret, setSecret, getMemory, addMemory, deleteMemory, listSkills, saveSkill, deleteSkill };
