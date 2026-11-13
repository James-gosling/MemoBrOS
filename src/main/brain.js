// Everything that talks to the model: screen-aware answers, walkthrough steps, agent mode, dictation polish.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const llm = require('./llm');

let history = []; // [{ role, content: string }] — text-only memory of the conversation
const call = (params) => llm.call(params);

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
const toolUses = (res) => res.content.filter((b) => b.type === 'tool_use');
const refused = (res) => res.stop_reason === 'refusal';

// ---- prompts ----------------------------------------------------------------
const nowLine = () => `Right now it is ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} in the user's time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;
function systemPrompt(shot, pinnedSkill, extra = '') {
  const memory = store.getMemory();
  const skills = store.listSkills();
  return [
    `You are Memo, the voice of MemoBrOS: a friendly buddy that lives next to the user's cursor on their ${{ darwin: 'Mac', win32: 'Windows PC', linux: 'Linux desktop' }[process.platform] || 'computer'}. You can see their screen, talk to them, point and draw on top of their apps, guide them through software step by step, and operate the computer for them in agent mode.`,
    `Your replies are spoken aloud and shown as a small caption, so talk like a helpful friend sitting beside them: one to three short sentences of plain speech, with no markdown, bullet points or raw URLs. Answer in the language the user is speaking.`,
    `Each request comes with a screenshot of the display the user is working on, ${shot.w}x${shot.h} pixels. Every coordinate you give is a pixel position in that screenshot, origin at the top left. A small MemoBrOS panel and your own cursor buddy may appear in the screenshot; they are not part of the user's work.`,
    `When the answer is about something visible on screen, show it rather than only describing it: call point to fly your cursor to the exact control (aim at its center), or draw to circle, box, underline or label things, and then say what to do there. If the thing they need is not on screen, say where to find it instead of pointing at a guess.`,
    `When the user wants to learn a multi-step procedure in an app ("walk me through", "how do I", "teach me"), call start_walkthrough with short imperative steps; the app then takes them through one step at a time and you point at each one. When the user asks you to do something on the computer for them, call start_agent with a clear task description; they will be asked to approve your plan first.`,
    `When the user asks for software development work in their project, or a goal with several independent parts, call start_crew.`,
    `When the user wants something done repeatedly or at a later time ("every Tuesday at 5 PM…", "each morning…", "tomorrow at 9…"), call create_routine. ${nowLine()}`,
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
const ROUTINE_PROPS = {
  name: { type: 'string', description: 'Short title, e.g. "Invoice check"' },
  task: { type: 'string', description: 'What to do on each run, written as an instruction to yourself, without the schedule' },
  cron: { type: 'string', description: 'For repeating schedules: 5-field cron in the user\'s local time (minute hour day-of-month month day-of-week), numbers only, Sunday is 0. "Every Tuesday at 5 PM" is "0 17 * * 2".' },
  run_once_at: { type: 'string', description: 'For one-off schedules instead of cron: local date-time like 2026-11-14T09:00' },
  schedule_text: { type: 'string', description: 'The schedule in plain words, in the user\'s language' },
  use_crew: { type: 'boolean', description: 'true when the task is software development work in the user\'s project (writing or changing code, running tests, reviewing a repository), which the coding crew handles' },
  needs_screen: { type: 'boolean', description: 'true only if the task has to operate desktop apps with the mouse and keyboard; false when background tools (web browser, connected MCP tools) are enough' },
};
const CREATE_ROUTINE = tool('create_routine', 'Schedule a task to run automatically, repeating or once, in the background.', ROUTINE_PROPS, ['name', 'task', 'schedule_text']);
const RUN_IN_BACKGROUND = tool('run_in_background', 'Do a task quietly in the background, without touching the user\'s screen: it uses a private browser signed in to the accounts the user connected (Google Workspace, Notion, GitHub, Figma, ChatGPT, Claude and other sites) and their connected tools. Good for looking things up or doing web tasks while they keep working. The result arrives later as a notification.', { task: { type: 'string', description: 'Complete, self-contained instructions' } });
const START_CREW = tool('start_crew', 'Hand a larger goal to the crew: an orchestrator that splits it between two to four subagents (coding agents working in the user\'s project folder, and background researchers) and merges their results. Use it for software development work and for goals with several independent parts.', { goal: { type: 'string', description: 'The complete goal, with every detail the user gave' } });
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
      try { out = await (handlers[u.name] ? handlers[u.name](u.input) : handlers.__other ? handlers.__other(u.name, u.input) : `Unknown tool ${u.name}`); } catch (e) { out = String(e.message || e); isError = true; }
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
    tools: [POINT, DRAW, START_WALKTHROUGH, START_AGENT, START_CREW, RUN_IN_BACKGROUND, CREATE_ROUTINE, USE_SKILL, REMEMBER, ...(hooks.extraTools || [])],
    handlers: {
      ...baseHandlers(hooks),
      create_routine: (i) => hooks.createRoutine(i),
      run_in_background: (i) => hooks.runBackground(i.task),
      start_crew: (i) => { hooks.startCrew(i.goal); return 'The crew is starting; progress shows in the panel. Say one short sentence acknowledging.'; },
      __other: (name, input) => hooks.callTool(name, input),
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
    const res = await call({ system: systemPrompt(shot, pinnedSkill, agentExtra), messages, tools: AGENT_TOOLS, effort: 'medium', signal, keepImages: 2 });
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

// ---- routines -------------------------------------------------------------------
// Turns "Every Tuesday at 5 PM, check my inbox for invoices" into a routine draft, without a screenshot.
async function draftRoutine(text, signal) {
  const res = await call({
    system: `You turn a spoken request into a scheduled routine. ${nowLine()} Reply with only a JSON object with these keys:\n${Object.entries(ROUTINE_PROPS).map(([k, v]) => `- ${k}: ${v.description}`).join('\n')}\nUse exactly one of cron or run_once_at. If the request has no schedule at all, set both to null.`,
    messages: [{ role: 'user', content: text }],
    effort: 'low', signal,
  });
  const m = /\{[\s\S]*\}/.exec(textOf(res));
  if (!m) throw new Error("I couldn't work out a schedule from that. Try something like \"every weekday at 9 AM, …\".");
  try { return JSON.parse(m[0]); } catch { throw new Error("I couldn't work out a schedule from that. Try something like \"every weekday at 9 AM, …\"."); }
}

// Runs a routine headlessly: no screenshot, no mouse. `tools` and `exec(name, input)` come from the routine runner,
// which enforces the guardrails (approval before uploads, form submissions and non-read-only connected tools).
async function runRoutine({ routine, tools, exec, signal }) {
  const memory = store.getMemory();
  const system = [
    `You are Memo, the assistant inside MemoBrOS, running the user's scheduled routine "${routine.name}" in the background while they do other things. You cannot see their screen or use their mouse; work only through the tools you are given (a background web browser that is signed in to the accounts the user connected, their connected MCP tools, and their shared folders).`,
    `Work quietly and finish the job. Reading and looking things up needs no permission. Before anything that is hard to undo or that reaches other people (sending, posting, paying, deleting, changing settings), call request_approval and wait; if the user says no, stop that part and say so in your report. The app itself also pauses for the user's approval on uploads, form submissions and tools that change things.`,
    `End with a report of one to three plain sentences for a notification: what you found or did, and anything that needs the user's attention. If you could not do the task, say why.`,
    nowLine(),
    memory.length ? `Things you remember about this user:\n${memory.map((m) => `- ${m.note}`).join('\n')}` : '',
    routine.plan ? `When this was first done by hand, this plan worked:\n${routine.plan}` : '',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: routine.task }];
  let report = '';
  for (let round = 0; round < 25; round++) {
    if (signal.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
    const res = await call({ system, messages, tools, effort: 'medium', signal });
    if (refused(res)) return report || "I can't do that task.";
    report = textOf(res) || report;
    const uses = toolUses(res);
    if (res.stop_reason !== 'tool_use' || !uses.length) return report || 'Finished.';
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      let out, isError = false;
      try { out = await exec(u.name, u.input); } catch (e) { if (e.aborted) throw e; out = String(e.message || e); isError = true; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out || 'ok').slice(0, 20000), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return `${report} (Stopped after 25 steps without finishing.)`.trim();
}

// ---- crew: the orchestrator's two jobs -----------------------------------------------------
function firstJson(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function planCrew({ goal, kinds, project, signal }) {
  const kindHelp = {
    coder: `"coder": a coding agent (Kiro CLI) working in the project folder${project ? ` ${project}` : ''}. It reads and writes code, runs commands and tests, and uses git.`,
    researcher: '"researcher": a background worker with a private web browser signed in to the user\'s connected accounts and their connected tools (Notion, GitHub, Google Workspace, databases…). It looks things up and does web tasks; it cannot edit local code.',
  };
  const res = await call({
    system: `You are the orchestrator of a small crew of AI agents inside MemoBrOS. Split the user's goal into parts for two to four subagents. ${nowLine()}\n\nAgent kinds available:\n${kinds.map((k) => `- ${kindHelp[k]}`).join('\n')}\n\nGive each agent a self-contained task: it sees only its own task, the goal and the other agents' task titles. Agents in phase 1 run at the same time, each coder in its own Git worktree and branch; give coders separate files or areas so their branches merge cleanly. Put work that depends on the others' results (review, testing the whole, a summary) in phase 2. Use as few agents as the goal needs, but at least two.\n\nReply with only JSON: {"agents":[{"name":"short role name","kind":"${kinds.join('|')}","phase":1,"task":"…"}]}`,
    messages: [{ role: 'user', content: goal }],
    effort: 'medium', signal,
  });
  const plan = firstJson(textOf(res));
  if (!plan) throw new Error('The orchestrator did not return a usable plan. Try again, or pick a stronger model in Settings.');
  return plan;
}

async function crewReport({ goal, agents, notes = [], signal }) {
  const res = await call({
    system: 'You are the orchestrator of a crew of AI agents inside MemoBrOS. The subagents have finished. Tell the user the outcome in two to four plain spoken sentences, in their language: what got done, what did not, whether the code changes were merged into their branch or are waiting on a branch, and what needs their attention. Be accurate about failures; do not smooth them over.',
    messages: [{ role: 'user', content: `Goal: ${goal}\n\n${agents.map((a) => `## ${a.name} (${a.kind}) — ${a.status}\n${a.result}`).join('\n\n')}${notes.length ? `\n\n## Integration\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}` }],
    effort: 'low', signal,
  });
  return textOf(res) || agents.map((a) => `${a.name}: ${a.status}`).join('. ');
}

// ---- 4: dictation polish ------------------------------------------------------
async function polish(raw, signal) {
  const res = await call({
    model: store.getSettings().provider === 'anthropic' ? store.getSettings().dictationModel : undefined,
    system: 'You clean up dictated speech before it is typed into a text field. Fix grammar, punctuation, capitalization and obvious mis-hearings, and drop filler words and false starts. Keep the speaker\'s language, wording and meaning; never translate, answer, or add anything. Reply with only the corrected text.',
    messages: [{ role: 'user', content: raw }],
    effort: 'low', signal,
  });
  return refused(res) ? raw : textOf(res) || raw;
}

module.exports = { ask, walkStep, plan, runAgent, polish, resetHistory, draftRoutine, runRoutine, planCrew, crewReport, hasKey: () => llm.ready() };
