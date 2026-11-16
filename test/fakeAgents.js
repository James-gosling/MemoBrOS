// Stand-in executables for coding-agent CLIs, to be put first on PATH. Each one enforces the flags of the real
// tool (as read from its --help) and fails on anything else, so a wrong command line cannot pass unnoticed.
// They log their invocation to <dir>/calls.jsonl and follow "PUT <file> <text>" / "CRASH" / "SLOW" lines in the task.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON = `
const fs = require('fs'), path = require('path');
const log = (e) => fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ tool: TOOL, cwd: process.cwd(), envNames: Object.keys(process.env), ...e }) + '\\n');
const fail = (m) => { process.stderr.write(TOOL + ': ' + m + '\\n'); log({ rejected: m }); process.exit(2); };
function work(prompt, dir) {
  const own = (/Your part:\\n([\\s\\S]*?)\\n\\nThe other agents/.exec(prompt) || [0, prompt])[1];
  const did = [];
  for (const m of own.matchAll(/^PUT (\\S+) (.*)$/gm)) { fs.mkdirSync(path.dirname(path.join(dir, m[1])), { recursive: true }); fs.writeFileSync(path.join(dir, m[1]), m[2] + '\\n'); did.push('put ' + m[1]); }
  if (/^CRASH$/m.test(own)) { process.stderr.write('simulated failure\\n'); process.exit(9); }
  return { did, slow: /^SLOW$/m.test(own) };
}
`;
const SCRIPTS = {
  claude: `const TOOL = 'claude';${COMMON}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.325 (Claude Code)'); process.exit(0); }
const known = { '-p': 1, '--print': 1, '--output-format': 1, '--permission-mode': 1, '--mcp-config': 1, '--allowedTools': 1, '--model': 1 };
const o = {};
for (let i = 0; i < a.length; i++) { if (a[i] === '--verbose') { o[a[i]] = true; continue; } if (!(a[i] in known)) fail('unknown option ' + a[i]); o[a[i]] = a[++i]; }
const prompt = o['-p'] || o['--print'];
if (!prompt) fail('--print needs a prompt');
if (!['json', 'stream-json'].includes(o['--output-format'])) fail('bad --output-format');
if (o['--output-format'] === 'stream-json' && !o['--verbose']) fail('When using --print, --output-format=stream-json requires --verbose');
if (!['acceptEdits', 'default', 'plan'].includes(o['--permission-mode'])) fail('bad --permission-mode ' + o['--permission-mode']);
const mcp = o['--mcp-config'] ? JSON.parse(fs.readFileSync(o['--mcp-config'], 'utf8')) : null;
log({ argv: a.map((x) => (x === prompt ? '<prompt>' : x)), prompt, mcp, hasKey: !!process.env.FAKE_AGENT_LOGIN });
const w = work(prompt, process.cwd());
const say = (e) => console.log(JSON.stringify(e));
if (o['--output-format'] === 'stream-json') {
  say({ type: 'system', subtype: 'init', session_id: 's1' });
  for (const d of w.did) say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(process.cwd(), d.slice(4)) } }] } });
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Wrapping up.\\nDetails follow.' }] } });
}
const done = () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Claude Code report: ' + (w.did.join(', ') || 'nothing to change'), session_id: 's1' }));
if (w.slow) setTimeout(done, 20000); else done();
`,
  codex: `const TOOL = 'codex';${COMMON}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0); }
if (a[0] !== 'exec') fail('expected the exec subcommand');
const o = {}; let prompt = null;
for (let i = 1; i < a.length; i++) {
  if (a[i] === '--skip-git-repo-check' || a[i] === '--json') o[a[i]] = true;
  else if (a[i] === '-c' || a[i] === '--config') (o.config = o.config || []).push(a[++i]);
  else if (['-s', '--sandbox', '-C', '--cd', '-o', '--output-last-message', '-m', '--model'].includes(a[i])) o[a[i]] = a[++i];
  else if (a[i].startsWith('-')) fail('unknown option ' + a[i]);
  else prompt = a[i];
}
if (!prompt) fail('no prompt');
if (!['read-only', 'workspace-write'].includes(o['-s'] || o['--sandbox'])) fail('sandbox must be read-only or workspace-write, got ' + (o['-s'] || o['--sandbox']));
const dir = o['-C'] || o['--cd'] || process.cwd();
log({ argv: a.map((x) => (x === prompt ? '<prompt>' : x)), prompt, dir, config: o.config || [], mcpEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(MEMOBROS_MCP_|DB_PASS$)/.test(k))) });
const w = work(prompt, dir);
fs.writeFileSync(o['-o'] || o['--output-last-message'], 'Codex report: ' + (w.did.join(', ') || 'nothing to change'));
if (o['--json']) {
  const say = (e) => console.log(JSON.stringify(e));
  say({ type: 'thread.started', thread_id: 't1' });
  say({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'git status', status: 'in_progress' } });
  if (w.did.length) say({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: w.did.map((d) => ({ path: path.join(dir, d.slice(4)), kind: 'add' })) } });
  say({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Finished the task.' } });
  say({ type: 'turn.completed', usage: {} });
} else console.log('codex session finished');
`,
  jules: `const TOOL = 'jules';${COMMON}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('jules 0.1.42'); process.exit(0); }
if (a[0] === 'new') {
  let repo = '', prompt = null;
  for (let i = 1; i < a.length; i++) { if (a[i] === '--repo') repo = a[++i]; else if (a[i] === '--parallel') i++; else if (a[i].startsWith('-')) fail('unknown option ' + a[i]); else prompt = a[i]; }
  if (!prompt) fail('no task');
  log({ argv: a.map((x) => (x === prompt ? '<prompt>' : x)), prompt, repo });
  console.log('Session created: 123456\\nRepo: ' + (repo || '(current)'));
} else if (a[0] === 'remote' && a[1] === 'list' && a[2] === '--session') { log({ argv: a }); console.log('123456  In progress  write unit tests'); }
else if (a[0] === 'remote' && a[1] === 'pull' && a[2] === '--session') { log({ argv: a }); console.log('diff --git a/x b/x'); }
else fail('unknown command ' + a.join(' '));
`,
  agy: `const TOOL = 'agy';${COMMON}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('agy 0.0.0-standin'); process.exit(0); }
log({ argv: a });
const w = work(a[a.length - 1], process.cwd());
console.log('agy report: ' + (w.did.join(', ') || 'nothing to change'));
`,
};

module.exports = function fakeAgents(which = Object.keys(SCRIPTS)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agents-'));
  for (const name of which) {
    fs.writeFileSync(path.join(dir, `${name}.js`), SCRIPTS[name]);
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, `${name}.js`)}" "$@"\n`); // absolute Node path: PATH may not include it
    fs.chmodSync(path.join(dir, name), 0o755);
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\${name}.js" %*\r\n`); // the shape of an npm shim
  }
  const file = path.join(dir, 'calls.jsonl');
  return { dir, calls: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
};
