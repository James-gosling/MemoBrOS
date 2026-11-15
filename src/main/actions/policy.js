// Which commands may run. Pure functions, no Electron, so the rules can be tested on their own.
//
// Three outcomes for a command line:
//   deny  - never runs, whoever asks and whatever they approve (privilege escalation, disk and system tools,
//           recursive deletes of the root or home folder, download-and-execute pipes, work outside allowed folders)
//   allow - runs without asking, because the user chose "always allow" for exactly this kind of command
//   ask   - everything else: the user sees the exact command and folder and decides
// Agents never get a general shell: a line that needs a shell (pipes, redirects, `&&`, substitutions) is always "ask".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitCommand } = require('../util/argv');

const base = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
// Characters that only mean something to a shell, outside quotes.
function needsShell(line) {
  const bare = String(line).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
  return /[|&;<>`\n]|\$\(|\$\{|\*\*|(^|\s)~(\/|\s|$)/.test(bare) && !/^\s*$/.test(bare);
}

// ── Never run, part 1: patterns on the raw line (shell constructs that cannot be seen word by word) ──────────
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

// ── Never run, part 2: the same rules on the words of each command, so quoting ("sudo"), a full path
// (/usr/bin/sudo), a wrapper (env, nohup, timeout, xargs …) or a nested shell (sh -c "…") does not hide it ────
const ADMIN = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas', 'gsudo']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
const DISK = new Set(['fdisk', 'parted', 'wipefs', 'diskpart', 'bcdedit', 'format', 'sfdisk', 'cfdisk']);
const ACCOUNTS = new Set(['passwd', 'usermod', 'useradd', 'userdel', 'visudo', 'adduser', 'deluser']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
// Wrappers that run the command that follows them; the number is how many of their own leading words to skip.
const WRAPPERS = { env: 0, nohup: 0, nice: 0, ionice: 0, time: 0, command: 0, exec: 0, builtin: 0, setsid: 0, stdbuf: 0, xargs: 0, timeout: 1, watch: 0, chronic: 0, start: 0, call: 0,
  if: 0, then: 0, else: 0, elif: 0, do: 0, while: 0, until: 0, '!': 0 }; // shell keywords sit in front of a command the same way

// Splits a line into its simple commands at shell operators, outside quotes.
function segments(line) {
  const out = [];
  let cur = '', quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { cur += c; if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ('|&;\n(){}`'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// Every command a line would start, as word lists, looking through wrappers and nested shells.
function commands(line, depth = 0) {
  const out = [];
  for (const seg of segments(String(line))) {
    let argv = splitCommand(seg);
    for (let guard = 0; argv.length && guard < 8; guard++) {
      while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1); // VAR=value prefixes
      const program = base(argv[0]);
      if (!(program in WRAPPERS)) break;
      out.push(argv); // the wrapper itself is a command too
      let rest = argv.slice(1);
      while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) rest = rest.slice(1);
      // A wrapper's own options can take values ("nice -n 5 cmd", "env -u NAME cmd"), so where the real command
      // starts is not certain: every later word is also looked at as a possible command.
      for (let i = 1; i < Math.min(rest.length, 6); i++) out.push(rest.slice(i));
      argv = rest.slice(WRAPPERS[program]);
    }
    if (!argv.length) continue;
    out.push(argv);
    if (SHELLS.has(base(argv[0])) && depth < 3) {
      const i = argv.findIndex((a, n) => n > 0 && /^(-[a-z]*c|\/c|\/k|-command|-encodedcommand|-e|-ec)$/i.test(a));
      if (i > 0 && argv[i + 1]) out.push(...commands(argv.slice(i + 1).join(' '), depth + 1));
    }
  }
  return out;
}

