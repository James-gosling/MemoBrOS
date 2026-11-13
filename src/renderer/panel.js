// MemoBrOS control panel: chat, mic capture + voice activity detection, text-to-speech, skills, memory, settings.
const $ = (id) => document.getElementById(id);
const call = (channel, payload) => window.memo.invoke(channel, payload);
const h = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

let S = null;        // app state from the main process
let mode = 'ask';
let editingSkill = null;

const LANGS = { auto: 'Auto-detect', en: 'English', es: 'Español', pt: 'Português', fr: 'Français', de: 'Deutsch', it: 'Italiano', nl: 'Nederlands', ca: 'Català', gl: 'Galego', eu: 'Euskara', sv: 'Svenska', da: 'Dansk', no: 'Norsk', fi: 'Suomi', is: 'Íslenska', pl: 'Polski', cs: 'Čeština', sk: 'Slovenčina', hu: 'Magyar', ro: 'Română', bg: 'Български', hr: 'Hrvatski', sr: 'Српски', sl: 'Slovenščina', uk: 'Українська', ru: 'Русский', el: 'Ελληνικά', tr: 'Türkçe', ar: 'العربية', he: 'עברית', fa: 'فارسی', ur: 'اردو', hi: 'हिन्दी', bn: 'বাংলা', ta: 'தமிழ்', te: 'తెలుగు', mr: 'मराठी', gu: 'ગુજરાતી', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', pa: 'ਪੰਜਾਬੀ', ne: 'नेपाली', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', tl: 'Tagalog', zh: '中文', ja: '日本語', ko: '한국어', sw: 'Kiswahili', af: 'Afrikaans', et: 'Eesti', lv: 'Latviešu', lt: 'Lietuvių', cy: 'Cymraeg', hy: 'Հայերեն', az: 'Azərbaycan', kk: 'Қазақ' };
const HOTKEY_LABELS = { ask: 'Ask about screen', agent: 'Agent mode', dictate: 'Dictation', next: 'Next walkthrough step', panel: 'Show / hide panel', approve: 'Approve', stop: 'Stop everything' };
const pretty = (acc) => String(acc).replace('CommandOrControl', S?.platform === 'darwin' ? '⌘' : 'Ctrl').replace('Alt', S?.platform === 'darwin' ? '⌥' : 'Alt').replace(/\+/g, ' ');

// ---- tabs -----------------------------------------------------------------------
function showTab(tab) {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === `tab-${tab}`);
}
$('tabs').addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));

// ---- chat -----------------------------------------------------------------------
function addMessage({ role, text, tag, routineFrom }) {
  $('messages').querySelector('.empty')?.remove();
  const m = h('div', { className: `msg ${role}` });
  if (tag) m.append(h('span', { className: 'tag', textContent: tag }));
  m.append(text);
  if (routineFrom) { // chat-to-routine: one click turns this finished agent task into a scheduled routine
    m.append(h('button', { className: 'make-routine', textContent: '↻ Repeat this on a schedule', onclick: async (e) => {
      e.target.disabled = true;
      S = await call('routine:fromChat', routineFrom);
      renderRoutines(); showTab('routines');
      editRoutine(S.routines.find((r) => r.id === S.createdId));
    } }));
  }
  $('messages').append(m);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function renderEmpty() {
  if ($('messages').children.length) return;
  const hk = S.settings.hotkeys;
  const kbd = (a) => h('kbd', { textContent: pretty(a) });
  const e = h('div', { className: 'empty' });
  e.append(h('p', {}, 'Hi, I\'m Memo. Press ', kbd(hk.ask), ' and ask about anything on your screen. I\'ll point at it.'), h('br'),
    h('p', {}, kbd(hk.agent), ' and I do it for you. ', kbd(hk.dictate), ' to dictate into any app.'));
  if (!S.hasKey) e.append(h('br'), h('p', { style: 'color:var(--memo)' }, `First, add your ${S.llm.name} API key in Settings. OpenRouter keys are free.`));
  $('messages').append(e);
}

function setMode(m) {
  mode = m;
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.mode === m);
  const hk = S.settings.hotkeys;
  $('text').placeholder = { ask: 'Ask about your screen…', agent: 'Tell Memo what to do…', dictate: 'Press the mic, then speak into any app' }[m];
  $('text').disabled = $('send').disabled = m === 'dictate';
  $('hint').replaceChildren('Hotkey ', h('kbd', { textContent: pretty(hk[m]) }), m === 'dictate' ? ' toggles dictation. Text lands wherever your cursor is.' : m === 'agent' ? ' · or say "memo agent, …"' : ' · press again when you\'re done talking');
}
$('modes').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  call('request', { text, mode });
});
$('mic').addEventListener('click', () => call('listen:toggle', { mode }));
$('stop').addEventListener('click', () => call('stop'));

