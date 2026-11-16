# MemoBrOS v0.6.1 — cloud engineering continuation

Work done in Claude Code Cloud on the branch `claude/memobros-v0.6.1-cloud-hardening`, starting from commit
`2c66244` (v0.6.0, the head of `claude/festive-wozniak-5h9t6d`). Nothing here was run on the Ubuntu laptop or on
Windows. This file holds no secrets.

## 1. What each kind of evidence means

| Label | Meaning |
| --- | --- |
| mock | A stand-in program or scripted model answers. Proves MemoBrOS's side of the contract, not the other tool. |
| real process | A real program was started in the cloud container (Ubuntu 24.04, Node 22) and its real result checked. |
| real CLI, no account | The vendor's real CLI was run for `--help` or configuration parsing. No sign-in, no model call. |
| authenticated | A signed-in agent did real work. **None was run**: the container has no accounts. |
| desktop UI | The real Electron app was driven on a virtual display (Xvfb; headless Weston for Wayland). |
| laptop / Windows | Run on the actual machine. **None**: not reachable from here. |

## 2. Audit of v0.6.0 and what changed

### Security findings

| # | Finding in v0.6.0 | Severity | Status in v0.6.1 |
| --- | --- | --- | --- |
| 1 | Forbidden commands were matched on the raw text only: `"sudo" ls`, `/usr/bin/sudo ls`, `env sudo ls`, `nohup reboot`, `sh -c "sudo ls"`, `rm --recursive /`, `rm -rf "/"` were not refused. | High | Fixed: each command's words are checked, through wrappers, shell keywords and nested shells. |
| 2 | An "always allow" rule covered arguments reaching outside the allowed folders (`cat /etc/passwd`, `git -C /etc status`). | High | Fixed: such commands always ask, name the path, and never get a rule. |
| 3 | `git -c core.fsmonitor=<program> status` ran an arbitrary program under an allowed `git status`; `npm run` allowed every script; `npx` could be allowed for ever. | High | Fixed: redirecting options void the rule; `npm run <script>` is per script; `npx`, `npm exec`, `find`, `cp`, `sed`, `tar` and others never get a rule. |
| 4 | Folders were compared without following symbolic links (a link inside the project could lead out). | Medium | Fixed for the working folder and for arguments. |
| 5 | Coding agents (CLI, ACP, cloud) and MCP stdio servers inherited the whole environment, credentials included. | High | Fixed: each agent keeps its own vendor's variables plus those the user lists (`Settings → Coding agent`); MCP servers get a filtered environment plus their own values. |
| 6 | The credential filter missed `AWS_ACCESS_KEY_ID`, `*_PAT`, `DATABASE_URL`, `*_DSN`, cookies, passphrases, connection strings. | Medium | Fixed. |
| 7 | The remote worker could be started on a network address (`--host`), and its health check returned the host name. | High | Fixed: loopback only, enforced in code; health returns `{ok, protocol, streaming}`. |
| 8 | Worker: a non-numeric timestamp passed the freshness check (the signature was still required); oversized bodies were dropped without an answer. | Low | Fixed: 401 `malformed request`, 413 `request too large`, 400 for wrong types. |
| 9 | The main process accepted IPC from any frame; the panel and overlay could be navigated. | Medium | Fixed: only the top frame of the two local pages is served; navigation, new windows and webviews are refused. |
| 10 | Quitting left a running command or agent alive. | Medium | Fixed: quitting aborts the running request and routine (process tree included). |
| 12 | Saving settings rewrote or deleted the real `~/.config/autostart/memobros.desktop`, also from a test run or a profile with its own settings folder. | High | Fixed: temporary profiles never manage autostart; the installed profile only on a change of that setting. |
| 11 | A false positive: text that mentions a forbidden word (`git commit -m "remove sudo usage"`) was refused. | Low | Fixed for plain commands; lines that need a shell keep the broad patterns. |

Still open, by design or because it needs a decision:

