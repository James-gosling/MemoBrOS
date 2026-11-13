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
  const prev = $('messages').lastElementChild;
  if (role === 'error' && prev && prev.classList.contains('error') && prev.dataset.text === text) return; // same error again: say it once
  $('messages').querySelector('.empty')?.remove();
  const m = h('div', { className: `msg ${role}` });
  if (tag) m.append(h('span', { className: 'tag', textContent: tag }));
  m.append(text);
  m.dataset.text = text;
  if (role === 'memo' || role === 'error') $('peek').textContent = text;
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
  $('text').placeholder = { ask: 'Ask about your screen…', agent: 'Tell Memo what to do…', crew: 'Give the crew a goal…', dictate: 'Press the mic, then speak into any app' }[m];
  $('text').disabled = $('send').disabled = m === 'dictate';
  if (m === 'crew') { $('hint').textContent = S.codeAgent.enabled && S.codeAgent.cwd ? `Orchestrator + 2–4 subagents · coders run "${S.codeAgent.command}" in ${S.codeAgent.cwd}` : 'Orchestrator + 2–4 subagents · set a project folder in Settings → Coding agent to include coders'; return; }
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
$('mic').addEventListener('click', () => call('listen:toggle', { mode: mode === 'crew' ? 'ask' : mode }));
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

function renderCrew(agents) {
  $('crew').hidden = !agents || !agents.length;
  if (!agents) return;
  $('crew-count').textContent = `${agents.filter((a) => a.status === 'done').length} / ${agents.length} done`;
  $('crew-agents').replaceChildren(...agents.map((a) => h('div', { className: 'agent', title: a.task }, h('div', { className: 'lamp' }),
    h('div', {}, h('b', { textContent: a.name }), h('span', { textContent: a.note || (a.status === 'done' && a.integration) || { waiting: a.phase === 2 ? 'Waiting for the others' : 'Waiting', working: 'Working…', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[a.status] })),
    h('i', { textContent: a.kind === 'coder' ? 'Kiro' : 'Research' }))).map((n, i) => { n.dataset.status = agents[i].status; return n; }));
}
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
// Spanish or English? Enough to pick a voice for an answer.
function languageOf(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const es = (t.match(/[ñáéíóú¿¡]| (el|la|los|las|que|de|es|en|una?|para|por|con|está|tu|sí|aquí|haz|abre|listo|hecho|no pude|ya) |[a-z]+(ando|iendo|ción|ciones) /g) || []).length;
  const en = (t.match(/ (the|is|are|you|your|to|of|and|it|this|that|here|click|open|with|for) /g) || []).length;
  return es > en ? 'es' : 'en';
}
function voiceFor(text) {
  const voices = speechSynthesis.getVoices();
  const chosen = voices.find((v) => v.name === S.settings.voice);
  const lang = languageOf(text);
  if (chosen && chosen.lang.toLowerCase().startsWith(lang)) return chosen;
  const wanted = (S.settings.voiceLanguages || []).filter((l) => l.toLowerCase().startsWith(lang));
  for (const tag of wanted) { const v = voices.find((x) => x.lang.replace('_', '-').toLowerCase() === tag.toLowerCase()); if (v) return v; }
  return voices.find((v) => v.lang.toLowerCase().startsWith(lang)) || chosen || null;
}
function speak(text) {
  if (!S.settings.speak || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voiceFor(text);
  if (u.voice) u.lang = u.voice.lang;
  u.rate = S.settings.speechRate || 1;
  speechSynthesis.speak(u);
}
const shutUp = () => window.speechSynthesis && speechSynthesis.cancel();

// ---- microphone capture with simple voice-activity detection ----------------------------
// Audio is captured as 16 kHz mono PCM. Ask/agent: one utterance, ended by a pause or the hotkey.
// Dictation: continuous; every pause flushes a segment that is transcribed and typed while you keep talking.
const RATE = 16000, FRAME = 4096, FRAME_MS = (FRAME / RATE) * 1000;
let rec = null;

// Opens the microphone: the one chosen in Settings if it still exists, else the system default, else anything.
async function openMic() {
  const tuned = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const tries = [];
  if (S.settings.micDeviceId) tries.push({ audio: { ...tuned, deviceId: { exact: S.settings.micDeviceId } } });
  tries.push({ audio: tuned }, { audio: true });
  let last;
  for (const constraints of tries) { try { return await navigator.mediaDevices.getUserMedia(constraints); } catch (e) { last = e; } }
  throw last;
}
const micList = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
// Turns a getUserMedia failure into something the user can act on.
async function micProblem(e) {
  const inputs = await micList().catch(() => []);
  if (!inputs.length) return 'MemoBrOS cannot find any microphone. In your system settings open Sound → Input, choose a microphone and check that its level moves when you speak. Then press "Test microphone" in MemoBrOS Settings → Voice.';
  if (e.name === 'NotAllowedError') return 'The system refused access to the microphone. Allow it for MemoBrOS in your system privacy settings.';
  if (e.name === 'NotReadableError') return 'The microphone is busy or could not be started. Close other apps that are using it and try again.';
  return `The microphone could not be opened (${e.name}: ${e.message}). MemoBrOS sees: ${inputs.map((d) => d.label || 'unnamed input').join(', ')}.`;
}
async function fillMics() {
  const inputs = await micList().catch(() => []);
  $('set-mic').replaceChildren(h('option', { value: '', textContent: 'System default' }), ...inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId, textContent: d.label || `Microphone ${i + 1}` })));
  $('set-mic').value = [...$('set-mic').options].some((o) => o.value === S.settings.micDeviceId) ? S.settings.micDeviceId : '';
  return inputs;
}
// Settings → Voice → Test microphone: opens it for three seconds and reports what was heard.
async function testMic() {
  const note = $('mic-test-note');
  note.textContent = 'Listening for 3 seconds… say something.';
  let stream;
  try { S.settings.micDeviceId = $('set-mic').value; stream = await openMic(); }
  catch (e) { note.textContent = await micProblem(e); await fillMics(); return; }
  const ctx = new AudioContext(); const an = ctx.createAnalyser(); ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize); let peak = 0;
  const t0 = performance.now();
  await new Promise((resolve) => { const tick = () => { an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); performance.now() - t0 < 3000 ? setTimeout(tick, 60) : resolve(); }; tick(); });
  const label = stream.getAudioTracks()[0]?.label || 'the microphone';
  stream.getTracks().forEach((t) => t.stop()); ctx.close();
  await fillMics(); // device names become available once access has been granted
  note.textContent = peak > 0.02 ? `Working: heard you on "${label}".` : `"${label}" opened, but it was silent. Check that it is not muted and that the right input is selected in your system sound settings.`;
}