// attachments
function renderAttachments(list) {
  $('attachments').replaceChildren(...list.map((a) => h('span', { className: 'chip', title: a.path },
    h('span', { textContent: a.name }),
    h('button', { textContent: '✕', title: 'Remove', onclick: async () => renderAttachments((await call('attach:remove', { path: a.path })).attachments) }))));
}
async function attached(result) {
  renderAttachments(result.attachments);
  for (const err of result.errors || []) addMessage({ role: 'error', text: err });
}
$('attach').addEventListener('click', async () => attached(await call('attach:pick')));
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', () => document.body.classList.remove('dragging'));
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map((f) => window.memo.pathFor(f)).filter(Boolean);
  if (paths.length) attached(await call('attach:add', { paths }));
});

// walkthrough + confirmation cards
function renderWalk(walk) {
  $('walk').hidden = !walk;
  if (!walk) return;
  $('walk-title').textContent = walk.title;
  $('walk-count').textContent = `${walk.i + 1} / ${walk.steps.length}`;
  $('walk-steps').replaceChildren(...walk.steps.map((s, i) => h('li', { textContent: s, className: i === walk.i ? 'now' : i < walk.i ? 'past' : '' })));
  $('walk-steps').querySelector('.now')?.scrollIntoView({ block: 'nearest' });
  $('walk-next').textContent = walk.i === walk.steps.length - 1 ? 'Finish' : 'Next step';
  $('walk-back').disabled = walk.i === 0;
}
$('walk-next').addEventListener('click', () => call('walk:move', { delta: 1 }));
$('walk-back').addEventListener('click', () => call('walk:move', { delta: -1 }));
$('walk-stop').addEventListener('click', () => call('walk:stop'));

function renderConfirm(c) {
  $('confirm').hidden = !c;
  if (!c) return;
  $('confirm-title').textContent = c.title;
  $('confirm-text').textContent = c.text;
  $('confirm-always').hidden = !c.always;
  $('confirm-always').textContent = c.always || '';
  $('confirm-hint').replaceChildren('Or press ', h('kbd', { textContent: pretty(c.hotkey) }), ' / say "yes".');
}
$('confirm-yes').addEventListener('click', () => call('confirm:answer', { ok: true }));
$('confirm-always').addEventListener('click', () => call('confirm:answer', { ok: 'always' }));
$('confirm-no').addEventListener('click', () => call('confirm:answer', { ok: false }));

function renderStatus({ kind, text }) {
  $('status').dataset.kind = kind;
  $('status-text').textContent = text || { idle: 'Ready', listening: 'Listening…', dictating: 'Dictating. Speak, I\'m typing', thinking: 'Thinking…', acting: 'Agent running' }[kind] || kind;
  $('stop').hidden = kind === 'idle';
}

