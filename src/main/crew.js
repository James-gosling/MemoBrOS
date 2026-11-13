// Crew mode: one orchestrator and two to four subagents working on a goal.
//  - the orchestrator (the configured model) splits the goal, then merges the results into one report
//  - "coder" subagents are sessions of the coding agent (Kiro CLI, `kiro-cli acp`) driven over ACP
//  - "researcher" subagents are MemoBrOS background workers (private browser, connected accounts, MCP tools)
// Phase-1 agents run in parallel; phase-2 agents (review, tests, summary) run afterwards and see phase-1 results.
//
// Coders never share a working directory while they write. In a Git project each coder gets its own worktree and
// branch; the branches are validated, test-merged to find conflicts, and reach the user's branch only after the
// user approves. Where worktrees are not available, coders run one at a time in the project folder instead.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const brain = require('./brain');
const mcp = require('./mcp');
const routines = require('./routines');
const wt = require('./worktrees');
const { AcpAgent } = require('./acp');

const MIN = 2, MAX = 4;
const stopped = () => Object.assign(new Error('Stopped.'), { aborted: true });
let browserQueue = Promise.resolve(); // researchers share one background browser, so they take turns
let coderQueue = Promise.resolve();   // without worktrees, coders take turns in the project folder

function codeAgent() {
  const c = store.getSettings().codeAgent || {};
  return {
    enabled: c.enabled !== false && !!String(c.command || '').trim(), command: String(c.command || '').trim(), cwd: String(c.cwd || '').trim(),
    validate: String(c.validate || '').trim(), protected: Array.isArray(c.protected) ? c.protected : [],
  };
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
  const agents = (Array.isArray(plan.agents) ? plan.agents : []).filter((a) => a && a.task).slice(0, MAX).map((a, i) => ({
    name: String(a.name || `Agent ${i + 1}`).slice(0, 30), kind: kinds.includes(a.kind) ? a.kind : kinds[0], task: String(a.task), phase: Number(a.phase) === 2 ? 2 : 1,
  }));
  if (!agents.length) throw new Error('The orchestrator could not split that goal into tasks. Try describing it in more detail.');
  if (agents.length < MIN) agents.push({ name: 'Reviewer', kind: agents[0].kind, phase: 2, task: 'Independently check the work the other agent reports against the goal. Verify it actually works (run or read what is needed), and report any problems or gaps plainly.' });
  if (agents.every((a) => a.phase === 2)) agents[0].phase = 1;
  return agents.map((a, i) => ({ ...a, id: i, status: 'waiting', note: '', result: '', branch: '', integration: '' }));
}

