# MemoBrOS

**Memo** (Guillermo's nickname) + **memo** (memory, notes) + **Bros / OS**. A desktop buddy that lives next to your cursor: it sees your screen, talks to you, points and draws on top of your apps, types what you say, walks you through software and, with your approval, does the task for you.

A working prototype of the HeyClicky idea, built with Electron and Claude. Runs on macOS, Windows and Linux (X11).

## The five abilities

| # | Ability | How to use it |
|---|---------|---------------|
| 1 | **On-screen drawing and pointing** | Ask anything about what you see. Memo's cursor flies to the exact control and draws circles, boxes, arrows, underlines and labels over your apps. |
| 2 | **Screen-aware voice help** | Press `Ctrl/⌘+Alt+Space`, speak, press it again (or just pause). Memo captures the active screen itself and answers out loud. |
| 3 | **Agent mode** | Press `Ctrl/⌘+Alt+A`, or say "memo agent, …". Memo shows a plan, waits for your approval (button, `Ctrl/⌘+Alt+Y`, or "yes"), then drives the mouse and keyboard. `Ctrl/⌘+Alt+.` stops it at any time. |
| 4 | **System-wide dictation** | Press `Ctrl/⌘+Alt+D` in any text field and talk. Each phrase is transcribed (Whisper, 50+ languages), grammar-fixed by Claude and typed where your caret is. Press again to stop. |
| 5 | **Walkthroughs, files and Skills** | "Walk me through exporting in Figma" starts a step-by-step guide that points at each control (`Ctrl/⌘+Alt+N` or "next"). Attach PDFs, images or text files with ＋ or drag and drop. Save reusable instructions as Skills; Memo reads them when relevant, or pin one. |

And the *Memo* in the name: say "remember that…" and it keeps the note across conversations (Memory tab).

## Run it

```bash
npm install
npm start
```

1. Open the panel's **Settings** tab and paste an [Anthropic API key](https://console.anthropic.com) (or start with `ANTHROPIC_API_KEY` set). It is stored encrypted with the OS keychain where available.
2. Speech recognition defaults to on-device Whisper, which downloads a model from huggingface.co on first use. To use a cloud service instead, pick "Cloud" and enter any OpenAI-compatible transcription endpoint and key.
3. You can also type instead of talking; everything works from the panel's text box.

Permissions the OS will ask for: **microphone**, plus on macOS **Screen Recording** (to see the screen) and **Accessibility** (agent mode and dictation typing). On Linux, a compositor is needed for the transparent overlay.

All hotkeys, the model, voice, language and agent caution level ("ask before every single action") are editable in Settings.

## How it works

```
src/main/main.js      windows, tray, global hotkeys, orchestration of the five abilities
src/main/brain.js     Claude: screen Q&A with point/draw tools, walkthrough steps, agent loop, dictation polish
src/main/screen.js    captures the display under the cursor, maps screenshot pixels ↔ desktop coordinates
src/main/input.js     synthetic mouse / keyboard / paste (nut.js)
src/main/stt.js       speech to text: on-device Whisper (transformers.js) or an OpenAI-compatible endpoint
src/main/store.js     settings, encrypted keys, memory notes, skills (markdown files in the user data folder)
src/renderer/overlay  transparent click-through window: cursor buddy, annotations, captions
src/renderer/panel    chat, mic capture with voice-activity detection, text to speech, skills, memory, settings
skills/               starter skills (Figma, DaVinci Resolve, summarize attachment, explain like I'm new)
```

- Every request sends Claude a downscaled screenshot. Claude answers with short spoken text and tool calls (`point`, `draw`, `start_walkthrough`, `start_agent`, `use_skill`, `remember`) whose coordinates are mapped back onto the real display.
- Agent mode is a tool loop (`click`, `type`, `key`, `scroll`, `drag`, `wait`, `ask_user`, `done`). Nothing is touched before the plan is approved, a fresh screenshot is returned after each batch of actions, and Claude is told to stop and ask before anything destructive or outward-facing.
- Default model is `claude-opus-5-5`.

## Tests

```bash
npm test
```

Launches the real app on a virtual display against a scripted stand-in for the Claude API and checks each ability end to end: the screenshot reaches the API, the cursor flies to the pointed spot, annotations are drawn, a walkthrough advances, the agent really clicks and types into another window only after approval, and dictated text is polished and typed into another app's text field. Needs `xvfb-run` (Linux).

## Prototype limits

- Not yet exercised against the live Claude API or with a real microphone and Whisper model; those paths are covered only through the scripted API and a fake audio device.
- Only developed and run on Linux. The macOS and Windows code paths (coordinate scaling, permissions, content protection) are written but untested.
- Hotkeys toggle listening rather than push-to-talk, and dictation types phrase by phrase at each pause rather than word by word.
- One display at a time (the one your cursor is on). No installer or code signing yet.

## Credits

Inspired by [Clicky](https://github.com/farzaa/clicky) by Farza (MIT), whose open-source macOS app was the reference for the overall idea. MemoBrOS is an independent implementation and shares no code with it.