// ---- text to speech ------------------------------------------------------------------
function speak(text) {
  if (!S.settings.speak || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const lang = S.settings.language;
  u.voice = voices.find((v) => v.name === S.settings.voice) || (lang !== 'auto' && voices.find((v) => v.lang.toLowerCase().startsWith(lang))) || null;
  u.rate = S.settings.speechRate || 1;
  speechSynthesis.speak(u);
}
const shutUp = () => window.speechSynthesis && speechSynthesis.cancel();

// ---- microphone capture with simple voice-activity detection ----------------------------
// Audio is captured as 16 kHz mono PCM. Ask/agent: one utterance, ended by a pause or the hotkey.
// Dictation: continuous; every pause flushes a segment that is transcribed and typed while you keep talking.
const RATE = 16000, FRAME = 4096, FRAME_MS = (FRAME / RATE) * 1000;
let rec = null;

async function startRec(recMode) {
  if (rec) await stopRec(false);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { addMessage({ role: 'error', text: `Microphone unavailable: ${e.message}. You can still type.` }); call('listen:ended'); return; }
  const ctx = new AudioContext({ sampleRate: RATE });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(FRAME, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  source.connect(node); node.connect(mute); mute.connect(ctx.destination);
  const r = rec = { mode: recMode, stream, ctx, node, chunks: [], speechMs: 0, silenceMs: 0, totalMs: 0, noise: 0.004 };
  node.onaudioprocess = (e) => {
    if (rec !== r) return;
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const loud = rms > Math.max(0.012, r.noise * 3.5);
    if (!loud) r.noise = r.noise * 0.9 + rms * 0.1;
    $('mic').style.setProperty('--level', Math.min(1, rms * 12).toFixed(2));
    if (loud) { r.speechMs += FRAME_MS; r.silenceMs = 0; } else r.silenceMs += FRAME_MS;
    if (r.speechMs || r.chunks.length < 2) r.chunks.push(data); else r.chunks = [r.chunks[r.chunks.length - 1], data]; // keep a little lead-in
    r.totalMs += FRAME_MS;
    const segMs = r.chunks.length * FRAME_MS;
    if (r.mode === 'dictate') {
      if (r.speechMs >= 250 && (r.silenceMs >= 700 || segMs >= 25000)) flush(r, false);
    } else if ((r.speechMs >= 250 && r.silenceMs >= 1500) || segMs >= 45000) stopRec(true);
    else if (!r.speechMs && r.totalMs >= 9000) stopRec(true);
  };
  $('mic').classList.add('on');
}

function flush(r, final) {
  const had = r.speechMs >= 250;
  const chunks = r.chunks;
  r.chunks = []; r.speechMs = 0; r.silenceMs = 0;
  if (!had) return false;
  const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  call('audio:segment', { pcm: pcm.buffer, mode: r.mode, final });
  return true;
}

async function stopRec(send) {
  const r = rec;
  if (!r) return;
  rec = null;
  r.node.onaudioprocess = null;
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close();
  $('mic').classList.remove('on');
  const sent = send && flush(r, true);
  if (!sent || r.mode === 'dictate') call('listen:ended');
}

// ---- skills -----------------------------------------------------------------------------
function renderSkills() {
  $('skill-list').replaceChildren(...S.skills.map((s) => {
    const pinned = s.id === S.pinnedSkillId;
    return h('div', { className: `item${pinned ? ' pinned' : ''}` },
      h('div', { className: 'grow' }, h('b', { textContent: s.name }), h('span', { textContent: s.description })),
      h('button', { textContent: pinned ? 'Unpin' : 'Pin', onclick: async () => { S = await call('skill:pin', { id: s.id }); renderSkills(); } }),
      h('button', { textContent: 'Edit', onclick: () => editSkill(s) }),
      h('button', { textContent: '✕', className: 'danger', title: 'Delete', onclick: async () => { S = await call('skill:delete', { id: s.id }); renderSkills(); } }));
  }));
}
function editSkill(s) {
  editingSkill = s;
  $('skill-form-title').textContent = s ? `Edit "${s.name}"` : 'New skill';
  $('skill-name').value = s?.name || ''; $('skill-desc').value = s?.description || ''; $('skill-body').value = s?.body || '';
  if (s) $('skill-form').scrollIntoView({ behavior: 'smooth' });
}
$('skill-cancel').addEventListener('click', () => editSkill(null));
$('skill-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  S = await call('skill:save', { id: editingSkill?.id, name: $('skill-name').value, description: $('skill-desc').value, body: $('skill-body').value });
  editSkill(null); renderSkills();
});

// ---- memory -----------------------------------------------------------------------------
function renderMemory() {
  $('memory-list').replaceChildren(...S.memory.slice().reverse().map((m) => h('div', { className: 'item' },
    h('div', { className: 'grow', textContent: m.note }),
    h('button', { textContent: '✕', className: 'danger', title: 'Forget', onclick: async () => { S = await call('memory:delete', { id: m.id }); renderMemory(); } }))));
  if (!S.memory.length) $('memory-list').append(h('p', { className: 'muted small', textContent: 'Nothing remembered yet.' }));
}
$('memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  S = await call('memory:add', { note: $('memory-note').value });
  $('memory-note').value = ''; renderMemory();
});