const HOME_WORDS = new Set(['~', '~/', '$home', '${home}', '$home/', '%userprofile%', '%homepath%']);
const SYSTEM_DIRS = new Set(['/', '/*', '/home', '/usr', '/etc', '/var', '/boot', '/bin', '/sbin', '/lib', '/opt', '/root', '/sys', '/proc', '/dev']);
// Is this word the root, the home folder, a top-level system folder or a whole drive?
function precious(word) {
  const w = String(word).toLowerCase();
  if (HOME_WORDS.has(w) || /^[a-z]:[\\/]?\*?$/.test(w)) return true;
  const clean = w.length > 1 ? w.replace(/\/+\*?$/, '') || '/' : w;
  if (SYSTEM_DIRS.has(w) || SYSTEM_DIRS.has(clean)) return true;
  const home = os.homedir();
  return Boolean(home) && path.resolve(String(word).replace(/\/\*$/, '')) === home;
}
const flag = (argv, short, long) => argv.slice(1).some((a) => a === long || (/^-[a-z]+$/i.test(a) && short.test(a)));

// → why this one command is never run, or ''.
function forbidden(argv) {
  const program = base(argv[0]);
  const rest = argv.slice(1), words = rest.filter((a) => !a.startsWith('-'));
  if (ADMIN.has(program)) return 'it asks for administrator rights';
  if (POWER.has(program) || (program === 'systemctl' && words.some((a) => /^(poweroff|reboot|halt|kexec)$/i.test(a))) || (program === 'init' && /^[06]$/.test(words[0] || ''))) return 'it would shut down or restart the computer';
  if (DISK.has(program) || /^mkfs(\.|$)/.test(program)) return 'it changes disks or boot settings';
  if (program === 'dd' && rest.some((a) => /^of=\/dev\//i.test(a))) return 'it writes directly to a disk device';
  if (program === 'rm' && flag(argv, /r/i, '--recursive') && words.some(precious)) return 'it would delete a system or home folder';
  if (['rd', 'rmdir', 'del', 'erase'].includes(program) && rest.some((a) => /^\/s$/i.test(a)) && rest.some(precious)) return 'it would delete a whole drive';
  if (['chmod', 'chown', 'chgrp'].includes(program) && flag(argv, /R/, '--recursive') && words.some(precious)) return 'it changes permissions of a system or home folder';
  if (program === 'reg' && /^delete$/i.test(words[0] || '')) return 'it deletes registry keys';
  if (ACCOUNTS.has(program) || (program === 'crontab' && rest.includes('-r'))) return 'it changes user accounts or scheduled system jobs';
  return '';
}

// Programs that can do anything their arguments say; approving them once must not approve them for ever.
const NEVER_AUTO = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'cp', 'copy', 'ln', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'taskkill', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'eval', 'exec', 'xargs', 'env', 'nohup', 'timeout', 'find', 'awk', 'sed', 'tee', 'tar', 'unzip',
  'npx', 'open', 'xdg-open', 'start', 'docker', 'podman', 'kubectl', 'terraform', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'snap', 'flatpak', 'brew', 'winget', 'choco', 'pip', 'pip3']);
// Programs whose first argument names the real action ("git status" is not "git push").
const SUBCOMMAND = new Set(['git', 'npm', 'yarn', 'pnpm', 'cargo', 'go', 'make', 'gh', 'dotnet', 'mvn', 'gradle', 'systemctl', 'journalctl']);
// Options that make a tool run something else or read another configuration: never part of a standing rule.
const REDIRECTING = /^(-c|--config-env|--exec-path|--exec|--upload-pack|--receive-pack|-f|--file|--makefile|--userconfig|--globalconfig|--script-shell)(=|$)/;
const RISKY = [
  [/\bgit\s+(push\b[^\n]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+--\s|branch\s+-D)/i, 'this Git command can discard work'],
  [/\b(rm|del|erase|rd|rmdir)\b/i, 'this deletes files'],
  [/\bgit\s+push\b|\b(npm|yarn|pnpm|cargo)\s+publish\b|\bgh\s+(pr|release|repo)\s+(create|merge|delete)\b/i, 'this publishes something outside this computer'],
];

