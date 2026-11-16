# ARVI Agent Harness — architecture and v0.7 plan

Written at commit `e29edae` (v0.6.1, branch `claude/memobros-v0.6.1-cloud-hardening`, PR #2). This is a design and a
plan: no application code was changed for it. It holds no secrets. Companion file: `handoff-v0.7.md` (prompts for
other agents).

Evidence labels used throughout, as in `cloud-continuation-v0.6.1.md`: **mock**, **real process**, **real CLI, no
account**, **authenticated**, **desktop UI**, **CI** (GitHub Actions), **laptop** (reported by the owner from the
Ubuntu machine; not reproducible from the cloud).

## 0. Vocabulary

Five things that are easy to blur, and that the code must keep apart:

| Term | What it is | In the repository today |
| --- | --- | --- |
| **Model provider** | An API that turns messages into a completion. Has models, prices, limits. | `llm.js`: OpenRouter, OmniRoute, Anthropic |
| **Agent runtime** | A program with its *own* loop, tools and model choice, that MemoBrOS hands a task to. | `agents/index.js`, `acp.js`: Kiro, Claude Code, Codex, Jules, agy |
| **ARVI Agent Harness** | The ARVI-owned layer that owns the task: its state, approvals, routing, record. | Does not exist as a layer. Its parts are spread over `main.js`, `brain.js`, `crew.js`, `routines.js` |
| **Execution environment** | Where work physically runs and what it can reach. | Local folder, Git worktree, remote worker, vendor cloud (Jules) |
| **Tools and integrations** | Things a loop can call. | Built-in tools in `brain.js`, MCP (`mcp.js`), skills (`store.js`), web agent |

Consequence: "which model" is a question for a provider, or for an agent runtime that exposes a model option. It is
never a property of the harness, and MemoBrOS's own model setting does not reach inside Claude Code, Codex or Kiro.

## 1. Current architecture assessment

### 1.1 What exists

| Area | Module | State | Evidence |
| --- | --- | --- | --- |
| Model call, one provider at a time | `llm.js` | Works. Internal format is Anthropic-style, translated for OpenAI-compatible APIs. Retries 429/5xx twice on the *same* provider and model. | mock; laptop (OpenRouter free models) |
| Provider/model fallback | `llm.js` | **Only** Anthropic's server-side fallback. No fallback between providers or between free models. | — |
| MemoBrOS's own agent loop | `brain.js` `turn()` | Works. Fixed round limit (5; more for routines), tool handlers passed in. | mock; laptop for ask/voice |
| Conversation context | `brain.js` `history` | In memory only, last 12 text messages, lost on restart. No compaction, no token accounting. | — |
| Durable memory | `store.js` `memory.json` | A flat list of notes, all injected into the system prompt. No scoping, no retrieval, no size limit. | mock |
| Skills | `store.js`, `skills/*.md` | Markdown prompts; one can be pinned, or picked with `use_skill`. | mock |
| MCP registry | `mcp.js`, `settings.mcpServers` | One registry. stdio, HTTP, SSE, OAuth. Shared with Kiro (ACP), Claude Code (file), Codex (`-c` overrides). | mock; real CLI, no account (Codex parsing) |
| Command policy and executor | `actions/` | deny / ask / allow, word-level checks, path checks, process-tree cancel, audit log, live output. | real process; CI (Linux, Windows); laptop (approval, refusal) |
| Agent adapters | `agents/index.js` | Registry `AGENTS` with `kind` (acp, cli, cloud), detection by `--version`, per-agent environment filter, progress parsing. | mock; real CLI, no account (flags) |
| ACP client | `acp.js` | initialize, session/new, session/prompt, updates, permission requests, cancel. | mock (a scripted ACP agent) |
| Orchestration ("crew") | `crew.js`, `brain.planCrew` | One orchestrator, 2–4 subagents, two phases, coders and researchers. | mock |
| Worktree isolation | `worktrees.js` | One worktree and branch per coder, lock per folder, conflict test-merge, fast-forward only after approval, no destructive Git. | real process; CI |
| Remote worker | `remote/` | Loopback only, HMAC-signed, replay-protected, own policy, NDJSON streaming, cancel. Prototype. | real process (loopback) |
| Scheduling | `routines.js`, `cron.js` | Persistent routines (`routines.json`), guardrails, approvals with timeout. | mock |
| Approvals | `main.js` `confirm()` | A queue of cards; true / false / "always"; timeout; notification. | desktop UI; laptop |
| Desktop and voice | `main.js`, `speech/`, `wake.js`, `pointer.js` | Tray, floating panel, wake word, dictation, pointer. | desktop UI; laptop (app starts, microphone works; accuracy of Tiny/Base still weak) |
| Kiro Crew gateway | `gateway.js` | Start/stop of an external gateway. Not an ACP agent; the ACP command for it stays empty. | mock |

### 1.2 What is incomplete

1. **No task as a first-class object.** A request is an `AbortController` in `main.js` (`task`) plus whatever the
   called function keeps in local variables. Nothing is written down until it ends. After a crash or a restart,
   nothing knows that a crew was half-way, which worktrees are in use, or that an approval was pending.
2. **One running request at a time**, plus one routine. This is a safe default, not a design; there is no queue.
3. **Four separate loops** with the same shape: `ask`, `runAgent`, `runRoutine`, crew workers. Each wires tools,
   approvals and cancellation by hand. A fifth would copy them again.
4. **Routing is a setting, not a decision.** The coding agent is whatever `settings.codeAgent.agent` says. Nothing
   asks "which installed agent can do this, is it signed in, does it need a Git project".
5. **No fallback.** A rate-limited free model fails the request (after two retries on the same model). A missing
   or signed-out agent fails the crew.
6. **Authentication of agents is not checked.** `detect()` proves a program exists and prints a version. Whether
   it is signed in is discovered when a task fails.
7. **Context is not engineered.** Memory is injected whole. History is a fixed slice. Agent briefs are built from
   strings in `crew.js`. No budget, no summary of earlier work, no record of what was sent to which agent.
8. **Observability is one file.** `actions.log` records commands. Model calls, agent runs, approvals, hand-offs
   and failures are only visible in the panel while they happen.
9. **No sandbox.** The policy judges the command line; an approved program can read whatever the user can.
10. **The remote worker is not an execution environment for agents**, only for single commands.

### 1.3 What is only simulated

- Every agent run. Claude Code, Codex, Kiro, Jules and agy have **never** executed a real task through MemoBrOS.
  Flags were checked against real `--help` output (Claude Code 2.1.325, Codex 0.169.0, Jules 0.1.42); the event
  shapes used for progress lines, the exit behaviour on cancel and the ACP conversation with a real Kiro are
  stand-ins.
- Antigravity (agy): nothing about its non-interactive interface was verified. It runs only with a command line
  the user types.
- Model behaviour in all automated tests (scripted server).
- Windows desktop behaviour (CI runs unit suites on a headless server only).
- The GNOME pointer extension (never loaded into a real GNOME Shell by these tests).

### 1.4 State of the branches (facts, not assumptions)

- PR #1 (`claude/festive-wozniak-5h9t6d` → `main`) and PR #2 (this branch → PR #1's branch) are open and unmerged.
- A local test fix exists only on the owner's laptop: branch `fix/deterministic-no-microphone`, commit `c345128`.
  It is not on GitHub. Its content is unknown here; it must not be re-invented.
- The laptop's original working tree has independent uncommitted work. Unknown here; never assumed.

## 2. The ARVI Agent Harness

### 2.1 Principles

1. **The harness owns the task, not the thinking.** It records, routes, approves, limits, cancels and resumes.
   The reasoning happens in a loop: MemoBrOS's own (`brain.turn`) or an agent runtime's.
2. **It coordinates other harnesses; it does not replace them.** Claude Code, Codex and Kiro each have their own
   loop, tools, context handling and permission system. ARVI treats each as a *runner* behind one contract and
   only controls what crosses the boundary: the brief going in, the folder and environment it runs in, the
   approvals it asks for (where the runtime can ask), the events coming out, the result, and the stop signal.
3. **Capabilities are declared and probed, never assumed.** A runner says what it can do; a probe says whether it
   can do it now on this machine.
4. **Modules in one process.** Plain CommonJS modules with no Electron dependency where possible (the pattern of
   `actions/policy.js` and `autostart.js`), so each is testable with plain Node. No microservices, no database
   server, no message broker. Persistence is append-only files in the profile folder.
5. **Nothing existing is rewritten to fit.** Existing functions become runners behind adapters, one at a time,
   each step keeping the test suite green.

### 2.2 Modules

Proposed folder `src/main/harness/`. "Wraps" names the existing code that stays where it is.

| Module | Responsibility | Wraps / replaces |
| --- | --- | --- |
| `contract.js` | The task contract: shapes, states, allowed transitions, error kinds, validation. Pure. | new |
| `tasks.js` | Task store: create, transition, append event, list, recover after restart. Files under `<profile>/tasks/`. | replaces the `task` variable in `main.js` over time |
| `registry.js` | Agent Registry and Model Registry: descriptors, probes, cached availability. | wraps `agents.AGENTS`, `agents.detect`, `llm.listModels` |
| `router.js` | Chooses a runner (and for the native loop, a provider/model chain) from the task's needs and the registries. Pure given its inputs. | replaces `crew.codeAgent()`'s fixed choice |
| `runners/` | One adapter per kind of runner, all with the same interface (2.4). | wraps `brain.turn`, `agents.runCli`, `AcpAgent`, `agents.startCloud`, `remote/client` |
| `approvals.js` | One place that turns "this needs a decision" into a card, with the policy that says when a decision is needed. | wraps `main.confirm`, `actions/policy`, routine guardrails |
| `context.js` | Builds what a runner receives: brief, memory selection, earlier results, budget, compaction. | replaces string building in `crew.js`, `brain.systemPrompt` memory injection |
| `trace.js` | Append-only event log per task; redaction of secrets; reader for the panel and for tests. | generalises `actions.audit` |
| `supervisor.js` | Runs tasks: concurrency limits, timeouts, cancellation, retry and fallback, hand-offs, recovery at start. | replaces the hand-written sequencing in `main.js`, parts of `crew.run` |

`crew.js` keeps planning and worktree integration; it becomes a client of the supervisor (a parent task with child
tasks) instead of calling runners itself. `routines.js` keeps scheduling and becomes a client the same way.

### 2.3 The task contract

Plain objects, validated by `contract.js`. Written here as JSDoc-style types; the project has no TypeScript.

```js
/** @typedef {Object} Task
 * @property {string}  id            // "t_" + time-sortable id; also the folder name
 * @property {string?} parent        // parent task id (crew → subagent, hand-off)
 * @property {'ask'|'agent'|'coding'|'research'|'routine'|'command'|'crew'} kind
 * @property {{type:'user'|'voice'|'routine'|'agent', ref?:string}} origin
 * @property {TaskInput}  input
 * @property {Needs}      needs      // what the work requires; the router matches this
 * @property {Grant}      grant      // what the task MAY do; never widened after creation without a new approval
 * @property {Limits}     limits
 * @property {State}      state
 * @property {Attempt[]}  attempts   // one per runner tried, in order
 * @property {TaskResult?} result
 * @property {TaskError?}  error
 * @property {string} createdAt  @property {string} updatedAt
 */

/** @typedef {Object} TaskInput
 * @property {string} goal                         // what the user asked, verbatim
 * @property {string?} brief                       // what the runner receives (built by context.js)
 * @property {{path:string, kind:'file'|'screenshot'}[]} attachments   // paths inside the profile, never inline data
 * @property {string?} cwd                         // project folder, if any
 * @property {string[]} skills                     // skill ids
 * @property {string[]} mcpServers                 // ids from the one registry
 */

/** @typedef {Object} Needs
 * @property {('edit_files'|'run_commands'|'web'|'vision'|'tools'|'mcp'|'long_running'|'remote_repo')[]} capabilities
 * @property {'none'|'worktree'|'sandbox'|'cloud'} isolation      // the minimum acceptable
 * @property {string?} runner                      // set only when the user named one ("with Codex")
 * @property {'free'|'any'} cost                   // 'free' forbids paid models and cloud agents
 */

/** @typedef {Object} Grant
 * @property {string[]} roots                      // folders the task may work in
 * @property {('screen'|'microphone'|'commands'|'control'|'network'|'cloud_handoff')[]} permissions
 * @property {string[]} allowRules                 // standing command rules in force for this task
 * @property {'ask'|'auto_within_grant'} approvals // routines and background work stay on 'ask'
 * @property {string[]} passEnv                    // names of variables a runner may see
 */

/** @typedef {Object} Limits
 * @property {number} timeoutMs  @property {number} maxRounds  @property {number} maxOutputBytes
 * @property {number} maxAttempts                  // runners or models tried before giving up
 */

/** @typedef {'queued'|'routing'|'awaiting_approval'|'running'|'validating'|'awaiting_merge'
 *          |'succeeded'|'failed'|'cancelled'|'interrupted'} State */

/** @typedef {Object} Attempt
 * @property {string} runner  @property {string?} provider  @property {string?} model
 * @property {{kind:'local'|'worktree'|'remote_worker'|'vendor_cloud', ref?:string}} environment
 * @property {string} startedAt  @property {string?} endedAt
 * @property {'ok'|'error'|'cancelled'|'timeout'|'unavailable'} outcome
 * @property {TaskError?} error
 */

/** @typedef {Object} TaskResult
 * @property {string} summary                      // what the runner reported, as text
 * @property {{branch?:string, files?:string[], commits?:string[], session?:string}} artifacts
 * @property {{ran:boolean, passed?:boolean, command?:string}} validation
 * @property {'reported'|'validated'|'merged'} confidence   // never 'validated' without a check that ran
 */

/** @typedef {Object} TaskError
 * @property {'unavailable'|'auth'|'rate_limit'|'denied_by_policy'|'declined_by_user'|'timeout'
 *           |'runner_failed'|'conflict'|'validation_failed'|'interrupted'|'invalid_task'|'internal'} kind
 * @property {string} message                      // for a person; no secrets, no raw environment
 * @property {boolean} retryable                   // may the supervisor try another runner or model?
 * @property {string?} detail                      // short excerpt of the runner's own output
 */
```

Events (appended to the trace, also sent to the panel):

```js
/** @typedef {Object} TaskEvent
 * @property {string} task  @property {number} seq  @property {string} at
 * @property {'state'|'routed'|'approval_requested'|'approval_answered'|'progress'|'output'
 *           |'tool'|'handoff'|'attempt_end'|'result'|'error'} type
 * @property {Object} data                         // shape depends on type; redacted before writing
 */
```

State machine. Any transition not listed is a bug and is rejected by `contract.js`.

```
queued ──► routing ──► awaiting_approval ──► running ──► validating ──► awaiting_merge ──► succeeded
              │               │                 │             │               │
              │               └─ declined ──────┼─────────────┼───────────────┴─► cancelled
              │                                 │             └─ failed check ──► failed
              └─ nothing can run it ────────────┼──────────────────────────────► failed
                                                ├─ retryable error, attempts left ─► routing
                                                ├─ stop pressed / app quitting ───► cancelled
                                                └─ process died with the app ─────► interrupted
```

- `validating` and `awaiting_merge` are skipped by kinds that have nothing to validate or merge.
- `interrupted` is set at start-up for every task found in a non-final state. It is never resumed silently: the
  user is told, and can retry (a new attempt on the same task) or discard. Worktrees and branches of an
  interrupted coding task are left exactly as found.
- `succeeded` with `confidence: 'reported'` is allowed and must be shown as such.

### 2.4 The runner interface

Every adapter in `runners/` exports the same shape. This is the whole coordination contract with other harnesses.

```js
/** @typedef {Object} Runner
 * @property {string} id
 * @property {() => Descriptor} describe                    // static: what it can do in principle
 * @property {(ctx:{env:Object}) => Promise<Availability>} probe   // dynamic: can it run now, here
 * @property {(task:Task, io:RunIO) => Promise<TaskResult>} run    // throws TaskError
 */
/** @typedef {Object} RunIO
 * @property {AbortSignal} signal
 * @property {(e:{type:'progress'|'output'|'tool', data:Object}) => void} emit
 * @property {(req:{title:string, detail:string, options?:Object}) => Promise<'yes'|'no'|'always'>} approve
 * @property {{cwd:string, env:Object, kind:string}} environment   // prepared by the supervisor, not by the runner
 */
```

Rules for adapters:

- A runner never chooses its own folder or environment variables. The supervisor prepares both (worktree,
  filtered environment from `agents.agentEnv`) and passes them in.
- A runner that cannot ask for approval (`describe().approvals === 'none'`) is only given tasks whose `needs.isolation`
  is `worktree` or stronger. This is today's rule for Claude Code and Codex in `crew.runCoder`, made general.
- A runner maps its failures onto `TaskError.kind`. "exited with code 1" is `runner_failed`; a sign-in message is
  `auth`; a 429 is `rate_limit`.
- `run` resolves only with what the runner actually reported. It never upgrades `confidence`.

Runners to build, in this order (each wraps existing code):

| Runner id | Wraps | Asks approval | Isolation it needs |
| --- | --- | --- | --- |
| `native` | `brain.turn` + tool handlers | Yes, per tool (existing cards) | none (its tools go through `actions/`) |
| `acp:<agent>` | `AcpAgent` | Yes, `session/request_permission` | none required; worktree when coding in parallel |
| `cli:claude`, `cli:codex`, `cli:agy` | `agents.runCli` | No | worktree |
| `cloud:jules` | `agents.startCloud` | Hand-off approved before start | vendor cloud |
| `command` | `actions.runCommand` (local or worker) | Yes, policy | none |

### 2.5 Approvals

One function decides whether a step needs a person: `approvals.required(task, step)`. Inputs: the task's grant,
the step (`command`, `edit_outside_worktree`, `cloud_handoff`, `mcp_write`, `merge`, `upload`, `permission_grant`),
and the existing policies. It returns `deny`, `ask` or `allow` with a reason, exactly like `actions/policy.decide`,
which it calls for commands.

Fixed rules, not configurable by a model or a task:

- Never-run commands stay never-run.
- Merging into the user's branch, handing work to a vendor cloud, uploading a file, granting a permission and
  widening a grant always ask.
- A task started by voice or by a routine cannot answer its own approvals; spoken approvals need the wake word
  (existing behaviour).
- An approval is for one step of one task. "Always" creates a standing rule only where `actions/policy.ruleFor`
  allows one.

### 2.6 Routing and fallback

`router.route(task, registrySnapshot)` returns an ordered list of candidates, or an error naming what is missing.

1. Filter: runners whose descriptor covers `needs.capabilities`, whose isolation can be met, and whose cost class
   fits `needs.cost`.
2. Filter by availability from the last probe: installed, signed in (where that can be known), not rate-limited.
3. If the user named a runner, it is the only candidate. No silent substitution: if it is unavailable the task
   fails with `unavailable` and says why.
4. Otherwise order by the user's preference list (a new setting, default: the currently configured agent first),
   then by declared strength for the task kind.

Fallback happens only on `TaskError.retryable` and only inside the same grant:

- **Model fallback (native runner):** an ordered chain of `provider:model` entries from the Model Registry, all in
  the same cost class. `rate_limit`, 5xx and `unavailable` move to the next entry; `auth` and 402 do not (they need
  the user). Each hop is an event. Default chain for `cost: 'free'`: the configured model, then other free models
  that support the needed capabilities (tools, vision), then OmniRoute if it answers.
- **Runner fallback:** only before any file was changed by the failed attempt, or when the failed attempt's
  worktree is abandoned as-is (kept, not deleted) and the next runner gets a fresh one. Never from a local runner to
  a cloud runner without asking: that changes where the code goes.

### 2.7 Context and memory

`context.build(task, runner)` produces the brief and records, in the trace, what was included and how large it was.

- **Budget.** Each runner descriptor declares a brief budget in characters (a conservative stand-in for tokens;
  agent runtimes do not expose their limits uniformly). The builder fills it in a fixed priority order: the goal,
  hard constraints (folders, protected files, "do not merge"), the part for this agent, results of earlier agents,
  selected memory, skills.
- **Compaction.** For the native loop: when the message list passes a threshold, older tool results are replaced
  by one summary message produced by a model call, and the original messages are kept in the task folder. For
  agent runtimes: none. They compact themselves; ARVI only controls the brief.
- **Memory.** `memory.json` stays the store. Entries gain optional `scope` (`global`, `project:<path>`,
  `agent:<id>`), `kind` (`preference`, `fact`, `procedure`) and `source` (task id). Selection for a brief is by
  scope first, then by simple keyword overlap with the goal, capped by the budget. No embeddings in v0.7.
  Existing entries without the new fields are `global`.
- **Task memory.** A finished task's `result.summary` is searchable by project, so "continue what Codex did
  yesterday" can find the branch and summary without re-reading a transcript.
- **Never in a brief:** secrets, the contents of `settings.json`, raw environment, other projects' memory.

### 2.8 Hand-offs

A hand-off is a child task, not a message between agents. Agents do not talk to each other.

```js
/** @typedef {Object} Handoff
 * @property {string} from   // task id   @property {string} to   // new child task id
 * @property {string} reason               // 'review' | 'continue' | 'specialist' | 'fallback'
 * @property {string} summary              // what was done, what is left; written by the harness from the result
 * @property {{branch?:string, worktree?:string, base?:string}} state   // where the work is
 * @property {string[]} openQuestions
 */
```

- The receiving runner gets the hand-off inside its brief plus a worktree created from the sender's branch.
- A hand-off never widens the grant. A hand-off to a cloud runner asks first.
- Crew phase 2 ("reviewer") becomes a hand-off with reason `review`.

### 2.9 Observability

- `<profile>/tasks/<id>/task.json` (current state, rewritten atomically) and `events.ndjson` (append-only).
- `trace.redact()` runs on every event: values of variables matching the executor's secret pattern, bearer
  tokens, and anything a caller marks as secret.
- The panel gets a "Tasks" view reading the same files: state, runner, attempts, approvals, result, and the
  confidence label.
- `actions.log` remains (commands), and each entry gains the task id.
- Retention: tasks older than a setting (default 30 days) are deleted by an explicit "clean up" action, not
  automatically, and never while non-final.

### 2.10 Evaluation and regression

Three layers, kept apart in reports:

1. **Contract tests** (plain Node, CI on Linux and Windows): state machine, router decisions for a table of
   registry snapshots, approval decisions, redaction, recovery from a task folder left mid-run.
2. **Conformance suite for runners**: one test file run against every runner adapter with stand-ins: completes a
   task, reports progress, fails with the right `TaskError.kind` for a crash / missing program / sign-in message,
   stops within a time bound on cancel and leaves no process behind, never sees a withheld variable.
3. **Live acceptance** (`npm run acceptance -- --runner <id>`, never in CI, never in `npm test`): the same
   scenarios against the real, signed-in program in a scratch Git repository. Prints a result table the owner can
   paste into the state document. This is the only layer that may be reported as **authenticated**.

### 2.11 Recovery and cancellation

- Cancel is one path: `supervisor.cancel(taskId)` aborts the signal; the runner stops its process tree (existing
  `killTree`) or sends `session/cancel` then closes; the supervisor waits a bounded time, records `cancelled`, and
  cancels children first.
- Quitting the app cancels every running task (existing behaviour, generalised).
- At start: every non-final task becomes `interrupted`; recorded process ids are checked and, if still alive and
  still the same program, reported to the user rather than killed.
- A cloud session (Jules) cannot be cancelled from here; the task records the session id and says so.

### 2.12 Sandbox boundary

Today's boundary is declarative (policy on the command line) plus Git isolation. The design reserves one field,
`environment.kind`, and one place, the supervisor's environment preparation, where a real sandbox attaches:

- **Linux:** run the runner's process under `bwrap` with the worktree writable, the rest of the home read-only or
  hidden, and network on or off per grant. Needs `bubblewrap` installed: a system change that needs the owner's
  approval. Without it the harness reports `isolation: worktree` honestly and does not pretend.
- **Codex** already applies its own sandbox (`-s workspace-write`); the harness records that as the runner's
  sandbox and does not wrap it twice by default.
- **Windows:** not designed here. Needs investigation (restricted token, AppContainer, or WSL).

## 3. Agent Registry and Model Registry

### 3.1 Agent descriptor (static)

```js
/** @typedef {Object} Descriptor
 * @property {string} id  @property {string} name  @property {'native'|'acp'|'cli'|'cloud'|'command'} kind
 * @property {string?} binary
 * @property {('edit_files'|'run_commands'|'web'|'vision'|'tools'|'mcp'|'long_running'|'remote_repo')[]} capabilities
 * @property {'per_action'|'none'|'before_start'} approvals
 * @property {'none'|'worktree'|'own_sandbox'|'vendor_cloud'} isolation
 * @property {'events'|'final_only'} streaming
 * @property {'process_tree'|'protocol'|'not_possible'} cancellation
 * @property {{how:'acp'|'config_file'|'config_overrides'|'none', transports:string[]}} mcp
 * @property {{selectable:boolean, how?:string, verified:boolean}} model     // see 3.3
 * @property {RegExp?} keepEnv                 // the vendor's own variables (existing `keep`)
 * @property {number} briefBudget
 * @property {{flags:'help'|'none', run:'mock'|'authenticated'}} evidence    // what has actually been checked
 */
```

`evidence` is part of the descriptor on purpose: the registry itself says which claims are verified, and the panel
can show "not yet tried with a real task" next to an agent.

### 3.2 Availability (dynamic, from `probe`)

```js
/** @typedef {Object} Availability
 * @property {boolean} installed  @property {string?} version
 * @property {'yes'|'no'|'unknown'} signedIn    // 'unknown' unless the tool has a documented, side-effect-free check
 * @property {string?} reason                    // why it cannot run now, for a person
 * @property {string} checkedAt
 */
```

Probes must be free of side effects and of cost: `--version`, and a sign-in check only where the tool documents
one. No probe may start a model call. Results are cached for a few minutes and refreshed on demand.

### 3.3 Model Registry

```js
/** @typedef {Object} ModelEntry
 * @property {string} provider                 // 'openrouter' | 'omniroute' | 'anthropic' | future ids
 * @property {string} model
 * @property {{tools:boolean, vision:boolean, files:boolean}} capabilities
 * @property {'free'|'paid'|'local'} cost
 * @property {number?} contextChars
 * @property {'listed'|'configured'} source    // from the provider's /models, or typed by the user
 * @property {{state:'ok'|'rate_limited'|'failing', until?:string}} health   // updated from real calls
 */
```

- Filled from `llm.listModels` (already returns free/vision/tools for OpenRouter) and from settings.
- `health` is updated by the native runner from actual responses; a rate-limited entry is skipped until `until`.
- A new provider is one entry in `settings.providers` plus, if it is not OpenAI-compatible, one translation
  function in `llm.js`. The registry does not care which.
- **Models inside agent runtimes are not in this registry.** Whether a runtime accepts a model choice is a
  property of its descriptor (`model.selectable`), set to true only after checking that tool's own `--help` or
  documentation, with `how` naming the option. Until then the runtime uses whatever it is configured to use, and
  ARVI does not claim to know which model that is.

## 4. Interoperability matrix

"Verified" means checked against the real program's `--help` in the cloud container (**real CLI, no account**).
"Mock" means only stand-ins exercised it. Nothing in this table is **authenticated**.

| | Claude Code | Codex CLI | Kiro CLI | Antigravity (agy) | Jules |
| --- | --- | --- | --- | --- | --- |
| Kind | cli | cli | acp | cli (user-typed command) | cloud |
| Invocation | `claude -p <task> --output-format stream-json --verbose --permission-mode acceptEdits` — verified (2.1.325) | `codex exec -s workspace-write -C <dir> --skip-git-repo-check --json -o <file> <task>` — verified (0.169.0) | `kiro-cli acp` — from the owner's reading of Kiro's docs; not run here | none known; `{prompt}` template entered by the user | `jules new --repo <owner/repo> "<task>"` — verified (0.1.42) |
| Detection | `claude --version` | `codex --version` | `kiro-cli --version` | `agy --version` (assumed to exist; unverified) | `jules --version` |
| Sign-in check | unknown: needs verification | unknown: needs verification | unknown | unknown | unknown |
| Own credentials kept | `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_*`, `CLOUD_ML_*` | `OPENAI_*`, `CODEX_*`, `AZURE_OPENAI_*` | `KIRO_*`, `AWS_*`, `AMAZON_Q_*` | `AGY_*`, `ANTIGRAVITY_*`, `GEMINI_*`, `GOOGLE_*` (a guess; harmless if wrong) | `JULES_*`, `GOOGLE_*` |
| Asks approval per action | No (headless) | No (headless) | Yes (ACP permission requests) — mock | No | Hand-off approved before start |
| Isolation | Git worktree, merge after approval | Git worktree + its own sandbox | Folder lock; worktree in parallel runs | Git worktree | Vendor cloud; code leaves the machine |
| Streaming | JSON events → progress lines; shapes are mock | JSON events → progress lines; shapes are mock | `session/update` — mock | none | none (prints once) |
| Cancellation | Process tree — mock | Process tree — mock | `session/cancel`, then close — mock | Process tree — mock | Not possible from here |
| MCP from the one registry | `--mcp-config <file>` — flag verified | `-c mcp_servers.*` overrides — parsed by the real `codex mcp list` | In `session/new`, by announced transport — mock | not passed | not passed |
| Model selection | A `--model` option is accepted by the test stand-in only; **verify with `claude --help`** before use | `-m <model>` appears in `codex exec --help` (0.169.0); which names are valid depends on the account: unverified | unknown: needs verification | unknown | unknown |
| Failure recovery | Non-zero exit → error with last lines; work stays on its branch | Same | Agent exit rejects pending requests | Same as cli | `jules remote list` / `remote pull --session <id>` to fetch later — verified flags |
| Works without Git | No | No | Yes | No | Needs a GitHub repository |

Future API providers plug into the Model Registry (3.3) and are used by the `native` runner; they are not agent
runtimes and need no row here. A future agent runtime needs: a descriptor, a probe, an adapter that passes the
conformance suite (2.10), and one live acceptance run before its `evidence.run` may say `authenticated`.

## 5. v0.7 roadmap

Order matters: each phase lists what must be true before it starts. "Primary agent" is a suggestion based on what
each tool is suited to and on what can be verified without the others; any of them can do any phase.

### Phase 0 — Critical stabilization

- **Scope.** Publish the laptop's test fix (`fix/deterministic-no-microphone`, `c345128`) as its own PR onto the
  PR #2 branch. Decide the merge order of PR #1 and PR #2. Publish the laptop's uncommitted work to a WIP branch
  after the secret check in `cloud-continuation-v0.6.1.md` section 6. Record the laptop acceptance results in a
  state document.
- **Files.** `test/e2e-desktop.js` (the fix), `docs/engineering/`.
- **Dependencies.** None. Blocks everything that touches the same files.
- **Risks.** Publishing secrets with the WIP branch; a conflict between the local fix and commit `0931577`, which
  also edits `test/e2e-desktop.js`.
- **Acceptance.** CI green on the fix PR; `git status` clean on the Codex checkout; WIP branch on GitHub with no
  secrets; both PRs still unmerged until the owner decides.
- **Tests.** Existing suite on the laptop and in CI.
- **Primary agent.** The owner, by hand. No agent should push from the original working tree.

### Phase 1 — Agent Harness foundation

- **Scope.** `harness/contract.js`, `harness/tasks.js`, `harness/trace.js`: contract, state machine, task store,
  events, redaction, recovery to `interrupted`. No behaviour change in the app yet; then route **one** existing
  flow (the `command` kind) through it.
- **Files.** New `src/main/harness/*`, `test/harness.test.js`; later a small change in `src/main/actions/index.js`
  to record a task per command.
- **Dependencies.** Phase 0 merged or at least pushed, so branches do not diverge.
- **Risks.** Over-design; a second source of truth beside `actions.log`. Mitigation: one flow first.
- **Acceptance.** Every illegal transition is rejected; a task folder left mid-run is reported `interrupted` on
  the next start; no secret appears in any written event; the existing suite is unchanged and green.
- **Tests.** Plain Node, added to `npm test` and to the CI unit job on both systems.
- **Primary agent.** Codex (self-contained, pure modules, verifiable by tests alone). Prompt: `handoff-v0.7.md` A.

### Phase 2 — Multi-agent interoperability

- **Scope.** `harness/registry.js` (descriptors with `evidence`, probes), `harness/router.js`, the runner
  interface, adapters for `cli:*` and `acp:*` around existing code, the conformance suite, and the Model Registry
  with fallback inside `llm.js`.
- **Files.** New `src/main/harness/registry.js`, `router.js`, `runners/*`; `src/main/llm.js` (fallback chain);
  `src/main/crew.js` (use the router instead of `codeAgent()`); `test/conformance.test.js`, `test/fakeAgents.js`.
- **Dependencies.** Phase 1 contract. The model-fallback part depends on nothing and can start in parallel.
- **Risks.** Silent substitution of an agent or a paid model. Mitigation: rules in 2.6; tests that a named runner
  is never replaced and that a `free` task never reaches a paid model.
- **Acceptance.** With two agents installed and the first unavailable, a coding task runs on the second and says
  so; with a named agent unavailable it fails with `unavailable`; a rate-limited free model falls to the next free
  model with one event per hop; all adapters pass the conformance suite.
- **Tests.** Router table tests; conformance suite with stand-ins; fake provider returning 429 then 200.
- **Primary agent.** Kiro for the model fallback (prompt B); Claude Code for the registry, router and adapters,
  since they touch `crew.js` and the approval flow most.

### Phase 3 — Context and memory integration

- **Scope.** `harness/context.js`: budgeted briefs, recorded composition, memory scopes and selection, task
  summaries searchable by project, compaction for the native loop.
- **Files.** New `src/main/harness/context.js`; `src/main/store.js` (memory fields, backwards compatible);
  `src/main/brain.js` (use the builder; compaction in `turn`); `src/main/crew.js` (briefs).
- **Dependencies.** Phase 1 (trace), Phase 2 (descriptor budgets).
- **Risks.** Dropping something a task needed; a summary that invents. Mitigation: originals kept on disk,
  priority order fixed, summary marked as such.
- **Acceptance.** A brief never exceeds its budget; the goal and the constraints are always present; old
  `memory.json` files load unchanged; another project's memory never appears in a brief.
- **Tests.** Pure tests on the builder; an E2E check that a second task in the same project receives the first
  task's summary.
- **Primary agent.** Claude Code.

### Phase 4 — Security hardening

- **Scope.** `harness/approvals.js` as the single decision point; grants on tasks; optional `bwrap` environment
  on Linux behind a setting; sign-in probes where documented; task id in `actions.log`.
- **Files.** New `src/main/harness/approvals.js`, `src/main/harness/sandbox.js`; `src/main/main.js` (`confirm`
  callers); `src/main/routines.js` (guardrails call the same function); `docs/agentic-runtime.md`.
- **Dependencies.** Phases 1 and 2. The sandbox needs the owner's approval to install `bubblewrap`.
- **Risks.** A regression that makes something ask less than before. Mitigation: a table test listing every
  step kind with its required decision, written **before** the refactor from today's behaviour.
- **Acceptance.** No step kind is more permissive than in v0.6.1; with the sandbox on, a command approved inside a
  worktree cannot read `~/.ssh`; with `bwrap` missing the app says so and falls back to worktree isolation.
- **Tests.** Decision table; a real-process sandbox test that skips itself when `bwrap` is absent.
- **Primary agent.** Claude Code, with a second agent (Codex) reviewing the decision table only.

### Phase 5 — Real-hardware acceptance

- **Scope.** `npm run acceptance -- --runner <id>` (2.10 layer 3); a state document recording, per runner, what
  was run on the laptop and the result; the Windows desktop pass.
- **Files.** New `scripts/acceptance.js`, `docs/engineering/acceptance-v0.7.md`.
- **Dependencies.** Phase 2 adapters. At least one agent signed in on the laptop.
- **Risks.** Quota use; real edits. Mitigation: a scratch repository created by the script, a task of a few lines,
  an explicit confirmation before each live run.
- **Acceptance.** For each installed runner: a real task completes, progress lines appear, Stop mid-run leaves no
  process (`pgrep`), a withheld variable is not visible to the agent, the result is on its own branch. Each line
  of the document carries a date and the evidence label **authenticated** or **laptop**.
- **Tests.** The script itself; it is never part of `npm test` or CI.
- **Primary agent.** The owner runs it. Claude Code or Codex writes the script.

### Phase 6 — Advanced autonomy

- **Scope.** Queue with more than one running task; hand-offs (2.8) between different runners; agents on a remote
  worker (the worker gains a "run this runner" endpoint under its own policy); longer routines.
- **Files.** `src/main/harness/supervisor.js`, `src/main/remote/*`, `src/main/crew.js`, `src/main/routines.js`.
- **Dependencies.** Phases 1–5. Not before live acceptance has shown that cancellation works on real agents.
- **Risks.** The largest in the plan: unattended agents, more places for work to be lost. Mitigation: concurrency
  limit of two writers (the existing rule), every hand-off a recorded child task, no unattended merge ever.
- **Acceptance.** Two coding tasks in two worktrees finish independently; a review hand-off from one runner to
  another produces a child task with its own trace; stopping the parent stops both.
- **Tests.** Conformance plus supervisor tests with stand-ins; live acceptance for one hand-off pair.
- **Primary agent.** To be decided after Phase 5, from what the acceptance runs show about each agent.

### Jules and agy in this plan

Jules suits work that is fully described by the repository on GitHub and verified by CI: for example Windows
stand-ins for `test/agents.test.js` so that suite can run in the Windows CI job. agy is not assigned a phase until
its non-interactive interface is verified (`handoff-v0.7.md` C).

## 6. Security and validation checklist

For every change in v0.7. A reviewer (human or agent) answers each line with yes, no, or not applicable.

Security:

- [ ] No never-run command became runnable; `test/actions.test.js` unchanged or stricter.
- [ ] No step that asked in v0.6.1 runs without asking.
- [ ] No runner receives credentials other than its own and those listed by the user.
- [ ] No secret in a brief, an event, a log line, a commit, a test fixture or a document.
- [ ] No new listener on a non-loopback address; the worker still refuses to start on one.
- [ ] No write outside the task's roots or its worktree; no destructive Git command anywhere.
- [ ] No merge into the user's branch without an approval card; no force-push.
- [ ] No hand-off to a vendor cloud without an approval naming the repository.
- [ ] A temporary profile still cannot touch the real autostart entry.
- [ ] No security check was disabled, skipped or loosened to make a test pass.

Validation:

- [ ] `npm test` green in the cloud container; the numbers are quoted in the PR.
- [ ] CI green on Linux and Windows unit jobs, the Linux Electron job and the installer build.
- [ ] Each claim in the PR carries an evidence label; nothing is called verified on hardware it did not run on.
- [ ] New agent or model behaviour has a stand-in test **and** an entry in the "needs live acceptance" list.
- [ ] A failing test was diagnosed before it was changed; the cause is in the commit message.
- [ ] The state document is updated: what exists, what is simulated, what the owner must run.

## 7. Assumptions, open questions, required local verification

Assumptions made in this document:

1. v0.7 starts from PR #2's head. If PR #1 and PR #2 are merged differently, branch names in the hand-off prompts
   change; the designs do not.
2. The laptop results quoted by the owner (66/66 unit, 9/9, 17/17, 11/11 desktop after a local fix, app starts on
   GNOME Wayland, microphone works) are taken as reported. 11 desktop checks rather than 14 is consistent with the
   Wayland part skipping itself when `weston` is not installed; this was not confirmed.
3. Plain files are enough for task state at this scale (one user, tens of tasks a day).
4. One user, one machine in control. Multi-user and multi-device control planes are out of scope.

Open questions for the owner:

1. Merge order and timing of PR #1 and PR #2, and whether v0.7 work may start on a branch stacked on PR #2 before
   they merge.
2. May `bubblewrap` be installed on the laptop for the sandbox option (Phase 4)?
3. Preference order of agents when several can do a task, and whether paid models may ever be used as a fallback.
4. Which agents are actually installed and signed in on the laptop today.
5. Should finished tasks be kept 30 days, longer, or until removed by hand?

Needs verification before it may be relied on (each is a small, separate check):

| Item | How to verify | Where |
| --- | --- | --- |
| Content of `c345128` and of the uncommitted local work | Push the branches | laptop |
| A real Kiro ACP session: `initialize` answer, permission requests, `session/cancel` | Run one small task through MemoBrOS | laptop, Kiro signed in |
| Claude Code and Codex event shapes during a real run; exit behaviour on cancel | Live acceptance run with Stop mid-way | laptop, signed in |
| A side-effect-free sign-in check for each CLI | Read each tool's `--help` and documentation | anywhere |
| Whether Claude Code accepts a model option, and its name | `claude --help` | anywhere |
| Which model names Codex accepts with `-m` on the owner's account | `codex exec -m <name>` on a trivial task | laptop |
| Whether Kiro, agy and Jules expose model selection at all | Their `--help` and documentation | anywhere |
| agy's non-interactive interface | `agy --help` | laptop |
| Passing MCP servers to agy and Jules | Documentation | anywhere |
| Speech accuracy of Tiny/Base versus Small on the laptop's microphone | Same sentences, three models, both languages | laptop |
| The GNOME pointer extension in a real GNOME Shell 50 session | Install after approval, log out and in | laptop |
| Windows desktop behaviour of the installer | Install on the Windows partition | Windows |