// ---- routines ---------------------------------------------------------------------------
let editingRoutine = null;
const clean = (err) => err.message.replace(/^Error invoking remote method 'memo': Error: /, '');
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
function renderRoutines() {
  $('routine-list').replaceChildren(...S.routines.map((r) => {
    const last = r.lastRun;
    const info = h('div', { className: 'grow' }, h('b', { textContent: r.name }),
      h('span', { className: 'meta', textContent: `${r.scheduleText} · ${r.desktop ? 'on screen' : 'background'}` }),
      h('span', { className: 'meta', textContent: r.running ? 'Running now…' : r.enabled ? `Next: ${fmtWhen(r.nextRun)}` : 'Paused' }));
    if (last) info.append(h('span', { className: `meta ${last.status === 'ok' ? 'ok' : 'bad'}`, textContent: `${fmtWhen(last.at)}: ${last.summary}`.slice(0, 220) }));
    const act = async (channel, payload) => { try { S = await call(channel, payload); renderRoutines(); } catch (e) { $('routine-note').textContent = clean(e); } };
    return h('div', { className: `item${r.enabled ? '' : ' off'}${r.running ? ' running' : ''}` }, info, h('div', { className: 'btns' },
      h('button', { textContent: 'Run now', disabled: r.running, onclick: () => act('routine:run', { id: r.id }) }),
      h('button', { textContent: r.enabled ? 'Pause' : 'Resume', onclick: () => act('routine:toggle', { id: r.id, enabled: !r.enabled }) }),
      h('button', { textContent: 'Edit', onclick: () => editRoutine(r) }),
      h('button', { textContent: 'Delete', className: 'danger', onclick: () => act('routine:delete', { id: r.id }) })));
  }));
  if (!S.routines.length) $('routine-list').append(h('p', { className: 'muted small', textContent: 'No routines yet.' }));
  $('folder-list').replaceChildren(...S.sharedFolders.map((f) => h('div', { className: 'item' }, h('div', { className: 'grow', textContent: f }),
    h('button', { textContent: '✕', className: 'danger', onclick: async () => { S = await call('folders:remove', { folder: f }); renderRoutines(); } }))));
}
function editRoutine(r) {
  editingRoutine = r || null;
  $('routine-form').hidden = !r;
  if (!r) return;
  $('routine-name').value = r.name; $('routine-task').value = r.task; $('routine-when').value = r.scheduleText; $('routine-desktop').checked = r.desktop;
  $('routine-form').scrollIntoView({ behavior: 'smooth' });
}
$('routine-cancel').addEventListener('click', () => editRoutine(null));
$('routine-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('routine-note').textContent = 'Saving…';
  try {
    S = await call('routine:save', { id: editingRoutine.id, name: $('routine-name').value, task: $('routine-task').value, scheduleText: $('routine-when').value, desktop: $('routine-desktop').checked });
    $('routine-note').textContent = ''; editRoutine(null); renderRoutines();
  } catch (err) { $('routine-note').textContent = clean(err); }
});
$('routine-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('routine-text').value.trim();
  if (!text) return;
  $('routine-note').textContent = 'Working out the schedule…';
  try { S = await call('routine:create', { text }); $('routine-text').value = ''; $('routine-note').textContent = ''; renderRoutines(); }
  catch (err) { $('routine-note').textContent = clean(err); }
});
$('web-connect').addEventListener('submit', (e) => { e.preventDefault(); call('web:connect', { url: $('web-url').value.trim() }); });
$('folder-add').addEventListener('click', async () => { S = await call('folders:pick'); renderRoutines(); });

