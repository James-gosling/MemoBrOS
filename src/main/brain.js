// Everything that talks to Claude: screen-aware answers, walkthrough steps, agent mode, dictation polish.
const fs = require('fs');
const path = require('path');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const store = require('./store');

const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/; // models that accept server-side refusal fallbacks
let fallbacksOk = true;
let history = []; // [{ role, content: string }] — text-only memory of the conversation

function client() {
  const apiKey = store.getSecret('anthropic');
  if (!apiKey) throw new Error('No Anthropic API key yet. Open the MemoBrOS panel → Settings and paste one (or set ANTHROPIC_API_KEY).');
  return new Anthropic({ apiKey });
}

async function call({ system, messages, tools, effort = 'low', model, signal }) {
  const m = model || store.getSettings().model;
  const params = { model: m, max_tokens: 16000, system, messages, output_config: { effort } };
  if (tools) params.tools = tools;
  const c = client();
  try {
    if (fallbacksOk && FALLBACK_MODELS.test(m)) {
      try {
        return await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal });
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError) || !/fallback/i.test(e.message)) throw e;
        fallbacksOk = false; // this account/platform does not take the fallbacks parameter
      }
    }
    return await c.messages.create(params, { signal });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Anthropic API — give it a moment and try again.');
    if (e instanceof Anthropic.APIUserAbortError) throw Object.assign(new Error('Stopped.'), { aborted: true });
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error${e.status ? ` ${e.status}` : ''}: ${e.message}`);
    throw e;
  }
}

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
const toolUses = (res) => res.content.filter((b) => b.type === 'tool_use');
const refused = (res) => res.stop_reason === 'refusal';

// ---- prompts ----------------------------------------------------------------
function systemPrompt(shot, pinnedSkill, extra = '') {
  const memory = store.getMemory();
  const skills = store.listSkills();
  return [
    `You are Memo, the voice of MemoBrOS: a friendly buddy that lives next to the user's cursor on their ${{ darwin: 'Mac', win32: 'Windows PC', linux: 'Linux desktop' }[process.platform] || 'computer'}. You can see their screen, talk to them, point and draw on top of their apps, guide them through software step by step, and operate the computer for them in agent mode.`,
    `Your replies are spoken aloud and shown as a small caption, so talk like a helpful friend sitting beside them: one to three short sentences of plain speech, with no markdown, bullet points or raw URLs. Answer in the language the user is speaking.`,
    `Each request comes with a screenshot of the display the user is working on, ${shot.w}x${shot.h} pixels. Every coordinate you give is a pixel position in that screenshot, origin at the top left. A small MemoBrOS panel and your own cursor buddy may appear in the screenshot; they are not part of the user's work.`,
    `When the answer is about something visible on screen, show it rather than only describing it: call point to fly your cursor to the exact control (aim at its center), or draw to circle, box, underline or label things, and then say what to do there. If the thing they need is not on screen, say where to find it instead of pointing at a guess.`,
    `When the user wants to learn a multi-step procedure in an app ("walk me through", "how do I", "teach me"), call start_walkthrough with short imperative steps; the app then takes them through one step at a time and you point at each one. When the user asks you to do something on the computer for them, call start_agent with a clear task description; they will be asked to approve your plan first.`,
    `When the user tells you something worth keeping for later (a preference, a name, how they like things done), call remember.`,
    memory.length ? `Things you remember about this user:\n${memory.map((m) => `- ${m.note}`).join('\n')}` : '',
    skills.length ? `Skills are reusable instructions the user has saved. Before doing something a skill covers, call use_skill to read it and then follow it.\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}` : '',
    pinnedSkill ? `The user has pinned the skill "${pinnedSkill.name}" for this conversation. Follow it:\n${pinnedSkill.body}` : '',
    extra,
  ].filter(Boolean).join('\n\n');
}

const XY = { x: { type: 'integer', description: 'Screenshot x in pixels' }, y: { type: 'integer', description: 'Screenshot y in pixels' } };
const tool = (name, description, properties, required = Object.keys(properties)) => ({ name, description, input_schema: { type: 'object', properties, required } });

