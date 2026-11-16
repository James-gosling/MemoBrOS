# v0.7 hand-off prompts

Standalone prompts for continuing ARVI / MemoBrOS without the session that wrote them. Each can be pasted as-is.
Design reference: `docs/engineering/arvi-agent-harness-v0.7.md`. No secrets here.

The two coding prompts (A, B) touch different files and can run at the same time, each in its own Git worktree
and branch. Neither needs the other's result.

## Rules common to every agent (repeat them in any new prompt)

```
Repository: James-gosling/MemoBrOS. Electron 45, plain CommonJS, no TypeScript, no build step.
Start from the branch claude/memobros-v0.6.1-cloud-hardening (PR #2). Create your own branch from it.

Hard rules:
- Do not merge any pull request. Do not push to main, to claude/festive-wozniak-5h9t6d, or to
  claude/memobros-v0.6.1-cloud-hardening. Do not force-push. Do not rewrite history.
- Work in your own Git worktree and branch. Never work in /home/roy/MemoBrOS (it holds uncommitted work
  that is not yours) and never use destructive Git commands (reset --hard, clean, checkout --, branch -D).
- Do not read, print, copy or commit secrets: no .env files, no settings.json from a real profile, no tokens.
- Do not weaken, skip or delete a security check or a test to get a green run. If a test fails, find the
  cause first and say what it was.
- Do not invent command-line flags, protocols or model names for other tools. If something about another
  tool is not verified by its own --help or documentation, write "needs verification" instead of code.
- Do not add dependencies unless the task says so. Do not run `npm audit fix --force`.
- Do not install system packages, GNOME extensions or services, and do not change autostart.
- Say which evidence each claim rests on: mock (stand-ins), real process, CI, or real hardware.
  Never call something verified on hardware it did not run on.

Conventions of this codebase:
- Modules that hold rules are pure and have no Electron import (see src/main/actions/policy.js,
  src/main/autostart.js). Electron-facing code calls them.
- Tests are plain Node scripts under test/ with a tiny local harness (see test/autostart.test.js):
  an array of [name, fn], PASS/FAIL lines, a "N/N passed" line, exit code 1 on failure. No test framework.
- Comments explain why, in full sentences. Messages shown to the user are plain English, no jargon.
- Tests must run on Linux and Windows: use os.tmpdir() and path.join, never hard-coded "/tmp" or "/".
- Install with `npm ci`. Run everything with `npm test` (needs xvfb-run on Linux for the Electron part);
  run one suite with `node test/<name>.test.js`.

When done: push your branch, open a pull request against claude/memobros-v0.6.1-cloud-hardening,
and report: what changed, test results with numbers, what is still unverified, and anything you were
unsure about. Do not merge it.
```

## A. Prompt for Codex — task contract, task store, trace

```
You are working on ARVI / MemoBrOS. Read docs/engineering/arvi-agent-harness-v0.7.md first: sections 2.3
(task contract), 2.9 (observability), 2.11 (recovery) and Phase 1 of section 5. Then read
src/main/actions/policy.js, src/main/autostart.js and test/autostart.test.js to see how pure modules
and their tests are written here. Follow the "Rules common to every agent" in
docs/engineering/handoff-v0.7.md exactly.

Branch: create codex/harness-foundation from claude/memobros-v0.6.1-cloud-hardening.

Build three new modules. None may import Electron. None may change existing behaviour: do not edit
any existing file under src/ in this task.

1. src/main/harness/contract.js
   - Exports STATES, FINAL_STATES, ERROR_KINDS, TRANSITIONS and these functions:
     validateTask(obj) -> { ok: true } or { ok: false, problems: [text] }
     canMove(from, to) -> boolean
     makeError(kind, message, { retryable, detail }) -> TaskError (rejects unknown kinds)
     newTask({ kind, origin, input, needs, grant, limits, parent }) -> Task in state 'queued',
       with a time-sortable id starting with "t_", createdAt and updatedAt as ISO strings,
       attempts [], result null, error null.
   - The shapes and the allowed transitions are exactly those in section 2.3 of the design document.
     If the document is ambiguous, choose the stricter reading and list the ambiguity in your report.

2. src/main/harness/trace.js
   - redact(value): returns a deep copy in which secrets are replaced by "[redacted]". A secret is:
     the value of any object key matching the SECRET pattern exported by src/main/actions/executor.js;
     any "Bearer <token>" or "Authorization: <value>" inside a string; and any string listed in an
     optional second argument `known` (array of exact secret values).
   - append(dir, event): redacts, then appends one JSON line to <dir>/events.ndjson with a `seq`
     that increases by one per task. read(dir) -> array of events; a half-written last line
     (the process died mid-write) is ignored, not an error.

3. src/main/harness/tasks.js
   - createStore(rootDir) returns { create(spec), get(id), list({ state }), move(id, to, patch),
     addAttempt(id, attempt), endAttempt(id, patch), event(id, type, data), recover() }.
   - Each task lives in <rootDir>/<id>/task.json, written atomically (write a temporary file in the
     same folder, then rename). Every move() checks canMove and throws on an illegal transition;
     every move() also appends a 'state' event.
   - recover(): every task not in a final state becomes 'interrupted' with an error of kind
     'interrupted'; returns the list of tasks it changed. It never deletes anything.
   - A corrupt or unreadable task.json must not break list() or recover(): report that task with
     state 'failed' and error kind 'internal', and leave the file as it is.

Tests: test/harness.test.js, in the style of test/autostart.test.js. Cover at least:
   - every allowed transition is accepted and every other pair is rejected (generate the pairs);
   - validateTask rejects a missing goal, an unknown kind, an unknown capability, a grant with no roots
     for a 'coding' task;
   - two tasks created in the same millisecond get different ids, and ids sort by creation time;
   - a store survives being re-opened from disk; recover() turns 'running' and 'awaiting_approval'
     into 'interrupted' and leaves 'succeeded' alone;
   - a truncated events.ndjson and a corrupt task.json are tolerated as described;
   - redact(): a nested { env: { GITHUB_TOKEN: 'x' } }, a string containing "Bearer abc.def",
     and a known secret inside a longer string are all redacted; ordinary text is untouched;
     nothing written by tasks.js to disk contains a secret passed in an event.
   Use a temporary folder per test and remove it afterwards.

Wire the new suite into `npm test` (package.json, next to test/autostart.test.js) and into the unit job
of .github/workflows/cross-platform-tests.yml (one added line). Change nothing else in the workflow.

Done means: `node test/harness.test.js` passes; `npm test` passes with every existing count unchanged;
CI is green on Linux and Windows for your pull request; no existing source file under src/ changed.
Report the numbers, and list anything in the design document you found unclear or wrong.
```