// Sites to sign in to in the background browser. Google first: its session unlocks Workspace and "Continue with Google" elsewhere.
const ACCOUNTS = [['Google account', 'accounts.google.com'], ['Gmail', 'mail.google.com'], ['Drive', 'drive.google.com'], ['Docs', 'docs.google.com'], ['Sheets', 'sheets.google.com'], ['Calendar', 'calendar.google.com'],
  ['Notion', 'www.notion.so/login'], ['GitHub', 'github.com/login'], ['Figma', 'www.figma.com/login'], ['ChatGPT', 'chatgpt.com'], ['Claude', 'claude.ai/login']];
$('account-links').replaceChildren(...ACCOUNTS.map(([name, url]) => h('button', { type: 'button', textContent: name, onclick: () => call('web:connect', { url }) })));

// Ready-made MCP connectors. Clicking one fills the form below; "note" says what the service still needs from you.
const MCP_PRESETS = [
  { name: 'Notion', type: 'http', url: 'https://mcp.notion.com/mcp', note: 'Press Connect, then approve MemoBrOS in the Notion page that opens in your browser.' },
  { name: 'GitHub', type: 'http', url: 'https://api.githubcopilot.com/mcp/', needsToken: true, note: 'Paste a GitHub personal access token (github.com/settings/tokens) as the access token, then Connect.' },
  { name: 'Google Workspace', type: 'stdio', command: 'uvx workspace-mcp --tool-tier core', env: 'GOOGLE_OAUTH_CLIENT_ID=\nGOOGLE_OAUTH_CLIENT_SECRET=', note: 'Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms, Tasks and Chat. Needs "uv" installed and a Google Cloud OAuth client (Desktop app): fill in its ID and secret. Google sign-in opens on first use.' },
  { name: 'Figma', type: 'http', url: 'https://mcp.figma.com/mcp', note: 'Press Connect and sign in to Figma in your browser. If Figma refuses the app, use "Figma desktop" instead.' },
  { name: 'Figma desktop', type: 'http', url: 'http://127.0.0.1:3845/mcp', note: 'Needs the Figma desktop app open with its MCP server enabled (Dev Mode → MCP).' },
  { name: 'Claude Code', type: 'stdio', command: 'claude mcp serve', note: 'Lets Memo hand work to Claude Code. Needs the "claude" CLI installed and signed in.' },
  { name: 'ChatGPT (Codex)', type: 'stdio', command: 'codex mcp-server', note: 'Lets Memo hand work to OpenAI\'s Codex agent with your ChatGPT sign-in. Needs the "codex" CLI installed and signed in.' },
];
$('mcp-presets').replaceChildren(...MCP_PRESETS.map((p) => h('button', { type: 'button', textContent: p.name, onclick: () => {
  $('mcp-name').value = p.name; $('mcp-type').value = p.type; $('mcp-command').value = p.command || ''; $('mcp-url').value = p.url || ''; $('mcp-env').value = p.env || ''; $('mcp-token').value = '';
  showMcpKind(); $('mcp-note').textContent = p.note;
  $('mcp-form').scrollIntoView({ behavior: 'smooth' }); (p.needsToken ? $('mcp-token') : p.env ? $('mcp-env') : $('mcp-name')).focus();
} })));