// One ACP session of the coding agent in `cwd`. The directory is locked for the duration: a second writer is refused.
async function runCoder(agent, ctx, cwd) {
  const release = wt.acquire(cwd, agent.name);
  const acp = new AcpAgent({
    command: codeAgent().command, cwd,
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
  } finally { acp.close(); release(); }
}

function runResearcher(agent, ctx) {
  const turn = browserQueue.then(() => routines.worker(agent.name, ctx.brief(agent), ctx.signal));
  browserQueue = turn.catch(() => {});
  return turn;
}

// ---- worktree isolation -------------------------------------------------------------------------
// Sets up a run: the repository facts, a scratch integration worktree, and a snapshot of the user's working tree.
async function isolate(project) {
  const repo = await wt.inspect(project);
  if (!repo.ok) return { ok: false, reason: repo.reason };
  const run = `crew-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 5)}`;
  const home = path.join(app.getPath('userData'), 'worktrees');
  try {
    const integration = await wt.create(repo.root, home, run, 'integration', repo.head);
    return { ok: true, repo, run, home, integration, merged: [], before: await wt.statusOf(repo.root) };
  } catch (e) { return { ok: false, reason: `a worktree could not be created (${e.message})` }; }
}

// Runs one coder in its own worktree, then commits, checks and classifies what it produced.
async function runIsolatedCoder(agent, ctx, iso, base) {
  const tree = await wt.create(iso.repo.root, iso.home, iso.run, `${agent.id + 1}-${agent.name}`, base);
  agent.tree = tree; agent.branch = tree.branch;
  let failure = null;
  try { agent.result = await runCoder(agent, ctx, tree.dir); } catch (e) { failure = e; }
  // Whatever happened, the agent's files are committed to its own branch so nothing is lost and nothing leaks out.
  try { agent.files = await wt.commitAll(tree, `crew(${agent.name}): ${failure ? 'work in progress, agent did not finish' : agent.task.split('\n')[0].slice(0, 60)}`); }
  catch (e) { agent.files = []; agent.integration = `not committed (${e.message}); its worktree is kept at ${tree.dir}`; }
  if (failure) { agent.integration = agent.integration || `not integrated: the agent failed. Its partial work is on branch ${tree.branch}`; throw failure; }
  const hits = wt.protectedHits(agent.files, codeAgent().protected);
  if (hits.length) { agent.integration = `held back: it changed protected files (${hits.join(', ')}). Review branch ${tree.branch} yourself`; return; }
  const check = await wt.validate(tree, codeAgent().validate, mcp.splitCommand);
  agent.integration = check.ok ? 'ready' : `held back: ${check.detail}. Branch ${tree.branch}`;
}

// Test-merges every ready branch of a phase into the integration worktree, in agent order.
async function integrate(agents, iso) {
  for (const a of agents) {
    if (a.integration !== 'ready') continue;
    if (!a.files.length) { a.integration = 'no file changes'; continue; }
    const merge = await wt.tryMerge(iso.integration, a.branch);
    if (merge.ok) { a.integration = 'merged into the integration branch'; iso.merged.push(a); }
    else a.integration = `conflict with earlier work in ${merge.conflicts.join(', ') || 'the same files'}; held back on branch ${a.branch}`;
  }
}

// After all agents: check the integrated result, ask the user, fast-forward their branch. Returns notes for the report.
async function finish(agents, iso, io) {
  const notes = [];
  const coders = agents.filter((a) => a.kind === 'coder');
  for (const a of coders) notes.push(`${a.name}: ${a.integration || 'nothing to integrate'}`);
  if ((await wt.statusOf(iso.repo.root)) !== iso.before) notes.push(`Warning: files in ${iso.repo.root} changed while the crew worked, outside the agents' worktrees. Nothing was reverted; check them.`);
  if (iso.merged.length) {
    const check = await wt.validate({ dir: iso.integration.dir, base: iso.repo.head }, codeAgent().validate, mcp.splitCommand);
    const files = await wt.changedFiles(iso.integration.dir, iso.repo.head);
    if (!check.ok) notes.push(`The combined work failed its check (${check.detail}), so it was not offered for merging. It is on branch ${iso.integration.branch}.`);
    else {
      const held = coders.filter((a) => !iso.merged.includes(a));
      const ok = await io.confirm(`Merge the crew's work into ${iso.repo.branch}?`, [
        `${iso.merged.map((a) => a.name).join(', ')} changed ${files.length} file${files.length === 1 ? '' : 's'}:`, ...files.slice(0, 12).map((f) => `  ${f}`), files.length > 12 ? `  … and ${files.length - 12} more` : '',
        held.length ? `\nNot included: ${held.map((a) => `${a.name} (${a.integration.split(/[:;.]/)[0]})`).join(', ')}` : '',
        `\nCheck: ${check.detail}`,
      ].filter(Boolean).join('\n'));
      if (!ok) notes.push(`You did not approve the merge. The combined work is on branch ${iso.integration.branch}; ${iso.repo.branch} is unchanged.`);
      else {
        const ff = await wt.fastForward(iso.repo.root, iso.repo, iso.integration.branch);
        notes.push(ff.ok ? `Merged into ${iso.repo.branch} (${files.length} files).` : `Not merged: ${ff.reason}. The combined work is on branch ${iso.integration.branch}; merge it when ready.`);
      }
    }
  } else if (coders.length) notes.push(`Nothing was merged into ${iso.repo.branch}.`);
  // Tidy up directories Git confirms are clean. Branches stay; anything with uncommitted files stays where it is.
  for (const tree of [...coders.map((a) => a.tree).filter(Boolean), iso.integration]) await wt.removeIfClean(iso.repo.root, tree).catch(() => false);
  return notes;
}

// io: { update(agents), confirm(title, text, opts) }
async function run({ goal, signal, io }) {
  const coder = codeAgent();
  const kinds = coder.enabled ? ['coder', 'researcher'] : ['researcher'];
  const agents = normalize(await brain.planCrew({ goal, kinds, project: coder.cwd, signal }), kinds);
  io.update(agents);

  let iso = { ok: false, reason: '' };
  if (agents.some((a) => a.kind === 'coder')) {
    if (!coder.cwd || !fs.existsSync(coder.cwd)) iso.reason = 'no project folder is set';
    else iso = await isolate(coder.cwd);
  }
  const memory = store.getMemory();
  const ctx = {
    signal, confirm: io.confirm,
    note: (agent, line) => { agent.note = String(line).slice(0, 140); io.update(agents); },
    brief: (agent) => [
      `You are "${agent.name}", one of ${agents.length} agents working on this goal for the user:\n${goal}`,
      `Your part:\n${agent.task}`,
      `The other agents handle: ${agents.filter((a) => a !== agent).map((a) => `${a.name} (${a.task.slice(0, 120)})`).join('; ')}. Stay within your part so you do not collide with them.`,
      agent.tree ? `Your working directory ${agent.tree.dir} is your own Git worktree on branch ${agent.tree.branch}. Make every change inside it. Do not switch branches, edit files outside it, merge, or push: MemoBrOS commits your work and integrates it after the user approves.` : '',
      agent.phase === 2 ? `Results from the agents that ran before you${agent.tree ? ' (their merged changes are already in your worktree)' : ''}:\n${agents.filter((a) => a.phase === 1).map((a) => `## ${a.name} [${a.status}]\n${a.result}`).join('\n\n')}` : '',
      memory.length ? `What is known about the user:\n${memory.map((m) => `- ${m.note}`).join('\n')}` : '',
      'When you finish, report in a few sentences what you did, what you verified, and anything left undone or uncertain.',
    ].filter(Boolean).join('\n\n'),
  };

  const work = (agent, base) => {
    if (agent.kind !== 'coder') return runResearcher(agent, ctx).then((r) => { agent.result = r; });
    if (iso.ok) return runIsolatedCoder(agent, ctx, iso, base);
    if (!coder.cwd || !fs.existsSync(coder.cwd)) return Promise.reject(new Error('No project folder is set for the coding agent. Choose one in Settings → Coding agent.'));
    // No worktrees here: one coder at a time, straight in the project folder.
    const turn = coderQueue.then(() => { if (signal.aborted) throw stopped(); agent.status = 'working'; io.update(agents); return runCoder(agent, ctx, coder.cwd); }).then((r) => { agent.result = r; });
    coderQueue = turn.catch(() => {});
    return turn;
  };
  const runOne = async (agent, base) => {
    const queued = agent.kind === 'coder' && !iso.ok;
    agent.status = queued ? 'waiting' : 'working'; if (queued) agent.note = 'Waiting for its turn (no worktree isolation)'; io.update(agents);
    try { await work(agent, base); agent.status = 'done'; }
    catch (e) {
      if (e.aborted || signal.aborted) { agent.status = 'stopped'; throw stopped(); }
      agent.status = 'failed'; agent.result = e.message || String(e);
    }
    agent.note = agent.branch ? `Branch ${agent.branch}` : ''; io.update(agents);
  };

  let aborted = false;
  for (const phase of [1, 2]) {
    const group = agents.filter((a) => a.phase === phase);
    // Phase 2 starts from the integrated phase-1 work, so reviewers and testers see what was built.
    const base = iso.ok ? (await wt.git(iso.integration.dir, ['rev-parse', 'HEAD'])).stdout : null;
    const settled = await Promise.allSettled(group.map((a) => runOne(a, base)));
    if (iso.ok) await integrate(group.filter((a) => a.kind === 'coder'), iso);
    if (signal.aborted || settled.some((s) => s.status === 'rejected')) { aborted = true; break; }
  }
  const notes = iso.ok ? await finish(agents, iso, aborted ? { confirm: async () => false } : io)
    : agents.some((a) => a.kind === 'coder') ? [`Coders worked one at a time directly in the project folder, because ${iso.reason}.`] : [];
  if (aborted) throw stopped();
  io.update(agents);
  return brain.crewReport({ goal, agents, notes, signal });
}

module.exports = { run, normalize, codeAgent };
