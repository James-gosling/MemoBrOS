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
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  for (const b of $('tabs').children) b.classList.toggle('on', b === e.target);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === `tab-${tab}`);
});

// ---- chat -----------------------------------------------------------------------
function addMessage({ role, text, tag }) {
  $('messages').querySelector('.empty')?.remove();
  const m = h('div', { className: `msg ${role}` });
  if (tag) m.append(h('span', { className: 'tag', textContent: tag }));
  m.append(text);
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
  if (!S.hasKey) e.append(h('br'), h('p', { style: 'color:var(--memo)' }, 'First, add your Anthropic API key in Settings.'));
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
  $('confirm-hint').replaceChildren('Or press ', h('kbd', { textContent: pretty(c.hotkey) }), ' / say "yes".');
}
$('confirm-yes').addEventListener('click', () => call('confirm:answer', { ok: true }));
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

// ---- settings ---------------------------------------------------------------------------
function fillVoices() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  $('set-voice').replaceChildren(h('option', { value: '', textContent: 'System default' }), ...voices.map((v) => h('option', { value: v.name, textContent: `${v.name} (${v.lang})` })));
  $('set-voice').value = S?.settings.voice || '';
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoices;

function renderSettings() {
  const s = S.settings;
  $('set-key').value = ''; $('set-key').placeholder = S.hasKey ? 'Saved. Paste a new key to replace it' : 'sk-ant-…';
  $('set-model').value = s.model; $('set-dict-model').value = s.dictationModel;
  $('set-stt').value = s.sttProvider; $('set-stt-url').value = s.sttBaseUrl; $('set-stt-model').value = s.sttCloudModel;
  $('set-stt-key').value = ''; $('set-stt-key').placeholder = S.hasSttKey ? 'Saved' : 'API key for the endpoint';
  $('stt-cloud').hidden = s.sttProvider !== 'cloud';
  $('set-lang').replaceChildren(...Object.entries(LANGS).map(([value, textContent]) => h('option', { value, textContent })));
  $('set-lang').value = s.language;
  $('set-speak').checked = s.speak; $('set-polish').checked = s.dictationPolish; $('set-confirm-each').checked = s.confirmEachAction;
  fillVoices();
  $('hotkeys').replaceChildren(...Object.entries(HOTKEY_LABELS).map(([k, label]) => h('div', { className: 'hk' }, label, h('input', { value: s.hotkeys[k], id: `hk-${k}` }))));
}
$('set-stt').addEventListener('change', () => { $('stt-cloud').hidden = $('set-stt').value !== 'cloud'; });
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    settings: {
      model: $('set-model').value, dictationModel: $('set-dict-model').value, sttProvider: $('set-stt').value,
      sttBaseUrl: $('set-stt-url').value.trim(), sttCloudModel: $('set-stt-model').value.trim(), language: $('set-lang').value,
      speak: $('set-speak').checked, voice: $('set-voice').value, dictationPolish: $('set-polish').checked, confirmEachAction: $('set-confirm-each').checked,
      hotkeys: Object.fromEntries(Object.keys(HOTKEY_LABELS).map((k) => [k, $(`hk-${k}`).value.trim()])),
    },
  };
  if ($('set-key').value) payload.anthropicKey = $('set-key').value;
  if ($('set-stt-key').value) payload.sttKey = $('set-stt-key').value;
  const res = await call('settings:save', payload);
  S = res;
  renderAll();
  $('settings-note').textContent = res.failedHotkeys?.length ? `Saved, but these hotkeys could not be registered: ${res.failedHotkeys.join(', ')}` : 'Saved.';
});

// ---- wiring -----------------------------------------------------------------------------
function renderAll() {
  renderSettings(); renderSkills(); renderMemory(); renderAttachments(S.attachments); renderWalk(S.walk); setMode(mode); renderEmpty();
}

window.memo.on((e) => {
  if (e.type === 'message') addMessage(e);
  else if (e.type === 'say') speak(e.text);
  else if (e.type === 'shutup') shutUp();
  else if (e.type === 'status') renderStatus(e);
  else if (e.type === 'walk') renderWalk(e.walk);
  else if (e.type === 'confirm') renderConfirm(e.confirm);
  else if (e.type === 'state') { S = e.state; renderSkills(); renderMemory(); }
  else if (e.type === 'listen') { if (e.mode) { shutUp(); startRec(e.mode); } else stopRec(true); }
});

call('state:get').then((state) => { S = state; renderAll(); });
