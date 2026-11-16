// Unit tests for the coding-agent adapters, against stand-in executables that enforce each real tool's flags.
// They prove the command lines, result parsing, failure handling and cancellation; they cannot prove a real agent's work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const fakeAgents = require('./fakeAgents');
const agents = require('../src/main/agents');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const realPath = process.env.PATH;
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-'));

test('agents are detected by their real program names; a missing one is reported, not assumed', async () => {
  process.env.PATH = `/usr/bin${path.delimiter}/bin`; // system tools only: no agent CLI lives there
  assert.ok((await agents.detectAll()).every((a) => a.installed === false), 'nothing is installed on a bare PATH');
  const f = fakeAgents(['claude', 'codex', 'jules']); process.env.PATH = `${f.dir}${path.delimiter}${process.env.PATH}`;
  const found = Object.fromEntries((await agents.detectAll()).map((a) => [a.id, a]));
  assert.deepEqual([found.claude.installed, found.claude.version, found.codex.version, found.jules.installed, found.kiro.installed, found.agy.installed], [true, '2.1.325 (Claude Code)', 'codex-cli 0.169.0', true, false, false]);
  assert.deepEqual(Object.entries(agents.AGENTS).map(([id, a]) => `${id}:${a.kind}`), ['kiro:acp', 'claude:cli', 'codex:cli', 'jules:cloud', 'agy:cli']);
});

test('Claude Code: headless print mode with JSON output and edit-only permission; works in the given folder; reports its result', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  const out = await agents.runCli('claude', 'PUT src/a.js hello from claude', { cwd });
  assert.equal(out, 'Claude Code report: put src/a.js');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'hello from claude\n');
  const call = f.calls().at(-1);
  assert.deepEqual(call.argv, ['-p', '<prompt>', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'], 'exactly the documented flags, no bypass-permissions mode');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(cwd));
  // MCP servers MemoBrOS knows are passed in Claude Code's own config format, in a private temporary file
  await agents.runCli('claude', 'look', { cwd, mcpServers: [{ name: 'Sales DB', command: 'node', args: ['db.js'], env: [{ name: 'K', value: 'v' }] }, { type: 'http', name: 'Weather', url: 'https://w/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] }] });
  const withMcp = f.calls().at(-1);
  assert.deepEqual(withMcp.mcp, { mcpServers: { 'Sales DB': { command: 'node', args: ['db.js'], env: { K: 'v' } }, Weather: { type: 'http', url: 'https://w/mcp', headers: { Authorization: 'Bearer t' } } } });
  assert.ok(!fs.existsSync(withMcp.argv[withMcp.argv.indexOf('--mcp-config') + 1]), 'the temporary config file is removed afterwards');
});

test('Codex: exec with the workspace-write sandbox, pinned to the folder, result read from its last-message file', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  assert.equal(await agents.runCli('codex', 'PUT b.txt from codex', { cwd }), 'Codex report: put b.txt');
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'from codex\n');
  const call = f.calls().at(-1);
  assert.deepEqual(call.argv.slice(0, 6), ['exec', '-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check']);
  assert.ok(!call.argv.includes('danger-full-access') && !call.argv.includes('--full-auto'), 'never the unrestricted sandbox');
});

test('progress arrives while the agent works: one short line per event, from each tool\'s own event stream', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  const seen = [];
  const out = await agents.runCli('claude', 'PUT docs/notes.md hi', { cwd, onUpdate: (t) => seen.push(t) });
  assert.deepEqual(seen, ['Running Claude Code…', 'Using Write on notes.md', 'Wrapping up.']);
  assert.equal(out, 'Claude Code report: put docs/notes.md', 'the final report still comes from the result event');
  const codexSeen = [];
  await agents.runCli('codex', 'PUT c.txt x', { cwd, onUpdate: (t) => codexSeen.push(t) });
  assert.deepEqual(codexSeen, ['Running Codex…', '$ git status', 'Changed c.txt', 'Finished the task.']);
  assert.ok(f.calls().at(-1).argv.includes('--json'));
  // events split across chunks, and lines that are not JSON, are handled
  assert.deepEqual(agents.jsonLines('{"a":1}\nnot json\n{"b":\n{"c":2}').map((e) => Object.keys(e)[0]), ['a', 'c']);
});

test('an agent starts with its own sign-in only: other credentials in the environment are withheld', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n', MEMOBROS_WORKER_SECRET: 'w' });
  try {
    await agents.runCli('claude', 'look', { cwd });
    const claude = f.calls().at(-1).envNames;
    assert.ok(claude.includes('ANTHROPIC_API_KEY') && claude.includes('PATH') && claude.includes('HOME'));
    assert.deepEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MEMOBROS_WORKER_SECRET'].filter((k) => claude.includes(k)), []);
    await agents.runCli('codex', 'look', { cwd, passEnv: 'NPM_TOKEN, NOT_SET' });
    const codex = f.calls().at(-1).envNames;
    assert.ok(codex.includes('OPENAI_API_KEY') && codex.includes('NPM_TOKEN'), 'its own key, plus what the user listed by name');
    assert.deepEqual(['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MEMOBROS_WORKER_SECRET', 'NOT_SET'].filter((k) => codex.includes(k)), []);
    assert.ok(!('GITHUB_TOKEN' in agents.agentEnv('kiro')) && !('OPENAI_API_KEY' in agents.agentEnv('custom')), 'ACP agents get the same treatment');
  } finally { for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'MEMOBROS_WORKER_SECRET']) delete process.env[k]; }
});