async function startRec(recMode) {
  if (rec) await stopRec(false);
  let stream;
  try { stream = await openMic(); }
  catch (e) {
    const why = await micProblem(e);
    addMessage({ role: 'error', text: `${why} You can still type.` });
    if (recMode === 'wake') { wakeArmed = false; $('wake-note').textContent = `The wake word was switched off: ${why}`; call('wake:set', { enabled: false }).then((st) => { S = st; renderPermissions(); renderChrome(); }); }
    else call('listen:ended');
    return;
  }
  $('wake-note').textContent = '';
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
    if (r.mode === 'wake') {
      // Wake-word listening: hand over each spoken phrase; skip anything heard while Memo itself is talking.
      if (window.speechSynthesis && speechSynthesis.speaking) { r.chunks = []; r.speechMs = 0; r.silenceMs = 0; }
      else if (r.speechMs >= 300 && (r.silenceMs >= 600 || segMs >= 12000)) flush(r, false);
    } else if (r.mode === 'dictate') {
      if (r.speechMs >= 250 && (r.silenceMs >= 700 || segMs >= 25000)) flush(r, false);
    } else if ((r.speechMs >= 250 && r.silenceMs >= 1500) || segMs >= 25000) endRec(true); // long recordings of mostly noise make the recogniser invent text
    else if (!r.speechMs && r.totalMs >= 9000) endRec(true);
  };
  $('mic').classList.toggle('on', recMode !== 'wake');
  $('mic').classList.toggle('armed', recMode === 'wake');
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
  $('mic').classList.remove('armed');
  if (r.mode !== 'wake' && (!sent || r.mode === 'dictate')) call('listen:ended');
}

