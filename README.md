# MemoBrOS

**Memo** (Guillermo's nickname) + **memo** (memory, notes) + **Bros / OS**. A desktop buddy that lives next to your cursor: it sees your screen, talks to you, points and draws on top of your apps, types what you say, walks you through software and, with your approval, does the task for you.

A working prototype of the HeyClicky idea, built with Electron. It runs on free models through OpenRouter or a local OmniRoute gateway by default, so it can cost nothing to use; Claude is an optional paid provider. Configured and packaged for **Windows and Linux**.

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
- **One-click connectors.** Settings → Custom tools has presets for **Notion** (sign in through your browser), **GitHub** (paste a personal access token), **Google Workspace** (Gmail, Drive, Docs, Sheets, Slides, Calendar, Forms, Tasks, Chat through the open-source `workspace-mcp` server; needs `uv` and your own Google Cloud OAuth client), **Figma** (remote, or the desktop app's local server), **Claude Code** (`claude mcp serve`) and **ChatGPT via Codex** (`codex mcp-server`). Remote servers that require OAuth open their sign-in page in your browser and stay signed in afterwards.
- **Your Google account as the key to web apps.** Under Routines → Connected accounts, sign in to Google once in Memo's private background browser. Background tasks and routines can then use Gmail, Drive, Docs, Sheets and Calendar on the web, and "Continue with Google" signs that browser in to third-party apps such as Figma, ChatGPT, Claude and Notion. Ask by voice ("check my Gmail for invoices") and Memo does it in the background and reports back.
- **Custom MCP integration.** In Settings → Custom tools, connect a Model Context Protocol server by remote URL (with an optional token) or local command line. Its tools become available to voice requests and routines: "what did ACME buy last month?" can hit your database. Tools that change things ask first, with an "always allow" choice.

And the *Memo* in the name: say "remember that…" and it keeps the note across conversations (Memory tab).

## Run it

```bash
npm install
npm start
```

1. Pick a model provider in the panel's **Settings** tab. Keys are stored encrypted with the OS keychain where available.
   - **OpenRouter (default, free).** Create a free key at openrouter.ai/keys and paste it (or set `OPENROUTER_API_KEY`). The default model is `openrouter/free`; **Find free models** lists the current zero-price models and marks the ones that see images and call tools, which is what Memo needs.
   - **OmniRoute (free tiers, local).** Run [OmniRoute](https://github.com/diegosouzapw/OmniRoute), connect a provider in its dashboard, and paste the key from Dashboard → Endpoints. MemoBrOS talks to `http://localhost:20128/v1` with model `auto`.
   - **Anthropic Claude (paid).** Paste an Anthropic API key (or set `ANTHROPIC_API_KEY`). Default model `claude-opus-5-5`.
2. Speech recognition defaults to on-device Whisper, which downloads a model from huggingface.co on first use. To use a cloud service instead, pick "Cloud" and enter any OpenAI-compatible transcription endpoint and key.
3. You can also type instead of talking; everything works from the panel's text box.

### Windows and Linux

| | Windows 10/11 | Linux |
|---|---|---|
| Installer | `npm run dist:win` → NSIS installer in `dist/` | `npm run dist:linux` → AppImage and `.deb` in `dist/` |
| Hotkeys | `Ctrl+Alt+…` | `Ctrl+Alt+…` |
| Display server | — | X11. On Wayland sessions the app runs through XWayland, where the agent can only see and control X11 apps |
| Needs | microphone permission | a compositor (for the transparent overlay), `libxtst6`; a notification daemon for routine alerts |
| Start with the system | Settings → System (installed builds) | Settings → System (writes `~/.config/autostart/memobros.desktop`) |

Build each installer on its own platform: `npm install` fetches the speech-recognition runtime for the machine it runs on, so a Windows installer built on Linux would ship without on-device Whisper.

All hotkeys, the model, voice, language and agent caution level ("ask before every single action") are editable in Settings.

## How it works

```
src/main/main.js      windows, tray, global hotkeys, orchestration of the five abilities
src/main/brain.js     prompts and tool loops: screen Q&A with point/draw, walkthrough steps, agent, routines, dictation polish
src/main/llm.js       model providers: OpenRouter / OmniRoute (OpenAI chat format) and Anthropic, behind one call()
src/main/routines.js  scheduler, routine storage, and the guardrails around background tool use
src/main/cron.js      schedule matching (the model writes the schedule; users only see plain words)
src/main/webagent.js  hidden background browser with persistent sign-ins, page reading, form filling, file upload
src/main/mcp.js       MCP client: remote (streamable HTTP / SSE) and local (stdio) servers
src/main/screen.js    captures the display under the cursor, maps screenshot pixels ↔ desktop coordinates
src/main/input.js     synthetic mouse / keyboard / paste (nut.js)
src/main/stt.js       speech to text: on-device Whisper (transformers.js) or an OpenAI-compatible endpoint
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

Launches the real app on a virtual display against a scripted stand-in for the model APIs (both the Anthropic and the OpenAI chat formats) and checks each ability end to end. The second suite covers the free-provider path, natural-language scheduling, chat-to-routine, MCP over stdio and HTTP with approvals, and a background routine that uploads a file to a local web form only after approval. The first suite checks: the screenshot reaches the API, the cursor flies to the pointed spot, annotations are drawn, a walkthrough advances, the agent really clicks and types into another window only after approval, and dictated text is polished and typed into another app's text field. Needs `xvfb-run` (Linux).

## Prototype limits

- Not yet exercised against live OpenRouter, OmniRoute or Anthropic endpoints, or with a real microphone and Whisper model; those paths are covered only through the scripted APIs and a fake audio device. In particular the default model id `openrouter/free` and OpenRouter's PDF handling are unverified.
- Routines only run while MemoBrOS is open. A run missed by less than a day fires at the next start; older ones are skipped.
- The background browser reads pages as text and numbered controls, so heavily scripted sites may not work; the "submit" guardrail recognises standard HTML forms, not every custom button.
- Only developed and run on Linux, where the AppImage and `.deb` build and the packaged app passes the test suites. The Windows configuration and code paths are written but have not been run on Windows.
- None of the real connectors (Notion, GitHub, Google Workspace, Figma, Claude Code, Codex) has been connected from here; the OAuth sign-in flow is tested against a local stand-in server. Figma's remote server may refuse apps it has not approved. Google can refuse sign-in inside embedded browsers; the background browser presents itself as plain Chrome to avoid that, without a guarantee.
- Antigravity has no MCP server or web app to connect to; it is a desktop IDE, so Memo reaches it only through on-screen agent mode.
- Hotkeys toggle listening rather than push-to-talk, and dictation types phrase by phrase at each pause rather than word by word.
- One display at a time (the one your cursor is on). Installers are unsigned.

## Credits

Inspired by [Clicky](https://github.com/farzaa/clicky) by Farza (MIT), whose open-source macOS app was the reference for the overall idea. MemoBrOS is an independent implementation and shares no code with it.