## B. Prompt for Kiro — Model Registry and fallback between models

```
You are working on ARVI / MemoBrOS. Read docs/engineering/arvi-agent-harness-v0.7.md first: section 0
(vocabulary), 2.6 (routing and fallback), 3.3 (Model Registry) and Phase 2 of section 5. Then read
src/main/llm.js completely, test/fakeLLM.js, and the provider checks in test/e2e-free.js. Follow the
"Rules common to every agent" in docs/engineering/handoff-v0.7.md exactly.

Branch: create kiro/model-fallback from claude/memobros-v0.6.1-cloud-hardening.

Today src/main/llm.js calls one provider with one model. On a 429 or 5xx answer it retries the same
model twice and then fails. Free models are often rate-limited, so requests fail when another free
model would have answered. Add a fallback chain. This is about MemoBrOS's own model calls only; it has
nothing to do with the models used inside Claude Code, Codex or Kiro, which MemoBrOS does not control.

1. New pure module src/main/harness/models.js (no Electron, no network):
   - entry shape: { provider, model, capabilities: { tools, vision, files }, cost: 'free'|'paid'|'local',
     source: 'listed'|'configured', health: { state: 'ok'|'rate_limited'|'failing', until } }.
   - chain({ primary, entries, needs: { tools, vision }, cost, now }) -> ordered list of entries to try:
     the primary first; then entries of the SAME cost class that satisfy `needs`, skipping any whose
     health says rate_limited or failing until a time later than `now`; at most 4 in total.
     When cost is 'free' the chain must never contain a paid entry, whatever else is true.
   - mark(entries, { provider, model }, outcome, now) -> new entries with health updated:
     'rate_limited' for 60 seconds after a 429, 'failing' for 5 minutes after a 5xx or a network
     error, 'ok' after a success. Pure: returns a new array.
   - classify(status, networkError) -> 'rate_limit' | 'unavailable' | 'auth' | 'payment' |
     'not_found' | 'other', and retryable(kind) -> true only for 'rate_limit' and 'unavailable'.

2. In src/main/llm.js, for the OpenAI-compatible path (openaiCall) only:
   - keep the existing same-model retry, then, on a retryable failure, move to the next entry of the
     chain and try again; stop at the first success.
   - 401, 402 and 404 keep their existing messages and do NOT fall back: they need the user.
   - Report each hop through an optional params.onFallback({ from, to, reason }) callback. Do not
     show anything in the panel yourself in this task.
   - The entries come from a small in-memory cache filled by the existing listModels() result when it
     has been called, plus the configured model. If the cache is empty, behave exactly as today.
   - Add a setting providers.<name>.fallback (boolean, default true) in src/main/store.js DEFAULTS.
     When false, behave exactly as today.
   - Do not change anthropicCall. Do not add a provider. Do not change the request or response
     translation functions.

Tests:
   - test/models.test.js (plain Node, style of test/autostart.test.js): chain order; a 'free' chain
     never contains a paid entry even when no free entry satisfies the needs (then the chain is just
     the primary); rate-limited entries are skipped until their time passes; mark() does not mutate
     its input; classify() for 429, 500, 503, 401, 402, 404 and a network error.
   - Extend test/fakeLLM.js with a way to make one named model answer 429 (or 503) N times, and add
     one check to test/e2e-free.js: the configured free model answers 429, a second free model
     answers normally, the user's question is answered, exactly one fallback hop is recorded, and
     the request log shows the paid model was never called. Add a second check: with
     fallback set to false, the same situation ends with today's rate-limit message.
   - Wire test/models.test.js into `npm test` and into the CI unit job (one added line).

Done means: both new suites pass; `npm test` passes with every existing check still passing;
CI is green on Linux and Windows for your pull request. Report the numbers, the evidence label for
each claim (everything here is "mock": no real provider was called), and anything you were unsure of.
Do not call any real model provider while developing or testing.
```

