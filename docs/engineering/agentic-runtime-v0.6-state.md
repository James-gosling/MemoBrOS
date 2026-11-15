# Agentic runtime v0.6: task state

Checkpoint for whoever continues. Sections 1-19 of the master prompt were never received; only Section 0
(priorities P0-P4) was, and the work follows that.

- **Branch:** `claude/festive-wozniak-5h9t6d` (PR #1). Built in a cloud Linux container, not on the target laptop.
- **Priorities:** P0 local action executor · P1 coding-agent adapters · P2 MCP · P3 remote worker · P4 Windows.

## Verified interfaces (read from the real CLIs' `--help`, installed from npm in a scratch folder)

| Agent | Version checked | Non-interactive interface |
|---|---|---|
| Claude Code | 2.1.325 | `claude -p <prompt> --output-format json --permission-mode <mode> --allowedTools … --mcp-config <file> --strict-mcp-config` |
| Codex | 0.169.0 | `codex exec -s read-only\|workspace-write\|danger-full-access -C <dir> --skip-git-repo-check -o <file> <prompt>` |
| Kiro CLI | (user-confirmed from Kiro docs) | `kiro-cli acp` (Agent Client Protocol over stdio) |
| Jules | 0.1.42 | cloud: `jules new --repo <owner/repo> "<task>"`, `jules remote list --session`, `jules remote pull --session <id> [--apply]` |
| Antigravity `agy` | not available | **unknown**: no documented interface could be checked; adapter takes a user-supplied command only |

None of these could be run authenticated here, so real task execution through them is untested; adapters are
exercised against stand-in executables that enforce the same flags.

## Status

See the end of this file.

### Milestone 1 (done, committed): P0 local action executor

- `src/main/actions/policy.js`: deny / ask / allow. Hard denials (administrator rights, disk and boot tools,
  deleting system or home folders, download-and-run pipes, user accounts), folder confinement, narrow
  "always allow" rules (`git status`, never for interpreters, deletes, network tools or risky Git).
- `src/main/actions/executor.js`: real execution with exit code, stdout/stderr, timeout, output cap, credential-free
  environment, cancellation of the whole process tree (POSIX process groups, `taskkill /T` on Windows).
- `src/main/actions/index.js`: permission (`commands`, off by default) → policy → approval card → run → audit
  trail (`actions.log` in the user data folder). Model tool `run_command` for chat requests, routines and crew
  researchers.
- Tests: `test/actions.test.js` 8/8; `test/e2e-free.js` "local actions" check (real commands through the app).

### Milestone 2 (done, committed): P1 coding-agent adapters, P2 MCP hand-over

- `src/main/agents/index.js`: registry and adapters. Kiro (ACP), Claude Code (`claude -p … --output-format json
  --permission-mode acceptEdits`), Codex (`codex exec -s workspace-write -C <dir> --skip-git-repo-check -o <file>`),
  Jules (cloud, `jules new --repo`), Antigravity (user-supplied command with `{prompt}`; nothing assumed).
- Crew coders use the agent chosen in Settings → Coding agent. One-shot CLI agents cannot ask before acting, so they
  run only inside an isolated Git worktree (merge still needs approval); in a folder without Git they are refused.
- Jules is offered to the model only when a repository is set, and each hand-off shows an approval card.
- MCP (P2): no second registry. The servers already configured in MemoBrOS are handed to Kiro (ACP session) and to
  Claude Code (`--mcp-config`, a private temporary file). Codex is not given them (its config format was not verified).
- Tests: `test/agents.test.js` 6/6 against stand-ins that reject any flag the real tool does not have;
  `test/e2e-free.js` "coding agents" check through the app.
- Not verified: a real authenticated run of Claude Code, Codex, Kiro, Jules or agy.

### Milestone 3 (done, committed): P3 remote worker prototype, P4 Windows groundwork, documentation

- `src/main/remote/`: `protocol.js` (HMAC-signed, timestamped, single-use requests), `worker.js` (standalone Node
  worker applying the same command policy with its own folder and allow list), `client.js`. `run_command` accepts a
  `worker` name; approval happens on the control plane; the worker refuses never-run commands regardless.
- Settings → Remote workers (add, test, remove); worker secrets are stored with the other secrets.
- Windows: executor and policy have Windows branches (untested); `.github/workflows/cross-platform-tests.yml`
  runs the platform-independent suites on Windows and Linux and builds the installer, **manual trigger only, never
  run so far**; `docs/windows.md` lists what is written and what is missing.
- User documentation: `docs/agentic-runtime.md`. Version 0.6.0.

### Test results at this point

worktrees 8/8 · voice 7/7 · speech-models 11/11 · pointer 4/4 · actions 8/8 · agents 6/6 · remote 5/5 ·
e2e 9/9 · e2e-free 16/16 · e2e-desktop 13/13 · speech-real 4/4 when its fixtures are present.

### Still open

1. Sections 1-19 of the master prompt were never received; compare this work against them when available.
2. Real signed-in runs of Claude Code, Codex, Kiro, Jules; the agy interface is unknown.
3. Run the Cross-platform tests workflow once and fix what Windows shows.
4. Remote worker: output streaming, TLS, running coding agents on workers, a second physical machine.
5. Codex is not given MemoBrOS's MCP servers (its configuration format was not verified).

### Next executable action

On the laptop: `git pull && npm install`, allow "Run commands" in Settings → Permissions, ask "what is the state
of my project?" and check the approval card and the reported output. Then pick an installed coding agent in
Settings → Coding agent and run a small crew task in a Git project.
