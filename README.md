# MemoBrOS

**Memo** (Guillermo's nickname) + **memo** (memory, notes) + **Bros / OS**. A desktop buddy that lives next to your cursor: it sees your screen, talks to you, points and draws on top of your apps, types what you say, walks you through software and, with your approval, does the task for you.

A working prototype of the HeyClicky idea, built with Electron. It runs on free models through OpenRouter or a local OmniRoute gateway by default, so it can cost nothing to use; Claude is an optional paid provider. Configured and packaged for **Windows and Linux**.

## Desktop assistant

MemoBrOS lives in the background as a floating window: close or hide it and it keeps running; `Ctrl+Alt+M`
(or `memobros --toggle`) brings it back; **⏻** quits for real. It has a compact bar and a full view, a pause
switch, a local bilingual wake word ("ARVI, abre Visual Studio Code" / "ARVI, analyze my screen"), and
permissions for screen, microphone and mouse/keyboard that are off until you allow each one. Installing it,
the permissions manual, what Wayland allows and what has been tested are in
[docs/desktop-assistant.md](docs/desktop-assistant.md).

## Architecture

```
                         You
              goals and instructions (voice or text)
                          │
        ┌─────────────────▼─────────────────┐
        │              MemoBrOS             │
        │ Memory · Scheduling · Agent       │
        │ coordination · Approvals          │
        └─────────────────┬─────────────────┘
                          │  Agent Client Protocol (ACP)
                  ┌───────▼───────┐
                  │    Kiro CLI   │   code generation · analysis · tests · tool execution
                  └───────┬───────┘
          GitHub · Local files · MCP servers
```

MemoBrOS is the persistent layer: it remembers, schedules, coordinates agents and asks for your approval. Coding work is done by Kiro CLI, which MemoBrOS starts and drives over ACP. The MCP servers you connect in MemoBrOS (local commands and token-based remote ones) are handed to Kiro for each session.

### Crew mode: one orchestrator, two to four subagents

Pick **Crew** in the chat, say "memo crew, …", or schedule it as a routine ("Runs as: Coding crew").

1. The **orchestrator** (your configured model) splits the goal into parts for two to four subagents.
2. **Coder** subagents are separate Kiro CLI sessions in your project folder. **Researcher** subagents are MemoBrOS background workers with the private browser, your connected accounts and MCP tools.
3. Phase-1 agents run at the same time; phase-2 agents (review, tests) run afterwards and see the others' results.
4. Anything Kiro asks permission for shows up as an approval card in MemoBrOS. The orchestrator then merges the results into one spoken report.

Set the project folder in Settings → Coding agent. The coding agent command is `kiro-cli acp` (the `kiro-cli` executable with the argument `acp`); an absolute path such as `"/opt/kiro/bin/kiro-cli" acp` works, as does any other ACP agent command.

#### Isolation for parallel coders

Coders never write into the same directory at the same time.

- **One worktree and branch per coder.** In a Git project each coder gets its own branch `memobros/<run>/<agent>` in its own directory outside your project. A directory lock refuses a second writer on the same path.
- **Failures stay contained.** Whatever an agent leaves behind, including the partial work of one that crashed, is committed to that agent's own branch and nowhere else.
- **Independent validation.** Each branch is checked on its own (`git diff --check`, plus your check command, e.g. `npm test`, if you set one). Branches that change protected files (`.env*`, keys, lockfiles, CI workflows by default) are held back for you to review.
- **Conflicts found before integration.** Ready branches are test-merged one by one in a scratch integration worktree. A branch that conflicts is left on its own branch and reported with the files involved. Phase-2 agents start from the integrated phase-1 result.
- **You approve the merge.** The combined result is checked again, then MemoBrOS shows what would change and waits. On approval your branch is fast-forwarded, and only if it has not moved; Git itself refuses if that would touch your uncommitted changes.
- **Nothing destructive.** No `reset --hard`, no `clean`, no forced worktree removal, no branch deletion. Worktree directories are removed only when Git confirms they are clean; branches are always kept. If you decline, or the merge cannot be a fast-forward, the work waits on `memobros/<run>/integration`.
- **Fallback.** If the project is not a Git repository, has no commits, or a worktree cannot be created, coders run one at a time in the project folder instead.

#### Kiro Crew

Kiro Crew is a separate orchestration gateway that drives ACP agents itself. It is not an ACP agent, so MemoBrOS does not speak ACP to it or send it tasks. Settings → Kiro Crew gateway can start and stop it for you with its documented command, `kirocrew gateway`, and show whether it is running; it is never started automatically. MemoBrOS's crew mode drives Kiro CLI directly either way. Deeper integration needs a documented interface from Kiro Crew and is not implemented.

### Connectors

| Service | How it connects | What you still need |
|---|---|---|
| Notion | Remote server, sign-in opens in your browser | Approve MemoBrOS on Notion's page |
| GitHub | Remote server | A personal access token |
| Google Workspace | Local `workspace-mcp` server (Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms, Tasks, Chat) | `uv` installed and your own Google Cloud OAuth client ID and secret |
| Figma | Remote server, or the desktop app's local server | Figma may refuse apps it hasn't approved; the desktop preset is the fallback |
| Vercel | Remote server, sign-in opens in your browser | A Vercel account; Vercel may refuse apps it hasn't approved |
| Airtable | Remote server, sign-in opens in your browser | Approve MemoBrOS in Airtable, or paste a personal access token |
| Supabase | Remote server, sign-in opens in your browser | A Supabase account |
| Companio | Remote server (`companio-api.byafluence.com/mcp`), sign-in opens in your browser | Your Companio account |
| Claude | `claude mcp serve` | The `claude` CLI installed and signed in |
| ChatGPT | `codex mcp-server` (OpenAI's Codex agent) | The `codex` CLI installed and signed in |

All of these are one click under Settings → Connectors; any other MCP server can be added by URL or command.

## The five abilities

| # | Ability | How to use it |
|---|---------|---------------|
| 1 | **On-screen drawing and pointing** | Ask anything about what you see. Memo's cursor flies to the exact control and draws circles, boxes, arrows, underlines and labels over your apps. |
| 2 | **Screen-aware voice help** | Press `Ctrl/⌘+Alt+Space`, speak, press it again (or just pause). Memo captures the active screen itself and answers out loud. |
| 3 | **Agent mode** | Press `Ctrl/⌘+Alt+A`, or say "memo agent, …". Memo shows a plan, waits for your approval (button, `Ctrl/⌘+Alt+Y`, or "yes"), then drives the mouse and keyboard. `Ctrl/⌘+Alt+.` stops it at any time. |
| 4 | **System-wide dictation** | Press `Ctrl/⌘+Alt+D` in any text field and talk. Each phrase is transcribed (Whisper, 50+ languages), grammar-fixed by the model and typed where your caret is. Press again to stop. |
| 5 | **Walkthroughs, files and Skills** | "Walk me through exporting in Figma" starts a step-by-step guide that points at each control (`Ctrl/⌘+Alt+N` or "next"). Attach PDFs, images or text files with ＋ or drag and drop. Save reusable instructions as Skills; Memo reads them when relevant, or pin one. |

### Recurring routines

- **Natural-language scheduling.** Say or type "Every Tuesday at 5 PM, check my inbox for invoices" (or use the Routines tab). Memo turns it into a recurring background job and tells you the first run time. You never write code or cron.
- **Chat to routine.** When an agent task finishes, click **↻ Repeat this on a schedule** on its result. It becomes a daily routine in one click; change the schedule in plain words in the editor.
- **Guardrails.** Background routines never touch your mouse. They work through a private background browser that keeps the sign-ins you set up under *Connected accounts*, plus your MCP tools. Reading is free; the app itself pauses for your approval before file uploads, form submissions and any connected tool that is not marked read-only, and the model is told to ask before anything hard to undo. Unanswered approvals count as "no" after 15 minutes. Routines that need the real screen ask before taking it.

### Web uploads and custom MCP servers

- **Permissioned web uploads.** A background agent can pick a file from the folders you share (Documents, Downloads and Desktop by default; editable) and attach it to a web form. You approve each file and site once; files outside the shared folders are refused outright.
- **One-click connectors.** Settings → Connectors has presets (see the table above) for **Notion** (sign in through your browser), **GitHub** (paste a personal access token), **Google Workspace** (Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms, Tasks, Chat through the open-source `workspace-mcp` server; needs `uv` and your own Google Cloud OAuth client), **Figma** (remote, or the desktop app's local server), **Claude Code** (`claude mcp serve`) and **ChatGPT via Codex** (`codex mcp-server`). Remote servers that require OAuth open their sign-in page in your browser and stay signed in afterwards.
- **Your Google account as the key to web apps.** Under Routines → Connected accounts, sign in to Google once in Memo's private background browser. Background tasks and routines can then use Gmail, Drive, Docs, Sheets and Calendar on the web, and "Continue with Google" signs that browser in to third-party apps such as Figma, ChatGPT, Claude and Notion. Ask by voice ("check my Gmail for invoices") and Memo does it in the background and reports back.
- **Custom MCP integration.** In Settings → Custom tools, connect a Model Context Protocol server by remote URL (with an optional token) or local command line. Its tools become available to voice requests and routines: "what did ACME buy last month?" can hit your database. Tools that change things ask first, with an "always allow" choice.

And the *Memo* in the name: say "remember that…" and it keeps the note across conversations (Memory tab).

## Run it

```bash
npm install
npm start                 # or: npm run install:desktop, then open MemoBrOS from the applications menu
```

1. Pick a model provider in the panel's **Settings** tab. Keys are stored encrypted with the OS keychain where available.
   - **OpenRouter (default, free).** Create a free key at openrouter.ai/keys and paste it (or set `OPENROUTER_API_KEY`). The default model is `openrouter/free`; **Find free models** lists the current zero-price models and marks the ones that see images and call tools, which is what Memo needs.
   - **OmniRoute (free tiers, local).** Run [OmniRoute](https://github.com/diegosouzapw/OmniRoute), connect a provider in its dashboard, and paste the key from Dashboard → Endpoints. MemoBrOS talks to `http://localhost:20128/v1` with model `auto`.
   - **Anthropic Claude (paid).** Paste an Anthropic API key (or set `ANTHROPIC_API_KEY`). Default model `claude-opus-5-5`.
2. Speech recognition defaults to on-device Whisper, which downloads a model once (from the sherpa-onnx project on GitHub; pick Tiny, Base or Small in Settings → Voice). To use a cloud service instead, pick "Cloud" and enter any OpenAI-compatible transcription endpoint and key.
3. You can also type instead of talking; everything works from the panel's text box.

### Windows and Linux

| | Windows 10/11 | Linux |
|---|---|---|
| Installer | `npm run dist:win` → NSIS installer in `dist/` | `npm run dist:linux` → AppImage and `.deb` in `dist/` |
| Hotkeys | `Ctrl+Alt+…` | `Ctrl+Alt+…` |
| Display server | — | X11. On Wayland sessions the app runs through XWayland, where the agent can only see and control X11 apps |
| Needs | microphone permission | a compositor (for the transparent overlay), `libxtst6`; a notification daemon for routine alerts |
| Start with the system | Settings → System (installed builds) | Settings → System (writes `~/.config/autostart/memobros.desktop`) |

On Linux the app renders in software (no GPU needed), because the GPU process crashes under XWayland on some drivers. `MEMOBROS_GPU=1 npm start` turns acceleration back on. On a Wayland session `npm start` runs natively on Wayland; `npm run start:x11` (or Settings → System → Display mode) runs through XWayland instead, which enables the pointing overlay and agent control for X11 apps. The differences are tabulated in docs/desktop-assistant.md.

Build each installer on its own platform: `npm install` fetches the speech-recognition runtime for the machine it runs on, so a Windows installer built on Linux would ship without on-device Whisper.

All hotkeys, the model, voice, language and agent caution level ("ask before every single action") are editable in Settings.

## How it works

```
src/main/main.js      windows, tray, global hotkeys, permissions, orchestration of the abilities
src/main/platform.js  display backend (native Wayland preferred) and what it allows
src/main/wake.js      local wake word and bilingual local commands
src/main/apps.js      opening installed applications by name
src/main/brain.js     prompts and tool loops: screen Q&A with point/draw, walkthrough steps, agent, routines, dictation polish
src/main/llm.js       model providers: OpenRouter / OmniRoute (OpenAI chat format) and Anthropic, behind one call()
src/main/routines.js  scheduler, routine storage, and the guardrails around background tool use
src/main/cron.js      schedule matching (the model writes the schedule; users only see plain words)
src/main/webagent.js  hidden background browser with persistent sign-ins, page reading, form filling, file upload
src/main/acp.js       ACP client: starts and drives the coding agent (Kiro CLI) over stdio
src/main/crew.js      crew mode: orchestrator, 2–4 subagents, per-coder isolation and approval-gated integration
src/main/worktrees.js Git worktrees, directory locks, validation, conflict detection, fast-forward merge
src/main/gateway.js   optional start/stop of the Kiro Crew gateway (not ACP)
src/main/mcp.js       MCP client: remote (streamable HTTP / SSE) and local (stdio) servers
src/main/screen.js    captures the display under the cursor, maps screenshot pixels ↔ desktop coordinates
src/main/input.js     synthetic mouse / keyboard / paste (nut.js)
src/main/stt.js       speech to text entry point: on-device (speech/) or an OpenAI-compatible endpoint
src/main/speech/      on-device Whisper via sherpa-onnx: model lifecycle, language policy, speech process
src/main/pointer.js   assistant pointer on native Wayland through the optional GNOME Shell extension
src/main/store.js     settings, encrypted keys, memory notes, skills (markdown files in the user data folder)
src/renderer/overlay  transparent click-through window: cursor buddy, annotations, captions
src/renderer/panel    chat, mic capture with voice-activity detection, text to speech, skills, memory, settings
skills/               starter skills (Figma, DaVinci Resolve, summarize attachment, explain like I'm new)
```

- Every screen request sends the model a downscaled screenshot. It answers with short spoken text and tool calls (`point`, `draw`, `start_walkthrough`, `start_agent`, `use_skill`, `remember`) whose coordinates are mapped back onto the real display.
- Agent mode is a tool loop (`click`, `type`, `key`, `scroll`, `drag`, `wait`, `ask_user`, `done`). Nothing is touched before the plan is approved, a fresh screenshot is returned after each batch of actions, and Claude is told to stop and ask before anything destructive or outward-facing.
- Speech recognition runs on-device by default, so voice adds no cost either.
- Free models vary in quality and are rate-limited; pointing accuracy and agent reliability depend on the model you pick.

## Tests

```bash
npm test
```

`test/worktrees.test.js` exercises the isolation layer against real Git repositories: one writer per directory, conflict detection, fast-forward-only merging that never overwrites uncommitted work, and non-destructive cleanup. The end-to-end suites then prove through the running app that Kiro CLI is started as `kiro-cli acp`, that the Kiro Crew gateway is only started on request and never spoken ACP to, and that parallel coders, a crashing agent and conflicting branches stay contained until you approve the merge.

The suites launch the real app on a virtual display against a scripted stand-in for the model APIs (both the Anthropic and the OpenAI chat formats) and checks each ability end to end. The second suite covers the free-provider path, natural-language scheduling, chat-to-routine, MCP over stdio and HTTP with approvals, and a background routine that uploads a file to a local web form only after approval. The first suite checks: the screenshot reaches the API, the cursor flies to the pointed spot, annotations are drawn, a walkthrough advances, the agent really clicks and types into another window only after approval, and dictated text is polished and typed into another app's text field. Needs `xvfb-run` (Linux).

## Prototype limits

- Not yet exercised against live OpenRouter, OmniRoute or Anthropic endpoints, or with a real microphone and Whisper model; those paths are covered only through the scripted APIs and a fake audio device. In particular the default model id `openrouter/free` and OpenRouter's PDF handling are unverified.
- Routines only run while MemoBrOS is open. A run missed by less than a day fires at the next start; older ones are skipped.
- The background browser reads pages as text and numbered controls, so heavily scripted sites may not work; the "submit" guardrail recognises standard HTML forms, not every custom button.
- Only developed and run on Linux, where the AppImage and `.deb` build and the packaged app passes the test suites. The Windows configuration and code paths are written but have not been run on Windows.
- None of the real connectors (Notion, GitHub, Google Workspace, Figma, Claude Code, Codex) has been connected from here; the OAuth sign-in flow is tested against a local stand-in server. Figma's remote server may refuse apps it has not approved. Google can refuse sign-in inside embedded browsers; the background browser presents itself as plain Chrome to avoid that, without a guarantee.
- Kiro CLI and Kiro Crew were not installed here. `kiro-cli acp` and `kirocrew gateway` are the commands from Kiro's documentation; the ACP exchange itself is tested against a stand-in agent, not the real Kiro CLI. Vercel, Airtable, Supabase and Companio were not connected either.
- Worktrees start from your last commit, so coders do not see your uncommitted changes. MemoBrOS cannot stop an agent from writing outside its worktree by absolute path; it reports if files in your project changed during a run.
- Antigravity: no preset yet. If its `agy` CLI can serve MCP or ACP, add that command under Connectors or Coding agent.
- Hotkeys toggle listening rather than push-to-talk, and dictation types phrase by phrase at each pause rather than word by word.
- One display at a time (the one your cursor is on). Installers are unsigned.

## Credits

Inspired by [Clicky](https://github.com/farzaa/clicky) by Farza (MIT), whose open-source macOS app was the reference for the overall idea. MemoBrOS is an independent implementation and shares no code with it.