// Follows symbolic links for the part of the path that exists, so a link inside an allowed folder cannot lead out.
function real(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail); } catch { /* does not exist yet: try its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    tail.unshift(path.basename(cur)); cur = up;
  }
}
const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

// Arguments that name a place outside the allowed folders ("cat /etc/passwd", "git -C ../other", "--out=~/x").
// This is a check on what the command says, not a sandbox: a program can still open any file the user can.
function outside(argv, dir, roots) {
  const hits = [];
  for (const arg of argv.slice(1)) {
    for (const word of [arg, arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '']) {
      if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue; // URLs are not local paths
      let target = path.resolve(dir, word); // also catches a link inside the folder that leads out of it
      if (/^~($|[\\/])/.test(word)) target = path.join(os.homedir(), word.slice(1));
      else if (/^\$\{?HOME\}?($|\/)/.test(word) || /^%(USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA)%/i.test(word)) target = os.homedir();
      else if (path.isAbsolute(word) || /^[a-z]:[\\/]/i.test(word)) target = word;
      if (!roots.some((r) => within(real(target), r))) hits.push(word);
    }
  }
  return [...new Set(hits)];
}

// The "always allow" rule a command would create: its program, plus its subcommand for tools like git and npm
// (and the script name for "npm run"). → null when no standing rule may exist for it.
function ruleFor(argv) {
  const program = base(argv[0]);
  if (!program || NEVER_AUTO.has(program)) return null;
  if (!SUBCOMMAND.has(program)) return program;
  const rest = argv.slice(1);
  if (rest.some((a) => REDIRECTING.test(a))) return null;
  const words = [];
  for (let i = 0; i < rest.length && words.length < 2; i++) {
    if (['-C', '--git-dir', '--work-tree', '--prefix', '--cwd'].includes(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) words.push(rest[i]);
  }
  if (!words.length) return null;
  const runs = ['npm', 'yarn', 'pnpm'].includes(program) && /^(run|run-script|exec|dlx)$/.test(words[0]);
  if (runs && (/^(exec|dlx)$/.test(words[0]) || !words[1])) return null; // runs an arbitrary package or nothing specific
  return [program, words[0], ...(runs ? [words[1]] : [])].join(' ').toLowerCase();
}

// cfg: { roots: [folders], allow: ["git status", "ls", …] }  →  { decision, reason, argv, shell, rule, risk, outside }
function decide(line, cwd, cfg = {}) {
  const text = String(line || '').trim();
  if (!text) return { decision: 'deny', reason: 'there is no command' };
  if (text.length > 4000) return { decision: 'deny', reason: 'the command is too long' };
  if (/\0/.test(text)) return { decision: 'deny', reason: 'the command contains a control character' };
  const shell = needsShell(text);
  // A plain command is started exactly as its words say, so the word-by-word check below is exact. A line a shell
  // will interpret can hide things in ways words cannot show, so the broad patterns apply to all of it as well.
  if (shell) for (const [re, why] of NEVER) if (re.test(text)) return { decision: 'deny', reason: `This command is never run because ${why}.` };
  for (const argv of commands(text)) { const why = forbidden(argv); if (why) return { decision: 'deny', reason: `This command is never run because ${why}.` }; }
  const roots = (cfg.roots || []).filter(Boolean).map(real);
  if (!roots.length) return { decision: 'deny', reason: 'No folder is set where commands may run. Choose a project folder in Settings → Coding agent.' };
  const dir = real(cwd || roots[0]);
  if (!roots.some((r) => within(dir, r))) return { decision: 'deny', reason: `Commands may only run inside ${roots.join(' or ')}; ${dir} is outside.` };
  const argv = shell ? [] : splitCommand(text);
  const beyond = shell ? [] : outside(argv, dir, roots);
  const risk = (RISKY.find(([re]) => re.test(text)) || [])[1] || (beyond.length ? `it reaches outside the allowed folders (${beyond.slice(0, 3).join(', ')})` : '');
  const rule = shell || risk ? null : ruleFor(argv);
  const allowed = rule && (cfg.allow || []).map((a) => String(a).trim().toLowerCase()).includes(rule);
  return { decision: allowed ? 'allow' : 'ask', reason: '', argv, shell, rule, risk, outside: beyond, cwd: dir };
}

module.exports = { decide, ruleFor, needsShell, commands, forbidden, outside, real, NEVER_AUTO };
