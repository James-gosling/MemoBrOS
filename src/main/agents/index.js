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
    name: 'Kiro CLI', kind: 'acp', binary: 'kiro-cli', acpCommand: 'kiro-cli acp',
    note: 'Agent Client Protocol. Asks before each action.',
  },
  claude: {
    name: 'Claude Code', kind: 'cli', binary: 'claude',
    note: 'Headless mode (claude -p). Edits files in its worktree; cannot run shell commands unattended.',
    // -p/--print with JSON output; acceptEdits lets it edit files without a prompt, nothing more.
    build: ({ prompt, mcpConfig }) => ['claude', '-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', ...(mcpConfig ? ['--mcp-config', mcpConfig] : [])],
    parse: ({ stdout }) => {
      try {
        const j = JSON.parse(stdout.trim().split('\n').pop());
        if (j.is_error) throw new Error(String(j.result || j.subtype || 'Claude Code reported an error'));
        return String(j.result || '').trim();
      } catch (e) { if (e instanceof SyntaxError) return stdout.trim(); throw e; }
    },
  },
  codex: {
    name: 'Codex', kind: 'cli', binary: 'codex',
    note: 'codex exec with the workspace-write sandbox: it can only write inside its worktree.',
    build: ({ prompt, cwd, outFile }) => ['codex', 'exec', '-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check', '-o', outFile, prompt],
    parse: ({ stdout, outFile }) => { try { return fs.readFileSync(outFile, 'utf8').trim() || stdout.trim(); } catch { return stdout.trim(); } },
  },
  jules: {
    name: 'Google Jules', kind: 'cloud', binary: 'jules',
    note: 'Cloud agent: the task and repository go to Google; results come back as a session you pull.',
    start: ({ prompt, repo }) => ['jules', 'new', ...(repo ? ['--repo', repo] : []), prompt],
    list: () => ['jules', 'remote', 'list', '--session'],
    pull: ({ session }) => ['jules', 'remote', 'pull', '--session', String(session)],
  },
  agy: {
    name: 'Antigravity (agy)', kind: 'cli', binary: 'agy', custom: true,
    note: 'No documented non-interactive interface could be checked. Enter the command yourself; {prompt} is replaced by the task.',
    build: ({ prompt, template }) => splitCommand(template).map((a) => a.replace('{prompt}', prompt)),
    parse: ({ stdout }) => stdout.trim(),
  },
};

// Is the agent's program installed, and which version?
async function detect(id, binary = AGENTS[id]?.binary) {
  if (!binary) return { id, installed: false, version: '' };
  const r = await executor.run({ argv: [binary, '--version'], cwd: os.tmpdir(), timeoutMs: 8000, env: process.env });
  const installed = !r.error && r.exitCode === 0;
  return { id, installed, version: installed ? (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 60) : '' };
}
const detectAll = () => Promise.all(Object.keys(AGENTS).map((id) => detect(id)));

// Runs a one-shot CLI agent on a task inside `cwd`. → what the agent reported.
// opts: { cwd, signal, template (agy), mcpServers, timeoutMs, onUpdate }
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
  try {
    const argv = agent.build({ prompt, cwd: opts.cwd, outFile, mcpConfig, template: opts.template });
    opts.onUpdate?.(`Running ${agent.name}…`);
    // The agent needs its own sign-in from the user's environment, so the environment is passed through unchanged.
    const r = await executor.run({ argv, cwd: opts.cwd, env: process.env, signal: opts.signal, timeoutMs: opts.timeoutMs || 30 * 60 * 1000, maxOutput: 2_000_000 });
    if (r.cancelled) throw Object.assign(new Error('Stopped.'), { aborted: true });
    if (r.error) throw new Error(r.error);
    if (r.timedOut) throw new Error(`${agent.name} did not finish within the time limit.`);
    if (r.exitCode !== 0) throw new Error(`${agent.name} exited with code ${r.exitCode}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    return agent.parse({ stdout: r.stdout, stderr: r.stderr, outFile }) || `${agent.name} finished without a written report.`;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

// Hands a task to a cloud agent. The caller must already have the user's approval. → the tool's own output.
async function startCloud(id, { prompt, repo, cwd, signal }) {
  const agent = AGENTS[id];
  if (!agent || agent.kind !== 'cloud') throw new Error(`${id} is not a cloud agent.`);
  const r = await executor.run({ argv: agent.start({ prompt, repo }), cwd: cwd || os.tmpdir(), env: process.env, signal, timeoutMs: 120000 });
  if (r.error) throw new Error(r.error);
  if (r.exitCode !== 0) throw new Error(`${agent.name} could not start the session: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

module.exports = { AGENTS, detect, detectAll, runCli, startCloud };