// ---- custom MCP servers -----------------------------------------------------------------
function renderMcp() {
  $('mcp-list').replaceChildren(...S.settings.mcpServers.map((c) => {
    const st = S.mcp.find((m) => m.id === c.id) || { status: 'connecting', tools: [] };
    const line = st.status === 'connected' ? `Connected · ${st.tools.length} tools: ${st.tools.slice(0, 6).join(', ')}${st.tools.length > 6 ? '…' : ''}` : st.status === 'error' ? `Failed: ${st.error}` : st.status;
    return h('div', { className: 'item' }, h('div', { className: 'grow' }, h('b', { textContent: c.name }),
      h('span', { className: 'meta', textContent: c.type === 'http' ? c.url : c.command }),
      h('span', { className: `meta ${st.status === 'connected' ? 'ok' : st.status === 'error' ? 'bad' : ''}`, textContent: line })),
    h('div', { className: 'btns' },
      h('button', { textContent: st.status === 'error' && /sign.?in/i.test(st.error) ? 'Sign in' : 'Retry', onclick: async () => { S = await call('mcp:reconnect', { id: c.id }); renderMcp(); } }),
      h('button', { textContent: 'Remove', className: 'danger', onclick: async () => { S = await call('mcp:delete', { id: c.id }); renderMcp(); } })));
  }));
}
function showMcpKind() {
  const http = $('mcp-type').value === 'http';
  $('mcp-command-row').hidden = http; $('mcp-env-row').hidden = http; $('mcp-url-row').hidden = !http; $('mcp-token-row').hidden = !http;
}
$('mcp-type').addEventListener('change', showMcpKind);
$('mcp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('mcp-note').textContent = 'Connecting… (if a sign-in page opens in your browser, finish it there)';
  try {
    const payload = { server: { name: $('mcp-name').value, type: $('mcp-type').value, command: $('mcp-command').value, env: $('mcp-env').value, url: $('mcp-url').value, trust: $('mcp-trust').value } };
    if ($('mcp-token').value) payload.token = $('mcp-token').value;
    S = await call('mcp:save', payload);
    $('mcp-form').reset(); showMcpKind(); $('mcp-note').textContent = ''; renderMcp();
  } catch (err) { $('mcp-note').textContent = clean(err); }
});

// ---- settings ---------------------------------------------------------------------------
function fillVoices() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  $('set-voice').replaceChildren(h('option', { value: '', textContent: 'System default' }), ...voices.map((v) => h('option', { value: v.name, textContent: `${v.name} (${v.lang})` })));
  $('set-voice').value = S?.settings.voice || '';
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoices;

