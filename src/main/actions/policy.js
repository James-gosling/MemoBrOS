// Which commands may run. Pure functions, no Electron, so the rules can be tested on their own.
//
// Three outcomes for a command line:
//   deny  - never runs, whoever asks and whatever they approve (privilege escalation, disk and system tools,
//           recursive deletes of the root or home folder, download-and-execute pipes, work outside allowed folders)
//   allow - runs without asking, because the user chose "always allow" for exactly this kind of command
//   ask   - everything else: the user sees the exact command and folder and decides
// Agents never get a general shell: a line that needs a shell (pipes, redirects, `&&`, substitutions) is always "ask".
const path = require('path');
const { splitCommand } = require('../util/argv');

const base = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
// Characters that only mean something to a shell, outside quotes.
function needsShell(line) {
  const bare = String(line).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
  return /[|&;<>`\n]|\$\(|\$\{|\*\*|(^|\s)~(\/|\s|$)/.test(bare) && !/^\s*$/.test(bare);
}

const NEVER = [
  [/(^|[\s;&|(])(sudo|su|doas|pkexec|runas|gsudo)(\s|$)/i, 'it asks for administrator rights'],
  [/(^|[\s;&|(])(shutdown|reboot|halt|poweroff|systemctl\s+(poweroff|reboot|halt)|init\s+[06])(\s|$)/i, 'it would shut down or restart the computer'],
  [/(^|[\s;&|(])(mkfs(\.\w+)?|fdisk|parted|wipefs|diskpart|bcdedit|format(\.com)?)(\s|$)/i, 'it changes disks or boot settings'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'it writes directly to a disk device'],
  [/>\s*\/dev\/(sd|nvme|hd|mmcblk)/i, 'it writes directly to a disk device'],
  [/\brm\b[^\n]*\s-[a-z]*[rf][a-z]*[^\n]*\s(\/|\/\*|~|~\/|\$HOME|\$\{HOME\}|\/home|\/usr|\/etc|\/var|\/boot|[a-z]:\\?)(\s|$)/i, 'it would delete a system or home folder'],
  [/\b(rd|rmdir|del|erase)\b[^\n]*\s\/s[^\n]*\s[a-z]:\\?(\s|$)/i, 'it would delete a whole drive'],
  [/\b(chmod|chown)\b[^\n]*\s-R[^\n]*\s(\/|~|\$HOME)(\s|$)/i, 'it changes permissions of a system or home folder'],
  [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python\d?|node|pwsh|powershell|iex)\b/i, 'it downloads a script and runs it straight away'],
  [/:\(\)\s*\{[^}]*\}\s*;\s*:/, 'it is a fork bomb'],
  [/\breg(\.exe)?\s+delete\b/i, 'it deletes registry keys'],
  [/(^|[\s;&|(])(passwd|usermod|useradd|userdel|visudo|crontab\s+-r)(\s|$)/i, 'it changes user accounts or scheduled system jobs'],
];
// Programs that can do anything their arguments say; approving them once must not approve them for ever.
const NEVER_AUTO = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'taskkill', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp',
  'sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'eval', 'exec', 'xargs', 'env', 'nohup', 'docker', 'podman', 'kubectl', 'terraform', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'snap', 'brew', 'winget', 'choco', 'pip', 'pip3']);
// Programs whose first argument names the real action ("git status" is not "git push").
const SUBCOMMAND = new Set(['git', 'npm', 'yarn', 'pnpm', 'npx', 'cargo', 'go', 'make', 'gh', 'dotnet', 'mvn', 'gradle', 'systemctl', 'journalctl']);
const RISKY = [
  [/\bgit\s+(push\b[^\n]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+--\s|branch\s+-D)/i, 'this Git command can discard work'],
  [/\b(rm|del|erase|rd|rmdir)\b/i, 'this deletes files'],
  [/\bgit\s+push\b|\b(npm|yarn|pnpm|cargo)\s+publish\b|\bgh\s+(pr|release|repo)\s+(create|merge|delete)\b/i, 'this publishes something outside this computer'],
];

const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// The "always allow" rule a command would create: its program, plus its subcommand for tools like git and npm.
function ruleFor(argv) {
  const program = base(argv[0]);
  if (!program || NEVER_AUTO.has(program)) return null;
  if (!SUBCOMMAND.has(program)) return program;
  // skip options and the values some of them take ("git -C dir status")
  const rest = argv.slice(1);
  let sub = null;
  for (let i = 0; i < rest.length; i++) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--prefix', '--cwd'].includes(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) { sub = rest[i]; break; }
  }
  return sub ? `${program} ${sub}` : null;
}

// cfg: { roots: [folders], allow: ["git status", "ls", …] }  →  { decision, reason, argv, shell, rule, risk }
function decide(line, cwd, cfg = {}) {
  const text = String(line || '').trim();
  if (!text) return { decision: 'deny', reason: 'there is no command' };
  if (text.length > 4000) return { decision: 'deny', reason: 'the command is too long' };
  for (const [re, why] of NEVER) if (re.test(text)) return { decision: 'deny', reason: `This command is never run because ${why}.` };
  const roots = (cfg.roots || []).filter(Boolean).map((r) => path.resolve(r));
  const dir = path.resolve(cwd || roots[0] || '.');
  if (!roots.length) return { decision: 'deny', reason: 'No folder is set where commands may run. Choose a project folder in Settings → Coding agent.' };
  if (!roots.some((r) => within(dir, r))) return { decision: 'deny', reason: `Commands may only run inside ${roots.join(' or ')}; ${dir} is outside.` };
  const shell = needsShell(text);
  const argv = shell ? [] : splitCommand(text);
  const risk = (RISKY.find(([re]) => re.test(text)) || [])[1] || '';
  const rule = shell || risk ? null : ruleFor(argv);
  const allowed = rule && (cfg.allow || []).map((a) => String(a).trim().toLowerCase()).includes(rule);
  return { decision: allowed ? 'allow' : 'ask', reason: '', argv, shell, rule, risk, cwd: dir };
}

module.exports = { decide, ruleFor, needsShell, NEVER_AUTO };
