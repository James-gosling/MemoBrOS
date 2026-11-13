// Crew mode: one orchestrator and two to four subagents working on a goal.
//  - the orchestrator (the configured model) splits the goal, then merges the results into one report
//  - "coder" subagents are sessions of the coding agent (Kiro CLI) driven over ACP in the project folder
//  - "researcher" subagents are MemoBrOS background workers (private browser, connected accounts, MCP tools)
// Phase-1 agents run in parallel; phase-2 agents (review, tests, summary) run afterwards and see phase-1 results.
const fs = require('fs');
const store = require('./store');
const brain = require('./brain');
const mcp = require('./mcp');
const routines = require('./routines');
const { AcpAgent } = require('./acp');

const MIN = 2, MAX = 4;
let browserQueue = Promise.resolve(); // researchers share one background browser, so they take turns

function codeAgent() {
  const c = store.getSettings().codeAgent || {};
  // crewCommand: an external orchestration platform (Kiro Crew) that speaks ACP. When set, MemoBrOS hands it the
  // whole goal instead of splitting the work itself, and stays the layer for memory, scheduling and approvals.
  return { enabled: c.enabled !== false && !!String(c.command || '').trim(), command: String(c.command || '').trim(), cwd: String(c.cwd || '').trim(), crewCommand: String(c.crewCommand || '').trim() };
}

// MCP servers MemoBrOS knows that can be handed to the coding agent as-is (local commands, and remote ones with a pasted token).
function sharedMcpServers() {
  return store.getSettings().mcpServers.filter((c) => c.enabled !== false).flatMap((c) => {
    if (c.type === 'stdio') {
      const [command, ...args] = mcp.splitCommand(c.command || '');
      return command ? [{ name: c.name, command, args, env: Object.entries(mcp.parseEnv(store.getSecret(`mcpenv:${c.id}`))).map(([name, value]) => ({ name, value })) }] : [];
    }
    const token = store.getSecret(`mcp:${c.id}`);
    return token ? [{ type: 'http', name: c.name, url: c.url, headers: [{ name: 'Authorization', value: /^\w+ /.test(token) ? token : `Bearer ${token}` }] }] : [];
  });
}

// Keeps the orchestrator's plan inside the 2–4 subagent rule.
function normalize(plan, kinds) {
  let agents = (Array.isArray(plan.agents) ? plan.agents : []).filter((a) => a && a.task).slice(0, MAX).map((a, i) => ({
    name: String(a.name || `Agent ${i + 1}`).slice(0, 30), kind: kinds.includes(a.kind) ? a.kind : kinds[0], task: String(a.task), phase: Number(a.phase) === 2 ? 2 : 1,
  }));
  if (!agents.length) throw new Error('The orchestrator could not split that goal into tasks. Try describing it in more detail.');
  if (agents.length < MIN) agents.push({ name: 'Reviewer', kind: agents[0].kind, phase: 2, task: 'Independently check the work the other agent reports against the goal. Verify it actually works (run or read what is needed), and report any problems or gaps plainly.' });
  if (agents.every((a) => a.phase === 2)) agents[0].phase = 1;
  return agents.map((a, i) => ({ ...a, id: i, status: 'waiting', note: '', result: '' }));
}

async function runCoder(agent, ctx, commandOverride) {
  const { cwd } = codeAgent();
  const command = commandOverride || codeAgent().command;
  if (!cwd || !fs.existsSync(cwd)) throw new Error('No project folder is set for the coding agent. Choose one in Settings → Coding agent.');
  const acp = new AcpAgent({
    command, cwd,
    onUpdate: (line) => ctx.note(agent, line),
    onPermission: async ({ title, detail, options }) => {
      const answer = await ctx.confirm(`${agent.name} wants to: ${title}`, detail || `In ${cwd}`, options.some((o) => o.kind === 'allow_always') ? { always: 'Always allow' } : {});
      const pick = (kind) => options.find((o) => o.kind === kind)?.optionId;
      if (answer === 'always') return pick('allow_always') || pick('allow_once');
      return answer ? pick('allow_once') || pick('allow_always') : pick('reject_once') || null;
    },
  });
  try {
    await acp.start(sharedMcpServers());
    const out = await acp.prompt(ctx.brief(agent), ctx.signal);
    return out.text || `Finished (${out.stopReason}) without a written report.`;
  } finally { acp.close(); }
}