// The wake word keeps a quiet recording running whenever nothing else is using the microphone.
let wakeArmed = false;
function ensureWake() { if (wakeArmed && !rec) startRec('wake'); else if (!wakeArmed && rec && rec.mode === 'wake') stopRec(false); }
const endRec = (send) => stopRec(send).then(ensureWake);

// ---- window chrome ------------------------------------------------------------------------
function renderChrome() {
  document.body.classList.toggle('compact', !!S.compact);
  $('win-compact').textContent = S.compact ? '▢' : '▁';
  $('win-compact').title = S.compact ? 'Expand' : 'Compact bar';
  $('win-pause').textContent = S.paused ? '▶' : '❙❙';
  $('win-pause').title = S.paused ? 'Resume the assistant' : 'Pause the assistant (stops listening, tasks and routines)';
  $('win-pause').classList.toggle('on', !!S.paused);
  $('speaker').classList.toggle('off', !S.settings.speak);
  renderActivity(S.activity);
}
function renderActivity(a) {
  $('ind-mic').classList.toggle('on', !!a.mic); $('ind-screen').classList.toggle('on', !!a.screen); $('ind-control').classList.toggle('on', !!a.control);
  $('ind-mic').textContent = S.wakeOn && !rec?.mode?.match(/ask|agent|dictate/) ? `mic · ${S.settings.wake.word}` : 'mic';
  $('ind-paused').classList.toggle('on', !!S.paused);
}
$('win-compact').addEventListener('click', () => call('window:compact', { compact: !S.compact }));
$('win-hide').addEventListener('click', () => call('window:hide'));
$('win-quit').addEventListener('click', () => call('app:quit'));
$('win-pause').addEventListener('click', async () => { S = await call('assistant:pause', { paused: !S.paused }); renderChrome(); });
$('speaker').addEventListener('click', async () => { S = await call('settings:save', { settings: { speak: !S.settings.speak } }); if (!S.settings.speak) shutUp(); renderChrome(); $('set-speak').checked = S.settings.speak; });
// Anything that needs the full interface (approvals, walkthroughs, crew progress) opens it.
const needFull = () => { if (S.compact) call('window:compact', { compact: false }); };

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
      h('span', { className: 'meta', textContent: `${r.scheduleText} · ${r.crew ? 'coding crew' : r.desktop ? 'on screen' : 'background'}` }),
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
  $('routine-name').value = r.name; $('routine-task').value = r.task; $('routine-when').value = r.scheduleText; $('routine-mode').value = r.crew ? 'crew' : r.desktop ? 'desktop' : 'background';
  $('routine-form').scrollIntoView({ behavior: 'smooth' });
}
$('routine-cancel').addEventListener('click', () => editRoutine(null));
$('routine-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('routine-note').textContent = 'Saving…';
  try {
    S = await call('routine:save', { id: editingRoutine.id, name: $('routine-name').value, task: $('routine-task').value, scheduleText: $('routine-when').value, mode: $('routine-mode').value });
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

// Ready-made MCP connectors: service, how it connects, and what the user still needs. "Set up" fills the form below.
const MCP_PRESETS = [
  { name: 'Notion', type: 'http', url: 'https://mcp.notion.com/mcp', how: 'Remote server, sign-in opens in your browser', need: 'Approve MemoBrOS on Notion\'s page' },
  { name: 'GitHub', type: 'http', url: 'https://api.githubcopilot.com/mcp/', needsToken: true, how: 'Remote server', need: 'A personal access token (github.com/settings/tokens)' },
  { name: 'Google Workspace', type: 'stdio', command: 'uvx workspace-mcp --tool-tier core', env: 'GOOGLE_OAUTH_CLIENT_ID=\nGOOGLE_OAUTH_CLIENT_SECRET=', how: 'Local workspace-mcp server (Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms, Tasks, Chat)', need: 'uv installed and your own Google Cloud OAuth client ID and secret' },
  { name: 'Figma', type: 'http', url: 'https://mcp.figma.com/mcp', how: 'Remote server, sign-in opens in your browser', need: 'Figma may refuse apps it hasn\'t approved; "Figma desktop" is the fallback' },
  { name: 'Figma desktop', type: 'http', url: 'http://127.0.0.1:3845/mcp', how: 'The desktop app\'s local server', need: 'Figma desktop open with its MCP server enabled (Dev Mode)' },
  { name: 'Vercel', type: 'http', url: 'https://mcp.vercel.com', how: 'Remote server, sign-in opens in your browser', need: 'A Vercel account; Vercel may refuse apps it hasn\'t approved' },
  { name: 'Airtable', type: 'http', url: 'https://mcp.airtable.com/mcp', how: 'Remote server, sign-in opens in your browser', need: 'Approve MemoBrOS in Airtable, or paste a personal access token' },
  { name: 'Supabase', type: 'http', url: 'https://mcp.supabase.com/mcp', how: 'Remote server, sign-in opens in your browser', need: 'A Supabase account; add ?read_only=true to the URL to keep it from changing data' },
  { name: 'Companio', type: 'http', url: 'https://companio-api.byafluence.com/mcp', how: 'Remote server, sign-in opens in your browser', need: 'Your Companio account' },
  { name: 'Claude', type: 'stdio', command: 'claude mcp serve', how: 'claude mcp serve', need: 'The claude CLI installed and signed in' },
  { name: 'ChatGPT', type: 'stdio', command: 'codex mcp-server', how: 'codex mcp-server (OpenAI\'s Codex agent)', need: 'The codex CLI installed and signed in' },
];
$('mcp-presets').replaceChildren(...MCP_PRESETS.map((p) => h('div', { className: 'item' },
  h('div', { className: 'grow' }, h('b', { textContent: p.name }), h('span', { className: 'meta', textContent: p.how }), h('span', { className: 'meta', textContent: `Needs: ${p.need}` })),
  h('button', { type: 'button', textContent: 'Set up', onclick: () => {
    $('mcp-name').value = p.name; $('mcp-type').value = p.type; $('mcp-command').value = p.command || ''; $('mcp-url').value = p.url || ''; $('mcp-env').value = p.env || ''; $('mcp-token').value = '';
    showMcpKind(); $('mcp-note').textContent = `Needs: ${p.need}`;
    $('mcp-form').scrollIntoView({ behavior: 'smooth' }); (p.needsToken ? $('mcp-token') : p.env ? $('mcp-env') : $('mcp-name')).focus();
  } }))));

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

function renderPermissions() {
  for (const k of ['screen', 'microphone', 'control']) $(`perm-${k}`).checked = !!S.settings.permissions[k];
  $('perm-control').disabled = !S.caps.control;
  $('perm-note').hidden = S.caps.control && S.caps.overlay;
  $('perm-note-text').textContent = S.caps.control ? '' : 'Mouse and keyboard control and the on-screen pointer are not available in native Wayland mode. X11 mode brings both back, for X11 apps.';
  $('set-wake').checked = !!S.settings.wake.enabled;
}
$('display-switch').addEventListener('click', () => call('display:set', { backend: 'x11' }));
$('mic-test').addEventListener('click', testMic);
for (const k of ['screen', 'microphone', 'control']) $(`perm-${k}`).addEventListener('change', async (e) => { S = await call('permission:set', { name: k, value: e.target.checked }); renderPermissions(); renderChrome(); });
$('set-wake').addEventListener('change', async (e) => { S = await call('wake:set', { enabled: e.target.checked }); renderPermissions(); renderChrome(); });

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
  $('set-stt-local').value = s.sttLocalModel; $('set-wake-debug').checked = !!s.wake.debug;
  $('set-stt').value = s.sttProvider; $('set-stt-url').value = s.sttBaseUrl; $('set-stt-model').value = s.sttCloudModel;
  $('set-stt-key').value = ''; $('set-stt-key').placeholder = S.hasSttKey ? 'Saved' : 'API key for the endpoint';
  $('stt-cloud').hidden = s.sttProvider !== 'cloud';
  $('set-lang').replaceChildren(...Object.entries(LANGS).map(([value, textContent]) => h('option', { value, textContent })));
  $('set-lang').value = s.language;
  renderPermissions();
  $('set-wake-word').value = s.wake.word; $('set-wake-aliases').value = s.wake.aliases || '';
  $('set-voice-langs').value = (s.voiceLanguages || []).join(', ');
  fillMics();
  $('display-row').hidden = S.platform !== 'linux'; $('set-display').value = s.displayBackend || 'auto';
  $('display-note').textContent = S.platform !== 'linux' ? '' : `Running now: ${S.display === 'wayland' ? 'native Wayland' : S.session === 'wayland' ? 'X11 through XWayland' : 'X11'}. ${S.caps.overlay ? '' : 'On native Wayland the on-screen cursor overlay and mouse/keyboard control are not available; dictation copies to the clipboard instead.'}${S.caps.x11Only ? 'Pointing, screen capture and control reach X11 apps only.' : ''}`;
  const hk = S.hotkeys;
  $('hotkey-report').replaceChildren(
    hk.failed.length ? `Not registered: ${hk.failed.join(', ')}. ` : 'All shortcuts registered. ',
    hk.via === 'portal' ? 'On Wayland they go through the desktop\'s shortcuts portal, which asks you to approve them. ' : hk.via === 'x11' && S.session === 'wayland' ? 'Under XWayland they only fire while an X11 window has focus. ' : '',
    'To bind show/hide yourself: GNOME Settings → Keyboard → Custom Shortcuts, command: ', h('kbd', { textContent: hk.fallback }));
  $('set-code-cmd').value = s.codeAgent.command; $('set-code-cwd').value = s.codeAgent.cwd; $('set-code-validate').value = s.codeAgent.validate || ''; $('set-code-protected').value = (s.codeAgent.protected || []).join(', ');
  $('set-gateway-cmd').value = s.crewGateway.command; renderGateway();
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
function renderGateway() {
  const g = S.gateway;
  $('gateway-toggle').textContent = g.state === 'running' ? 'Stop gateway' : 'Start gateway';
  $('gateway-status').textContent = { running: `Running (${g.detail})`, stopped: 'Not running', error: g.detail }[g.state] || g.state;
}
$('gateway-toggle').addEventListener('click', async () => { S = await call(S.gateway.state === 'running' ? 'gateway:stop' : 'gateway:start'); renderGateway(); });
$('code-browse').addEventListener('click', async () => { S = await call('project:pick'); $('set-code-cwd').value = S.settings.codeAgent.cwd; });
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
      codeAgent: { command: $('set-code-cmd').value.trim(), cwd: $('set-code-cwd').value.trim(), validate: $('set-code-validate').value.trim(), protected: $('set-code-protected').value.split(',').map((x) => x.trim()).filter(Boolean) },
      crewGateway: { command: $('set-gateway-cmd').value.trim() },
      launchAtLogin: $('set-autostart').checked, displayBackend: $('set-display').value,
      wake: { word: $('set-wake-word').value.trim() || 'ARVI', aliases: $('set-wake-aliases').value.trim(), debug: $('set-wake-debug').checked },
      sttLocalModel: $('set-stt-local').value,
      voiceLanguages: $('set-voice-langs').value.split(',').map((x) => x.trim()).filter(Boolean), micDeviceId: $('set-mic').value,
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
  renderChrome(); renderSettings(); renderSkills(); renderMemory(); renderRoutines(); renderMcp(); renderAttachments(S.attachments); renderWalk(S.walk); setMode(mode); renderEmpty();
}

window.memo.on((e) => {
  if (e.type === 'message') addMessage(e);
  else if (e.type === 'say') speak(e.text);
  else if (e.type === 'shutup') shutUp();
  else if (e.type === 'status') renderStatus(e);
  else if (e.type === 'walk') { if (e.walk) needFull(); renderWalk(e.walk); }
  else if (e.type === 'confirm') { if (e.confirm) needFull(); renderConfirm(e.confirm); }
  else if (e.type === 'crew') renderCrew(e.agents);
  else if (e.type === 'state') { S = e.state; renderChrome(); renderPermissions(); renderSkills(); renderMemory(); renderRoutines(); renderMcp(); renderGateway(); }
  else if (e.type === 'listen') { if (e.mode) { shutUp(); startRec(e.mode); } else endRec(true); }
  else if (e.type === 'wake') { wakeArmed = e.on; S.wakeOn = e.on; S.settings.wake.word = e.word; ensureWake(); renderChrome(); }
  else if (e.type === 'activity') { S.activity = e.activity; renderActivity(e.activity); }
  else if (e.type === 'window') { S.compact = e.compact; renderChrome(); if (!e.compact) $('messages').scrollTop = $('messages').scrollHeight; }
});

call('state:get').then((state) => { S = state; renderAll(); });
