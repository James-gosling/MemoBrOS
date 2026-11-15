# Agentic runtime: running commands, coding agents, remote workers

How MemoBrOS acts on your computer beyond pointing and answering, and what keeps that under your control.

## Running commands

Ask for something a command answers or does ("what's the state of the project?", "run the tests") and Memo runs
it and reports the real exit code and output.

- **Off until you allow it.** Settings → Permissions → "Run commands in my project folder". The first use asks.
- **You approve each command.** The card shows the exact command line, the folder, and why. For plain commands
  the card offers "Always allow" for that kind only (for example `git status`, never all of `git`).
- **Never offered "always":** interpreters and shells (`node`, `python`, `bash`), deletes and moves, network
  tools, package managers, containers, and risky Git (`push --force`, `reset --hard`, `clean`). They ask every time.
- **Never run at all**, whatever anyone approves: administrator rights (`sudo`, `runas`), shutdown, disk and boot
  tools, deleting system or home folders, download-and-run pipes, user-account changes.
- **Confined to the project folder** (Settings → Coding agent), plus folders you add.
- **No general shell for agents.** A line with pipes, redirects or `&&` is always shown for approval and marked.
- **Stop** (the button, `Ctrl+Alt+.`, or "ARVI, detente") ends the command and everything it started.
- Commands run without your API keys, tokens or passwords in their environment.
- Every decision and result is written to `actions.log` in MemoBrOS's data folder.

Routines and crew researchers use the same path, with the same rules; their approvals expire after 15 minutes.

## Coding agents

Settings → Coding agent → Agent chooses who does the coding in crew mode.

| Agent | How MemoBrOS runs it | Asks before acting? | Where it may work |
|---|---|---|---|
| Kiro CLI (default) | `kiro-cli acp`, the Agent Client Protocol | Yes, each action appears as an approval card | Any project folder |
| Claude Code | `claude -p … --output-format stream-json --verbose --permission-mode acceptEdits` | No: it may only edit files | Git projects only |
| Codex | `codex exec -s workspace-write -C <folder>` | No: sandboxed to its folder | Git projects only |
| Antigravity (`agy`) | the command you enter, with `{prompt}` | Unknown | Git projects only |
| Another ACP agent | the command you enter | Yes | Any project folder |
| Google Jules | `jules new --repo <owner/repo> "<task>"` (cloud) | Each hand-off is approved | Your GitHub repository, on Google's servers |

Agents that cannot ask first only run inside a Git project: each works in its own worktree and branch, its
changes are checked, and nothing reaches your branch until you approve the merge. In a folder without Git they
are refused. Each agent must be installed and signed in by you; Settings shows whether it was found.

Jules is off until you enter a repository. It is a cloud service: the task leaves your computer, and results are
fetched later with `jules remote pull`.

The MCP servers you connected in MemoBrOS are handed to Kiro and to Claude Code for each session. There is one
list of servers, in Settings → Custom tools.

## Remote workers (prototype)

A worker lets another machine run approved commands for you.

```bash
# on the other machine, in a checkout of this repository
node src/main/remote/worker.js --root /path/to/project            # prints its address and a secret once
# on your machine: reach it through an SSH tunnel, never directly
ssh -N -L 8377:127.0.0.1:8377 user@other-machine
```

Add it in Settings → Remote workers (name, `http://127.0.0.1:8377`, the secret) and press Test. Then ask, for
example, "run the tests on the build box".

- The worker listens on 127.0.0.1 and speaks plain HTTP; the tunnel provides the encryption.
- Every request is signed with the shared secret, is valid for one minute and can be used once. The secret
  itself is never sent, and is stored encrypted on your machine.
- The worker applies the same command rules itself, with its own folder and its own always-allow list
  (`--allow "git status,npm test"`). It refuses never-run commands whatever your machine tells it.
- Approval still happens on your machine; cancelling there stops the command on the worker.

This is a prototype: one command at a time per request, no output streaming, no TLS of its own, and coding
agents are not yet run through workers.

## What has been verified

| Part | How | Result |
|---|---|---|
| Command rules and executor | `test/actions.test.js`: real processes, cancellation of process trees, timeouts | 8/8 |
| Commands through the app | `test/e2e-free.js`: permission, approval, refusal, always-allow, shell line, Stop, audit trail | pass |
| Agent adapters | `test/agents.test.js`: stand-in executables that reject any flag the real tool lacks | 6/6 |
| Agents in crew mode | `test/e2e-free.js`: Claude Code and Codex in isolated worktrees, Jules approval | pass |
| Remote worker | `test/remote.test.js`: signatures, replay, the worker's own rules, real execution, cancel | 5/5 |

Not verified: a real, signed-in run of Claude Code, Codex, Kiro, Jules or agy; anything on Windows (see
`docs/windows.md`); a worker on a second physical machine.
