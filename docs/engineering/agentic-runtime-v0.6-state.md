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

### Next executable action

P1: `src/main/agents/` adapters (Claude Code, Codex, Kiro ACP, Jules, AGY) and wiring into crew coders.