- **No operating-system sandbox.** The policy judges what a command line says. A program that is approved can still
  read any file the user can. Real confinement needs bubblewrap/Landlock on Linux and a restricted token or
  AppContainer on Windows; that is a system-level change and needs approval.
- **An approved interpreter can do anything** (`node script.js`). It is always asked about, never allowed for ever.
- **Claude Code's MCP file** holds the connectors' secrets in a private temporary file (mode 0600, removed after the
  run). On Windows that mode is not enforced by the file system.
- **The worker trusts "approved: true"** from whoever holds the shared secret. That is the design: approval happens on
  the control plane. The worker's own never-run list and folder limit still apply.
- **Worker traffic is plain HTTP.** Correct on loopback and through an SSH tunnel; the app now warns when a worker
  address is not on this computer.

### Streaming and cancellation

| Path | Incremental output | Cancellation | Evidence |
| --- | --- | --- | --- |
| Local command | Yes: shown in the panel while it runs (batched, capped) | Stop kills the process tree | real process + desktop UI |
| Remote worker | Yes: NDJSON (`"stream": true`), forwarded to the panel | Closing the connection or `POST /v1/cancel` with the job id | real process (loopback) |
| Claude Code | Progress lines from `--output-format stream-json --verbose` | Process tree killed | flags: real CLI, no account. Event shapes and cancellation: mock |
| Codex | Progress lines from `--json` | Process tree killed | flags: real CLI, no account. Event shapes and cancellation: mock |
| Kiro (ACP) | `session/update` (unchanged) | `session/cancel`, then the process is closed | mock |
| Jules | None: the work is remote; the CLI prints once | Local command only; the cloud session is not cancelled | mock |
| Antigravity (agy) | None: no documented interface was verified | Process tree killed | mock |

**Not verified:** cancellation during real, authenticated model inference; the exact event shapes of Claude Code and
Codex during a real run (unknown events are ignored, so a mismatch loses progress lines, not the result); whether a
cancelled agent leaves its files half-written (the work stays on its own branch in any case).

### MCP

One registry: `settings.mcpServers` (secrets in the OS keychain through `safeStorage`). From it:

- MemoBrOS itself connects (stdio, streamable HTTP, SSE).
- Kiro and other ACP agents receive the servers in `session/new`, limited to the transports the agent announces.
- Claude Code receives them as `--mcp-config <file>`.
- **New:** Codex receives them as `-c mcp_servers.<name>.…` overrides for that run only; `~/.codex/config.toml` is
  not touched. Secrets are placed in Codex's environment and referenced by name (`env_vars`,
  `bearer_token_env_var`, `env_http_headers`). The generated overrides were parsed by the real Codex 0.169
  (`codex mcp list`, `codex mcp get`), without an account. Codex has no SSE transport: such servers are skipped and
  the user is told. Servers signed in through MemoBrOS's own OAuth flow are not shared with any agent (the token
  belongs to MemoBrOS's registration).
- Jules and agy: no documented way to pass MCP servers was verified, so none is passed.

### Windows readiness (nothing was run on Windows)

- npm-installed CLIs are `.cmd` scripts, which Node refuses to start without a shell. The executor now finds the
  script, and for npm's standard shim starts the Node program behind it directly; other batch files are only run
  with plain arguments. Tested as a pure function on Linux with a simulated file system.