const POINT = tool('point', 'Fly the buddy cursor to a spot on the user\'s screen and show a short label next to it.', { ...XY, label: { type: 'string', description: 'Two to five words, e.g. "Export button"' } });
const DRAW = tool('draw', 'Draw annotations on top of the user\'s screen. Use several shapes to mark several things at once.', {
  shapes: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['circle', 'box', 'arrow', 'underline', 'text'], description: 'circle and box surround the area from (x,y) to (x2,y2); arrow goes from (x,y) to its tip at (x2,y2); underline runs from (x,y) to (x2,y2); text is placed at (x,y)' },
        ...XY, x2: { type: 'integer' }, y2: { type: 'integer' },
        label: { type: 'string', description: 'Optional short caption (required for text)' },
      },
      required: ['type', 'x', 'y'],
    },
  },
});
const USE_SKILL = tool('use_skill', 'Read the full instructions of one of the user\'s saved skills.', { name: { type: 'string' } });
const REMEMBER = tool('remember', 'Save a short note to long-term memory so you know it in future conversations.', { note: { type: 'string' } });
const START_WALKTHROUGH = tool('start_walkthrough', 'Begin a guided, step-by-step walkthrough in the app the user is looking at.', { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, description: 'Short imperative steps, in order' } });
const START_AGENT = tool('start_agent', 'Hand a task to agent mode, which operates the mouse and keyboard after the user approves the plan.', { task: { type: 'string' } });

// ---- attachments ------------------------------------------------------------
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function attachmentBlocks(attachments = []) {
  return attachments.map((a) => {
    const ext = path.extname(a.path).toLowerCase();
    const data = fs.readFileSync(a.path);
    if (ext === '.pdf') return { type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } };
    if (IMAGE_TYPES[ext]) return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: data.toString('base64') } };
    return { type: 'document', title: a.name, source: { type: 'text', media_type: 'text/plain', data: data.toString('utf8') } };
  });
}
const shotBlock = (shot) => ({ type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.base64 } });

// Runs one user turn with "fire and continue" tools. handlers: { toolName: async (input) => resultString }
async function turn({ system, content, tools, handlers, effort, signal, maxRounds = 5 }) {
  const messages = [...history, { role: 'user', content }];
  let spoken = '';
  for (let round = 0; round < maxRounds; round++) {
    const res = await call({ system, messages, tools, effort, signal });
    if (refused(res)) return spoken || "Sorry, that's something I can't help with.";
    spoken = [spoken, textOf(res)].filter(Boolean).join(' ');
    const uses = toolUses(res);
    if (res.stop_reason !== 'tool_use' || !uses.length) break;
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      let out, isError = false;
      try { out = await (handlers[u.name] ? handlers[u.name](u.input) : `Unknown tool ${u.name}`); } catch (e) { out = String(e.message || e); isError = true; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out || 'ok', is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return spoken;
}

function remember(userText, reply) {
  history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply || '(pointed on screen)' });
  history = history.slice(-12);
}
function resetHistory() { history = []; }

const baseHandlers = (hooks) => ({
  point: async (i) => { await hooks.point(i); return 'Pointing there now.'; },
  draw: async (i) => { await hooks.draw(i.shapes || []); return 'Drawn.'; },
  use_skill: async (i) => {
    const s = store.listSkills().find((k) => k.name.toLowerCase() === String(i.name).toLowerCase() || k.id === i.name);
    return s ? s.body : `No skill named "${i.name}".`;
  },
  remember: async (i) => { store.addMemory(i.note); hooks.memoryChanged?.(); return 'Saved.'; },
});

// ---- 1+2+5: screen-aware help with pointing, files and skills -----------------
async function ask({ text, shot, attachments, pinnedSkill, hooks, signal }) {
  const reply = await turn({
    system: systemPrompt(shot, pinnedSkill),
    content: [...attachmentBlocks(attachments), shotBlock(shot), { type: 'text', text }],
    tools: [POINT, DRAW, START_WALKTHROUGH, START_AGENT, USE_SKILL, REMEMBER],
    handlers: {
      ...baseHandlers(hooks),
      start_walkthrough: async (i) => { hooks.startWalkthrough(i); return 'Walkthrough queued. The app will start step 1 right after you finish speaking; just give a one-sentence intro now.'; },
      start_agent: async (i) => { hooks.startAgent(i.task); return 'Agent mode queued; the user will see your plan and approve it. Say one short sentence acknowledging.'; },
    },
    signal,
  });
  remember(text, reply);
  return reply;
}

// ---- 5: one walkthrough step --------------------------------------------------
async function walkStep({ walk, shot, attachments, pinnedSkill, hooks, signal }) {
  const { title, steps, i } = walk;
  const text = `Walkthrough "${title}", step ${i + 1} of ${steps.length}: ${steps[i]}\n\nFull list of steps:\n${steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}\n\nLook at the current screenshot, point at (or draw on) the exact control for this step, and tell me in one or two short sentences what to do. If the screen shows this step is already done or I'm in the wrong place, say so and tell me how to get back on track.`;
  const reply = await turn({
    system: systemPrompt(shot, pinnedSkill),
    content: [...attachmentBlocks(attachments), shotBlock(shot), { type: 'text', text }],
    tools: [POINT, DRAW, USE_SKILL],
    handlers: baseHandlers(hooks),
    signal,
  });
  remember(`(walkthrough step ${i + 1}: ${steps[i]})`, reply);
  return reply;
}