## C. Notes for Antigravity (agy)

Status in the repository: agy is listed in `src/main/agents/index.js` as a command-line agent with **no** built-in
command. MemoBrOS runs it only with a command line the user types in Settings, containing `{prompt}`. Nothing about
its interface has been verified.

Before agy can be more than that, someone with agy installed must record, from its own `--help` and documentation
(paste the relevant output into a new section of `docs/engineering/agentic-runtime-v0.6-state.md`):

1. Is there a non-interactive mode that takes a task and exits? Exact command.
2. Does it print progress as it works, and in what format?
3. How does it report its final result, and what is its exit code on failure?
4. Does it ask before editing files or running commands in that mode, and can that be controlled?
5. Does it stop cleanly on SIGTERM?
6. Can it be given MCP servers for one run without changing the user's configuration?
7. Can a model be chosen, and how?
8. Is there a way to check sign-in without starting a task?

Until each answer is written down with its source, the adapter stays as it is. A prompt for agy itself, if the
owner wants to use it as a worker on this repository, is the common rules block above plus a single, small,
test-verified task; suitable ones: backfilling tests for `src/main/cron.js` or `src/main/wake.js`, which are pure.

## D. Notes for Jules

Status in the repository: Jules is a cloud agent. MemoBrOS starts a session with `jules new --repo <owner/repo>
"<task>"` after the user approves the hand-off, and nothing runs locally. Results are fetched later with
`jules remote list --session` and `jules remote pull --session <id>` (flags checked against Jules 0.1.42's
`--help`; no authenticated run was made).

What follows from "the work happens on Google's servers":

- Jules sees the repository as it is on GitHub. It cannot see the laptop's uncommitted work, local branches that
  were not pushed, or anything in a MemoBrOS profile. Give it only tasks fully described by pushed code.
- It cannot run the Electron tests on a real desktop or anything needing a microphone; rely on the CI of its pull
  request for verification.
- A session cannot be cancelled from MemoBrOS. Treat every hand-off as final once approved.
- Whether Jules accepts MCP servers or a model choice is unverified.

A task that fits Jules well, self-contained and checked by CI:

```
Repository: James-gosling/MemoBrOS, base branch claude/memobros-v0.6.1-cloud-hardening.
Read docs/engineering/handoff-v0.7.md ("Rules common to every agent") and follow it.

test/agents.test.js only runs on Linux in CI because the stand-in agent programs written by
test/fakeAgents.js are found through a Unix PATH ("/usr/bin:/bin") and shell scripts. Make the suite
run on Windows as well, without changing src/: use path.delimiter and a PATH made of the stand-in
folder plus the folder of process.execPath, rely on the .cmd files test/fakeAgents.js already writes,
and keep the Linux behaviour identical. Then enable the suite for both systems in the unit job of
.github/workflows/cross-platform-tests.yml (remove the "if: runner.os == 'Linux'" line for that step).

Done means: the workflow is green on ubuntu-latest and windows-latest for your pull request, with
"9/9 passed" for the agents suite on both. If a test fails on Windows because of the application code
and not the test, do not change the application: describe the failure in the pull request instead.
Open the pull request against claude/memobros-v0.6.1-cloud-hardening and do not merge it.
```

## E. What the owner does between hand-offs

1. Push `fix/deterministic-no-microphone` (`c345128`) and open a pull request for it against
   `claude/memobros-v0.6.1-cloud-hardening`. It edits `test/e2e-desktop.js`, as does commit `0931577` on that
   branch, so expect to resolve a small conflict by hand.
2. Start agents only in their own worktrees:
   `git -C /home/roy/MemoBrOS-Codex worktree add ../MemoBrOS-wt-codex -b codex/harness-foundation origin/claude/memobros-v0.6.1-cloud-hardening`
   (and the same with `kiro/model-fallback`). Never start a write-enabled agent in `/home/roy/MemoBrOS`.
3. Review each pull request against the checklist in section 6 of the design document before merging anything.
4. Record what was run on the laptop, with dates, in a state document under `docs/engineering/`.