function renderSettings() {
  const s = S.settings;
  $('set-provider').value = s.provider;
  showProvider();
  $('set-or-key').value = ''; $('set-or-key').placeholder = S.keys.openrouter ? 'Saved. Paste a new key to replace it' : 'sk-or-… (free at openrouter.ai/keys)';
  $('set-or-model').value = s.providers.openrouter.model;
  $('set-omni-url').value = s.providers.omniroute.baseUrl; $('set-omni-model').value = s.providers.omniroute.model;
  $('set-omni-key').value = ''; $('set-omni-key').placeholder = S.keys.omniroute ? 'Saved' : 'Optional for a local gateway';
  $('set-key').value = ''; $('set-key').placeholder = S.keys.anthropic ? 'Saved. Paste a new key to replace it' : 'sk-ant-…';
  $('set-model').value = s.model; $('set-dict-model').value = s.dictationModel;
  $('set-stt').value = s.sttProvider; $('set-stt-url').value = s.sttBaseUrl; $('set-stt-model').value = s.sttCloudModel;
  $('set-stt-key').value = ''; $('set-stt-key').placeholder = S.hasSttKey ? 'Saved' : 'API key for the endpoint';
  $('stt-cloud').hidden = s.sttProvider !== 'cloud';
  $('set-lang').replaceChildren(...Object.entries(LANGS).map(([value, textContent]) => h('option', { value, textContent })));
  $('set-lang').value = s.language;
  $('set-autostart').checked = !!s.launchAtLogin;
  $('set-speak').checked = s.speak; $('set-polish').checked = s.dictationPolish; $('set-confirm-each').checked = s.confirmEachAction;
  fillVoices();
  $('hotkeys').replaceChildren(...Object.entries(HOTKEY_LABELS).map(([k, label]) => h('div', { className: 'hk' }, label, h('input', { value: s.hotkeys[k], id: `hk-${k}` }))));
}
function showProvider() {
  const p = $('set-provider').value;
  for (const k of ['openrouter', 'omniroute', 'anthropic']) $(`prov-${k}`).hidden = k !== p;
  $('dict-model-row').hidden = p !== 'anthropic';
}
$('set-provider').addEventListener('change', showProvider);
async function findModels(provider, listId, noteId, inputId) {
  $(noteId).textContent = 'Loading…';
  try {
    const models = await call('models:list', { provider });
    const good = provider === 'openrouter' ? models.filter((m) => m.free) : models;
    $(listId).replaceChildren(...good.map((m) => h('option', { value: m.id, label: `${m.name}${m.vision ? ' · sees images' : ''}${m.tools ? ' · tools' : ''}` })));
    const best = good.find((m) => m.vision && m.tools);
    $(noteId).textContent = good.length ? `${good.length} ${provider === 'openrouter' ? 'free ' : ''}models. Pick one that sees images and calls tools${best ? `, e.g. ${best.id}` : ''}.` : 'No models found.';
    $(inputId).focus();
  } catch (e) { $(noteId).textContent = e.message.replace(/^Error invoking remote method 'memo': Error: /, ''); }
}
$('or-find').addEventListener('click', () => findModels('openrouter', 'or-models', 'or-note', 'set-or-model'));
$('omni-find').addEventListener('click', () => findModels('omniroute', 'omni-models', 'omni-note', 'set-omni-model'));
$('set-stt').addEventListener('change', () => { $('stt-cloud').hidden = $('set-stt').value !== 'cloud'; });
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    settings: {
      provider: $('set-provider').value,
      providers: { openrouter: { model: $('set-or-model').value.trim() || 'openrouter/free' }, omniroute: { baseUrl: $('set-omni-url').value.trim() || 'http://localhost:20128/v1', model: $('set-omni-model').value.trim() || 'auto' } },
      model: $('set-model').value, dictationModel: $('set-dict-model').value, sttProvider: $('set-stt').value,
      sttBaseUrl: $('set-stt-url').value.trim(), sttCloudModel: $('set-stt-model').value.trim(), language: $('set-lang').value,
      launchAtLogin: $('set-autostart').checked,
      speak: $('set-speak').checked, voice: $('set-voice').value, dictationPolish: $('set-polish').checked, confirmEachAction: $('set-confirm-each').checked,
      hotkeys: Object.fromEntries(Object.keys(HOTKEY_LABELS).map((k) => [k, $(`hk-${k}`).value.trim()])),
    },
  };
  if ($('set-key').value) payload.anthropicKey = $('set-key').value;
  if ($('set-or-key').value) payload.openrouterKey = $('set-or-key').value;
  if ($('set-omni-key').value) payload.omnirouteKey = $('set-omni-key').value;
  if ($('set-stt-key').value) payload.sttKey = $('set-stt-key').value;
  const res = await call('settings:save', payload);
  S = res;
  renderAll();
  $('settings-note').textContent = res.failedHotkeys?.length ? `Saved, but these hotkeys could not be registered: ${res.failedHotkeys.join(', ')}` : 'Saved.';
});

// ---- wiring -----------------------------------------------------------------------------
function renderAll() {
  renderSettings(); renderSkills(); renderMemory(); renderRoutines(); renderMcp(); renderAttachments(S.attachments); renderWalk(S.walk); setMode(mode); renderEmpty();
}

window.memo.on((e) => {
  if (e.type === 'message') addMessage(e);
  else if (e.type === 'say') speak(e.text);
  else if (e.type === 'shutup') shutUp();
  else if (e.type === 'status') renderStatus(e);
  else if (e.type === 'walk') renderWalk(e.walk);
  else if (e.type === 'confirm') renderConfirm(e.confirm);
  else if (e.type === 'state') { S = e.state; renderSkills(); renderMemory(); renderRoutines(); renderMcp(); }
  else if (e.type === 'listen') { if (e.mode) { shutUp(); startRec(e.mode); } else stopRec(true); }
});

call('state:get').then((state) => { S = state; renderAll(); });
