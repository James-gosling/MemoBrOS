// Coding agents MemoBrOS can hand work to. One entry per agent, each using that tool's own documented
// non-interactive interface (checked against the real CLI's --help where the CLI could be installed; see
// docs/engineering/agentic-runtime-v0.6-state.md). No Electron here.
//
//   kind "acp"    speaks the Agent Client Protocol over stdio; driven by acp.js; asks permission per action
//   kind "cli"    one-shot command that edits files in its working folder; cannot ask, so MemoBrOS only runs it
//                 inside an isolated Git worktree whose changes need the user's approval to be merged
//   kind "cloud"  the work happens on the vendor's servers; every hand-off needs the user's approval
const fs = require('fs');
const os = require('os');
const path = require('path');
const executor = require('../actions/executor');
const { splitCommand } = require('../util/argv');

const AGENTS = {
  kiro: {
    name: 'Kiro CLI', kind: 'acp', binary: 'kiro-cli', acpCommand: 'kiro-cli acp', keep: /^(KIRO_|AWS_|AMAZON_Q_)/,
    note: 'Agent Client Protocol. Asks before each action.',
  },
  claude: {
    name: 'Claude Code', kind: 'cli', binary: 'claude',
    note: 'Headless mode (claude -p). Edits files in its worktree; cannot run shell commands unattended.',
    // -p/--print with JSON output; acceptEdits lets it edit files without a prompt, nothing more.
    // stream-json prints one JSON event per line while it works (the CLI requires --verbose with it in print mode).
    keep: /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_)/,
    build: ({ prompt, mcpConfig }) => ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', ...(mcpConfig ? ['--mcp-config', mcpConfig] : [])],
    progress: (e) => {
      if (e.type !== 'assistant') return '';
      const parts = (e.message?.content || []).map((b) => (b.type === 'tool_use' ? `Using ${b.name}${b.input?.file_path ? ` on ${path.basename(String(b.input.file_path))}` : ''}` : b.type === 'text' ? String(b.text || '').trim().split('\n')[0] : ''));
      return parts.filter(Boolean).pop() || '';
    },
    parse: ({ stdout }) => {
      const events = jsonLines(stdout);
      const j = events.reverse().find((e) => e.type === 'result') || events[0];
      if (!j) return stdout.trim();
      if (j.is_error) throw new Error(String(j.result || j.subtype || 'Claude Code reported an error'));
      return String(j.result || '').trim();
    },
  },
  codex: {
    name: 'Codex', kind: 'cli', binary: 'codex',
    note: 'codex exec with the workspace-write sandbox: it can only write inside its worktree.',
    // --json prints one JSON event per line while it works; -o still writes the final message to a file.
    keep: /^(OPENAI_|CODEX_|AZURE_OPENAI_)/,
    build: ({ prompt, cwd, outFile, overrides = [] }) => ['codex', 'exec', '-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check', '--json', ...overrides.flatMap((o) => ['-c', o]), '-o', outFile, prompt],
    progress: (e) => {
      const it = e.item || {};
      if (e.type === 'item.started' && it.type === 'command_execution') return `$ ${String(it.command || '').slice(0, 120)}`;
      if (e.type !== 'item.completed') return '';
      if (it.type === 'agent_message') return String(it.text || '').trim().split('\n')[0];
      if (it.type === 'file_change') return `Changed ${(it.changes || []).map((c) => path.basename(String(c.path || ''))).filter(Boolean).slice(0, 4).join(', ') || 'files'}`;
      if (it.type === 'mcp_tool_call') return `Using ${it.server || 'a connector'}${it.tool ? `: ${it.tool}` : ''}`;
      return '';
    },
    parse: ({ stdout, outFile }) => {
      try { const t = fs.readFileSync(outFile, 'utf8').trim(); if (t) return t; } catch { /* no file: fall back to the event stream */ }
      const last = jsonLines(stdout).filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').pop();
      return last ? String(last.item.text || '').trim() : stdout.trim();
    },
  },
  jules: {
    name: 'Google Jules', kind: 'cloud', binary: 'jules', keep: /^(JULES_|GOOGLE_)/,
    note: 'Cloud agent: the task and repository go to Google; results come back as a session you pull.',
    start: ({ prompt, repo }) => ['jules', 'new', ...(repo ? ['--repo', repo] : []), prompt],
    list: () => ['jules', 'remote', 'list', '--session'],
    pull: ({ session }) => ['jules', 'remote', 'pull', '--session', String(session)],
  },
  agy: {
    name: 'Antigravity (agy)', kind: 'cli', binary: 'agy', custom: true, keep: /^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_)/,
    note: 'No documented non-interactive interface could be checked. Enter the command yourself; {prompt} is replaced by the task.',
    build: ({ prompt, template }) => splitCommand(template).map((a) => a.replace('{prompt}', prompt)),
    parse: ({ stdout }) => stdout.trim(),
  },
};