function runResearcher(agent, ctx) {
  const turn = browserQueue.then(() => routines.worker(agent.name, ctx.brief(agent), ctx.signal));
  browserQueue = turn.catch(() => {});
  return turn;
}

// Delegated mode: the external crew platform does the orchestration; it shows up here as a single agent.
async function runDelegated({ goal, signal, io }) {
  const { crewCommand } = codeAgent();
  const agents = [{ id: 0, name: 'Kiro Crew', kind: 'coder', phase: 1, task: goal, status: 'working', note: '', result: '' }];
  io.update(agents);
  const memory = store.getMemory();
  const ctx = {
    signal, confirm: io.confirm,
    note: (agent, line) => { agent.note = String(line).slice(0, 140); io.update(agents); },
    brief: () => [goal, memory.length ? `What is known about the user:\n${memory.map((m) => `- ${m.note}`).join('\n')}` : '', 'When you finish, report what was done, what was verified, and anything left undone or uncertain.'].filter(Boolean).join('\n\n'),
  };
  try { agents[0].result = await runCoder(agents[0], ctx, crewCommand); agents[0].status = 'done'; }
  catch (e) {
    if (e.aborted || signal.aborted) throw Object.assign(new Error('Stopped.'), { aborted: true });
    agents[0].status = 'failed'; agents[0].result = e.message || String(e);
  }
  agents[0].note = ''; io.update(agents);
  return brain.crewReport({ goal, agents, signal });
}

// io: { update(agents), confirm(title, text, opts), say(text) }
async function run({ goal, signal, io }) {
  if (codeAgent().crewCommand) return runDelegated({ goal, signal, io });
  const coder = codeAgent();
  const kinds = coder.enabled ? ['coder', 'researcher'] : ['researcher'];
  const agents = normalize(await brain.planCrew({ goal, kinds, project: coder.cwd, signal }), kinds);
  io.update(agents);
  const memory = store.getMemory();
  const ctx = {
    signal, confirm: io.confirm,
    note: (agent, line) => { agent.note = String(line).slice(0, 140); io.update(agents); },
    brief: (agent) => [
      `You are "${agent.name}", one of ${agents.length} agents working on this goal for the user:\n${goal}`,
      `Your part:\n${agent.task}`,
      `The other agents handle: ${agents.filter((a) => a !== agent).map((a) => `${a.name} (${a.task.slice(0, 120)})`).join('; ')}. Stay within your part so you do not collide with them.`,
      agent.phase === 2 ? `Results from the agents that ran before you:\n${agents.filter((a) => a.phase === 1).map((a) => `## ${a.name} [${a.status}]\n${a.result}`).join('\n\n')}` : '',
      memory.length ? `What is known about the user:\n${memory.map((m) => `- ${m.note}`).join('\n')}` : '',
      'When you finish, report in a few sentences what you did, what you verified, and anything left undone or uncertain.',
    ].filter(Boolean).join('\n\n'),
  };
  const runOne = async (agent) => {
    agent.status = 'working'; io.update(agents);
    try {
      agent.result = await (agent.kind === 'coder' ? runCoder(agent, ctx) : runResearcher(agent, ctx));
      agent.status = 'done';
    } catch (e) {
      if (e.aborted || signal.aborted) { agent.status = 'stopped'; throw Object.assign(new Error('Stopped.'), { aborted: true }); }
      agent.status = 'failed'; agent.result = e.message || String(e);
    }
    agent.note = ''; io.update(agents);
  };
  for (const phase of [1, 2]) {
    const settled = await Promise.allSettled(agents.filter((a) => a.phase === phase).map(runOne));
    if (signal.aborted || settled.some((s) => s.status === 'rejected')) throw Object.assign(new Error('Stopped.'), { aborted: true });
  }
  return brain.crewReport({ goal, agents, signal });
}

module.exports = { run, normalize, codeAgent };