test('Codex receives the MCP servers MemoBrOS knows as configuration overrides; secrets travel in the environment, never on the command line', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  const servers = [
    { name: 'Sales DB', command: 'node', args: ['db.js', 'two words'], env: [{ name: 'DB_PASS', value: 'hunter2' }] },
    { type: 'http', name: 'Weather', url: 'https://w.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-123' }, { name: 'X-Api-Key', value: 'key-456' }] },
    { name: 'Clash', command: 'x', env: [{ name: 'DB_PASS', value: 'different' }] },
    { type: 'sse', name: 'Old', url: 'https://old/sse' },
  ];
  const notes = [];
  await agents.runCli('codex', 'look', { cwd, mcpServers: servers, onUpdate: (t) => notes.push(t) });
  const call = f.calls().at(-1);
  assert.deepEqual(call.config, [
    'mcp_servers.Sales_DB.command="node"', 'mcp_servers.Sales_DB.args=["db.js","two words"]', 'mcp_servers.Sales_DB.env_vars=["DB_PASS"]',
    'mcp_servers.Weather.url="https://w.example/mcp"', 'mcp_servers.Weather.bearer_token_env_var="MEMOBROS_MCP_1_AUTHORIZATION"', 'mcp_servers.Weather.env_http_headers={"X-Api-Key"="MEMOBROS_MCP_1_X_API_KEY"}',
  ]);
  assert.deepEqual(call.mcpEnv, { DB_PASS: 'hunter2', MEMOBROS_MCP_1_AUTHORIZATION: 'tok-123', MEMOBROS_MCP_1_X_API_KEY: 'key-456' });
  assert.ok(!/hunter2|tok-123|key-456/.test(JSON.stringify(call.argv)), 'no secret appears among the arguments');
  assert.ok(notes.some((n) => /"Clash" is not shared with Codex: its variable DB_PASS would collide/.test(n)) && notes.some((n) => /"Old" is not shared with Codex: Codex has no "sse" transport/.test(n)), 'what could not be shared is said, not dropped silently');
});

test('a failing, missing or cancelled agent is reported as such', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  await assert.rejects(agents.runCli('claude', 'PUT half.txt partial\nCRASH', { cwd }), /Claude Code exited with code 9: .*simulated failure/);
  assert.ok(fs.existsSync(path.join(cwd, 'half.txt')), 'partial work stays where it was written (the caller keeps it on its own branch)');
  const abort = new AbortController();
  const pending = agents.runCli('claude', 'SLOW', { cwd, signal: abort.signal });
  setTimeout(() => abort.abort(), 500);
  await assert.rejects(pending, (e) => e.aborted === true);
  process.env.PATH = `/usr/bin${path.delimiter}/bin`;
  await assert.rejects(agents.runCli('codex', 'x', { cwd }), /"codex" is not installed or not on PATH/);
  await assert.rejects(agents.runCli('kiro', 'x', { cwd }), /not a command-line coding agent/);
});

test('Antigravity (agy): only runs with a command the user supplied; nothing is assumed about its interface', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const cwd = work();
  await assert.rejects(agents.runCli('agy', 'do it', { cwd }), /has no command yet\. Enter one containing \{prompt\}/);
  await assert.rejects(agents.runCli('agy', 'do it', { cwd, template: 'agy run' }), /has no command yet/);
  assert.equal(await agents.runCli('agy', 'PUT c.txt from agy', { cwd, template: 'agy --some-flag "{prompt}"' }), 'agy report: put c.txt');
  assert.deepEqual(f.calls().at(-1).argv, ['--some-flag', 'PUT c.txt from agy'], 'the task is passed as one argument, exactly where the user put it');
});

test('Jules is a cloud agent: a session is started with its documented command and nothing runs locally', async () => {
  const f = fakeAgents(); process.env.PATH = `${f.dir}${path.delimiter}${realPath}`;
  const out = await agents.startCloud('jules', { prompt: 'write unit tests', repo: 'owner/project' });
  assert.match(out, /Session created: 123456/);
  assert.deepEqual(f.calls().at(-1).argv, ['new', '--repo', 'owner/project', '<prompt>']);
  assert.deepEqual(agents.AGENTS.jules.list(), ['jules', 'remote', 'list', '--session']);
  assert.deepEqual(agents.AGENTS.jules.pull({ session: 123456 }), ['jules', 'remote', 'pull', '--session', '123456']);
  await assert.rejects(agents.runCli('jules', 'x', { cwd: work() }), /not a command-line coding agent/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  process.env.PATH = realPath;
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