// ---- 3: agent mode ------------------------------------------------------------
const AGENT_TOOLS = [
  tool('click', 'Click at a screenshot position.', { ...XY, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' }, why: { type: 'string', description: 'A few words on what this click does' } }, ['x', 'y']),
  tool('type', 'Type text into the focused field.', { text: { type: 'string' } }),
  tool('key', 'Press a key or shortcut, e.g. "enter", "ctrl+s", "cmd+shift+p". Use "mod" for Cmd on Mac / Ctrl elsewhere.', { combo: { type: 'string' } }),
  tool('scroll', 'Scroll at a screenshot position. Positive dy scrolls down, negative up; 5 is about half a page.', { ...XY, dy: { type: 'integer' } }),
  tool('drag', 'Press at (x,y), drag to (x2,y2), release.', { ...XY, x2: { type: 'integer' }, y2: { type: 'integer' } }),
  tool('wait', 'Wait for the screen to settle (app launching, page loading).', { ms: { type: 'integer' } }),
  tool('ask_user', 'Pause and ask the user to confirm before an action that is hard to undo or reaches other people: sending, posting, deleting, purchasing, changing settings.', { question: { type: 'string' } }),
  tool('done', 'Finish the task and report the outcome honestly, including anything that did not work.', { summary: { type: 'string' } }),
];
const agentExtra = `You are now in agent mode: you operate the user's mouse and keyboard to carry out the task they approved. After each batch of actions you get a fresh screenshot; base every coordinate on the most recent one. Take one or two actions at a time and check the result before continuing. Any text you write before a tool call is shown as a caption, so keep it to a few words. Stay within the approved task. Before anything hard to undo or that reaches other people, call ask_user. When finished or stuck, call done.`;

async function plan({ task, shot, pinnedSkill, attachments, signal }) {
  const res = await call({
    system: systemPrompt(shot, pinnedSkill),
    messages: [{ role: 'user', content: [...attachmentBlocks(attachments), shotBlock(shot), { type: 'text', text: `I want you to do this on my computer in agent mode: ${task}\n\nBefore touching anything, give me your plan as two to five short numbered steps based on what you can see. Reply with only the plan.` }] }],
    effort: 'low', signal,
  });
  return refused(res) ? '' : textOf(res);
}

// io: { capture(), exec(name, input, shot) → string, confirm(question) → bool, narrate(text), step(n) }
async function runAgent({ task, planText, shot, pinnedSkill, io, signal }) {
  const max = store.getSettings().maxAgentSteps;
  const messages = [{ role: 'user', content: [shotBlock(shot), { type: 'text', text: `Task: ${task}\n\nPlan the user approved:\n${planText}\n\nGo ahead.` }] }];
  for (let step = 1; step <= max; step++) {
    if (signal.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
    const res = await call({ system: systemPrompt(shot, pinnedSkill, agentExtra), messages, tools: AGENT_TOOLS, effort: 'medium', signal });
    if (refused(res)) return "I can't continue with that task.";
    const said = textOf(res);
    const uses = toolUses(res);
    if (res.stop_reason !== 'tool_use' || !uses.length) return said || 'Done.';
    if (said) io.narrate(said);
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    let summary = null;
    for (const u of uses) {
      if (signal.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
      let out = 'ok', isError = false;
      try {
        if (u.name === 'done') summary = u.input.summary || 'Done.';
        else if (u.name === 'ask_user') out = (await io.confirm(u.input.question)) ? 'The user said yes, go ahead.' : 'The user said no. Do not do that; finish up or find another way.';
        else out = await io.exec(u.name, u.input, shot);
      } catch (e) { if (e.aborted) throw e; out = String(e.message || e); isError = true; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: out }], is_error: isError });
    }
    if (summary) return summary;
    shot = await io.capture();
    results[results.length - 1].content.push({ type: 'text', text: 'Screenshot after these actions:' }, shotBlock(shot));
    messages.push({ role: 'user', content: results });
    io.step(step);
  }
  return `I stopped after ${max} steps without finishing. Tell me how you'd like to continue.`;
}

// ---- 4: dictation polish ------------------------------------------------------
async function polish(raw, signal) {
  const res = await call({
    model: store.getSettings().dictationModel,
    system: 'You clean up dictated speech before it is typed into a text field. Fix grammar, punctuation, capitalization and obvious mis-hearings, and drop filler words and false starts. Keep the speaker\'s language, wording and meaning; never translate, answer, or add anything. Reply with only the corrected text.',
    messages: [{ role: 'user', content: raw }],
    effort: 'low', signal,
  });
  return refused(res) ? raw : textOf(res) || raw;
}

module.exports = { ask, walkStep, plan, runAgent, polish, resetHistory, hasKey: () => !!store.getSecret('anthropic') };