// The JSON objects among the lines of some output; anything else is skipped.
function jsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) { const t = line.trim(); if (t.startsWith('{')) { try { out.push(JSON.parse(t)); } catch { /* not JSON */ } } }
  return out;
}

// The environment an agent starts with: the user's, minus credentials that are not that agent's own.
// An agent keeps the variables of its own vendor (its sign-in), plus any the user listed by name in Settings.
function agentEnv(id, { extra = {}, pass = [], env = process.env } = {}) {
  const own = AGENTS[id]?.keep;
  const names = (Array.isArray(pass) ? pass : String(pass || '').split(/[\s,]+/)).filter(Boolean);
  const out = executor.cleanEnv(env, {}, own || null);
  for (const n of names) if (env[n] !== undefined) out[n] = env[n];
  return { ...out, ...extra };
}

// Codex reads MCP servers from its configuration; `-c key=value` overrides add ours for one run without touching
// the user's ~/.codex/config.toml. Secrets never go on the command line (other programs can read it): they are
// placed in Codex's environment and the configuration only names the variable (env_vars, bearer_token_env_var,
// env_http_headers - checked against `codex mcp list/get` in Codex 0.169).
// → { overrides: ["mcp_servers.x.command=\"…\"", …], env: { NAME: secret }, skipped: [{ name, why }] }
function codexMcp(servers = []) {
  const overrides = [], env = {}, skipped = [];
  const toml = (v) => JSON.stringify(v); // a JSON string or array of strings is valid TOML
  servers.forEach((s, i) => {
    const name = String(s.name || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!name) { skipped.push({ name: String(s.name), why: 'its name cannot be used as a configuration key' }); return; }
    const key = `mcp_servers.${name}`;
    if (s.type === 'http') {
      const mine = [], vars = {};
      let bearer = '';
      for (const h of s.headers || []) {
        const v = `MEMOBROS_MCP_${i}_${String(h.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
        const m = /^Bearer\s+(.+)$/i.exec(String(h.value));
        if (/^authorization$/i.test(h.name) && m) { vars[v] = m[1]; bearer = v; } else { vars[v] = String(h.value); mine.push(`${toml(h.name)}=${toml(v)}`); }
      }
      Object.assign(env, vars);
      overrides.push(`${key}.url=${toml(s.url)}`);
      if (bearer) overrides.push(`${key}.bearer_token_env_var=${toml(bearer)}`);
      if (mine.length) overrides.push(`${key}.env_http_headers={${mine.join(',')}}`);
      return;
    }
    if (s.type && s.type !== 'stdio') { skipped.push({ name, why: `Codex has no "${s.type}" transport` }); return; }
    const vars = Object.fromEntries((s.env || []).map((e) => [e.name, String(e.value)]));
    const clash = Object.keys(vars).find((n) => /^(PATH|HOME|USERPROFILE|SHELL|TMPDIR|TEMP|TMP)$/i.test(n) || (n in env && env[n] !== vars[n]));
    if (clash) { skipped.push({ name, why: `its variable ${clash} would collide with another one` }); return; }
    Object.assign(env, vars);
    overrides.push(`${key}.command=${toml(s.command)}`, `${key}.args=${toml(s.args || [])}`);
    if (Object.keys(vars).length) overrides.push(`${key}.env_vars=${toml(Object.keys(vars))}`);
  });
  return { overrides, env, skipped };
}

// Is the agent's program installed, and which version?
async function detect(id, binary = AGENTS[id]?.binary) {
  if (!binary) return { id, installed: false, version: '' };
  const r = await executor.run({ argv: [binary, '--version'], cwd: os.tmpdir(), timeoutMs: 8000 });
  const installed = !r.error && r.exitCode === 0;
  return { id, installed, version: installed ? (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 60) : '' };
}
const detectAll = () => Promise.all(Object.keys(AGENTS).map((id) => detect(id)));

// Runs a one-shot CLI agent on a task inside `cwd`. → what the agent reported.
// opts: { cwd, signal, template (agy), mcpServers, timeoutMs, onUpdate(text), passEnv }
// onUpdate receives short progress lines while the agent works, where its CLI reports them (Claude Code, Codex).
async function runCli(id, prompt, opts) {
  const agent = AGENTS[id];
  if (!agent || agent.kind !== 'cli') throw new Error(`${id} is not a command-line coding agent.`);
  if (agent.custom && !String(opts.template || '').includes('{prompt}')) throw new Error(`${agent.name} has no command yet. Enter one containing {prompt} in Settings → Coding agent.`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memobros-agent-'));
  const outFile = path.join(scratch, 'last-message.txt');
  let mcpConfig = null;
  if (id === 'claude' && opts.mcpServers?.length) {
    // Claude Code reads MCP servers from a JSON file in the same shape as its own configuration.
    mcpConfig = path.join(scratch, 'mcp.json');
    const servers = {};
    for (const s of opts.mcpServers) servers[s.name] = s.type === 'http' ? { type: 'http', url: s.url, headers: Object.fromEntries((s.headers || []).map((h) => [h.name, h.value])) } : { command: s.command, args: s.args || [], env: Object.fromEntries((s.env || []).map((e) => [e.name, e.value])) };
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  }
  const shared = id === 'codex' && opts.mcpServers?.length ? codexMcp(opts.mcpServers) : { overrides: [], env: {}, skipped: [] };
  try {
    const argv = agent.build({ prompt, cwd: opts.cwd, outFile, mcpConfig, template: opts.template, overrides: shared.overrides });
    opts.onUpdate?.(`Running ${agent.name}…`);
    for (const s of shared.skipped) opts.onUpdate?.(`Connector "${s.name}" is not shared with ${agent.name}: ${s.why}.`);
    // Progress: complete lines of the event stream, turned into a short sentence each.
    let pending = '';
    const onOutput = agent.progress && opts.onUpdate ? (stream, text) => {
      if (stream !== 'stdout') return;
      pending += text;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const e of jsonLines(lines.join('\n'))) { const note = agent.progress(e); if (note) opts.onUpdate(note.slice(0, 200)); }
    } : undefined;
    // The agent keeps its own sign-in; other credentials in the user's environment are not handed to it.
    const r = await executor.run({ argv, cwd: opts.cwd, env: agentEnv(id, { extra: shared.env, pass: opts.passEnv }), signal: opts.signal, onOutput, timeoutMs: opts.timeoutMs || 30 * 60 * 1000, maxOutput: 2_000_000 });
    if (r.cancelled) throw Object.assign(new Error('Stopped.'), { aborted: true });
    if (r.error) throw new Error(r.error);
    if (r.timedOut) throw new Error(`${agent.name} did not finish within the time limit.`);
    if (r.exitCode !== 0) throw new Error(`${agent.name} exited with code ${r.exitCode}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    return agent.parse({ stdout: r.stdout, stderr: r.stderr, outFile }) || `${agent.name} finished without a written report.`;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

// Hands a task to a cloud agent. The caller must already have the user's approval. → the tool's own output.
async function startCloud(id, { prompt, repo, cwd, signal, passEnv }) {
  const agent = AGENTS[id];
  if (!agent || agent.kind !== 'cloud') throw new Error(`${id} is not a cloud agent.`);
  const r = await executor.run({ argv: agent.start({ prompt, repo }), cwd: cwd || os.tmpdir(), env: agentEnv(id, { pass: passEnv }), signal, timeoutMs: 120000 });
  if (r.error) throw new Error(r.error);
  if (r.exitCode !== 0) throw new Error(`${agent.name} could not start the session: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

module.exports = { AGENTS, detect, detectAll, runCli, startCloud, agentEnv, codexMcp, jsonLines };