- Process-tree cancellation uses `taskkill /T /F` (unchanged, untested on Windows).
- The policy recognises Windows forms (`C:\`, `%USERPROFILE%`, `.exe` suffixes, `cmd /c`); tested on Linux only.
- `.github/workflows/cross-platform-tests.yml` runs the unit suites on `windows-latest` for every pull request.
  They pass there (see section 3). That is automated evidence, not desktop validation.

## 3. Automated tests (cloud container, at the head of this branch)

`npm test`: worktrees 8/8, voice 7/7, speech models 11/11, pointer 4/4, autostart 5/5, actions 14/14, agents 9/9,
remote worker 8/8, Electron (Anthropic path) 9/9, Electron (free providers) 17/17, Electron desktop 14/14, real speech
models 4/4.

GitHub Actions (pull requests): unit suites on `ubuntu-latest` and `windows-latest`, two Electron suites on Linux, and
the Windows installer build. A green Windows run means those unit suites pass on a headless Windows server and the
installer builds; it says nothing about the installed app on a Windows desktop.

- mock: the model (scripted server), the agent CLIs, `gdbus`, the model download host, ACP agent.
- real process: commands, process trees, Git worktrees, the worker over loopback HTTP, sherpa-onnx with real Whisper
  models on synthetic voices.
- desktop UI: Electron under Xvfb; the Wayland part under headless Weston.

## 4. What the Electron end-to-end tests need

- `npm install` (brings `electron` and `playwright-core`; no browser download).
- A display: `xvfb-run` on Linux (`sudo apt install xvfb`). `e2e-desktop.js` also uses `weston` for its Wayland part
  and skips that part when Weston is missing.
- `git` and `tar` on PATH.
- `test/speech-real.test.js` skips itself without the fixtures from `scripts/fetch-speech-fixtures.sh`
  (`MEMOBROS_SPEECH_FIXTURES=<folder>`).
- No accounts, no keys, no network beyond localhost.
- On a real GNOME session the tests open real windows; run them under `xvfb-run` so they do not take over the desktop.

## 5. Acceptance on the Ubuntu laptop (unverified until run there)

Everything below happens in the clean checkout `/home/roy/MemoBrOS-Codex`. The development folder
`/home/roy/MemoBrOS` is never entered. Your real settings, saved keys, routines, connectors and autostart entry are
not read or changed: the tests and the acceptance run use their own settings folders, and a profile started that way
cannot change the autostart entry (section 5.4).

### 5.1 Install and run the automated tests

```bash
# Quit the running MemoBrOS first (tray → Quit): one microphone, one set of global shortcuts.
which xvfb-run || sudo apt install -y xvfb      # the only system change, and only if it is missing
cd /home/roy/MemoBrOS-Codex
git status --short                               # must print nothing; stop if it does
git fetch origin
git switch claude/memobros-v0.6.1-cloud-hardening
npm ci                                           # exactly the locked versions; replaces node_modules in this folder only
npm test
```

Expected: worktrees 8/8, voice 7/7, speech models 11/11, pointer 4/4, autostart 5/5, actions 14/14, agents 9/9,
remote worker 8/8, Electron 9/9, 17/17 and 14/14. The real-speech suite prints SKIP. No account, key or network
service is used: the model is a scripted stand-in on localhost. The Wayland part of the desktop suite is skipped
when `weston` is not installed; that is fine.

### 5.2 Start the app with a temporary acceptance profile

```bash
mkdir -p ~/memobros-acceptance/project && git -C ~/memobros-acceptance/project init -q
MEMOBROS_USER_DATA="$HOME/memobros-acceptance/profile" npm start
```

The profile starts empty (no keys, every permission off, no routines, no connectors). In Settings:

- "Start MemoBrOS with the system" is greyed out. That is the isolation working.
- Coding agent → project folder: `~/memobros-acceptance/project`. Commands can only run there.
- A model: paste a free OpenRouter key (a free account is enough, no payment method), or point it at OmniRoute if
  you already run it locally. The key is stored in the temporary profile only.
- Do not press "Install" for the GNOME pointer extension in this run: that button copies files into your real
  extensions folder. It is optional and not part of this acceptance.

### 5.3 Checks

| # | Do | Expect |
| --- | --- | --- |
| 1 | Type: "run git status in my project" | A card asks to allow commands at all, then a card shows the exact command and folder. After approving, the output appears in the panel. |
| 2 | Ask again, choose "Always allow git status", ask a third time | The third time runs without a card. `git status -uall` still runs without a card; `git push` asks. |
| 3 | Ask for `sudo ls`, then for `"sudo" ls` | Both refused, no card. |
| 4 | Ask for `cat /etc/hostname` | A card with "reaches outside the allowed folders"; no "always allow" offered. |
| 5 | Ask for `ping -c 30 127.0.0.1`, approve, wait for a few lines, press Stop | Lines arrive one by one; after Stop, `pgrep -x ping` in a terminal prints nothing. |
| 6 | Start the ping again, then quit from the tray | `pgrep -x ping` prints nothing. |
| 7 | In a terminal: `npm run worker -- --root ~/memobros-acceptance/project --host 0.0.0.0` | Refuses to start ("only listens on this machine"). |
| 8 | Tray icon, show/hide, "ARVI" in Spanish and English, dictation, pointer | As in v0.5/v0.6. Speech models are downloaded again into the temporary profile (Tiny is about 100 MB). |
| 9 | Optional, only with Claude Code or Codex already signed in: one small crew task, Stop in the middle | Progress lines appear; after Stop `pgrep -f "claude|codex"` is empty; the work is on its own branch. Uses that agent's quota. |

Check afterwards that nothing of yours changed:

```bash
ls -l ~/.config/autostart/ 2>/dev/null          # same as before the run
ls -l --time-style=long-iso ~/.config/MemoBrOS/settings.json   # not modified during the run
```

Clean up when done: `rm -rf ~/memobros-acceptance`. To go back: `git switch claude/festive-wozniak-5h9t6d` in the
Codex checkout, or simply leave it.

### 5.4 What protects the real configuration

- `MEMOBROS_USER_DATA` gives the app its own settings folder: settings, encrypted keys, routines, connectors,
  memory, speech models and the action log all live there.
- A profile started with `MEMOBROS_USER_DATA` (or by the tests) is a *temporary* profile. It never writes,
  replaces or removes `~/.config/autostart/memobros.desktop`, whatever is saved in it. The installed profile only
  touches the entry when you change that one setting, so saving other settings no longer rewrites it.
- Still shared with the real session, by nature: the microphone, the tray, global shortcuts, the desktop keyring
  (read to decrypt keys; the temporary profile stores its own keys in its own folder) and, if you use them, the
  sign-ins of external agent CLIs.

### 5.5 Windows

Run only after the Ubuntu acceptance. The installer from the CI run is unsigned and untested on a real desktop:
install, start, run one command, stop one command, and one agent task with a `.cmd`-installed CLI.

## 6. Comparison with the laptop's uncommitted work — BLOCKED

Reported state: `/home/roy/MemoBrOS` on `claude/festive-wozniak-5h9t6d` at `cca4579` with about 20 modified or
untracked files; `/home/roy/MemoBrOS-Codex` at `2c66244`, clean. None of those files exist in the cloud, so they were
not compared, reconstructed or guessed at. `cca4579` is older than `2c66244` on the same branch.

To unblock, on the laptop (nothing here deletes or overwrites anything):

```bash
cd /home/roy/MemoBrOS
git status --short > ~/memobros-local-status.txt          # look at it first
git switch -c local/roy-wip-2026-11                        # a new branch at cca4579; the changes come along
git add -A -- . ':!*.env' ':!.env*'                        # check `git status` for secrets, recordings, models
git commit -m "Local work in progress (laptop)"
git push -u origin local/roy-wip-2026-11
```

Or, without committing: `git diff cca4579 > ~/local.patch` plus a list of untracked files.

Integration plan once that branch exists:

1. In the cloud: diff `local/roy-wip-2026-11` against `cca4579` to see exactly what the local work is.
2. Classify each change: already present in v0.6/v0.6.1, new and compatible, or conflicting.
3. Merge it onto a fresh branch from this one (a merge, not a rebase; no force-push), resolve conflicts file by file,
   keep both sides' intent, run `npm test`.
4. Open a separate pull request for that merge. Nothing is merged into `main` without approval; the laptop's
   working folder and its backup stay untouched until the result is confirmed there.

## 7. Next milestone

1. Get the three missing kinds of evidence: the laptop run of section 5, one authenticated agent run with a Stop in
   the middle, and the Windows workflow.
2. Integrate the laptop's local work (section 6).
3. Decide on an operating-system sandbox for approved commands on Linux (bubblewrap), which is the largest remaining
   gap between "the command line looks safe" and "the command cannot leave its folder".
