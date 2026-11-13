# MemoBrOS as a resident desktop assistant — work plan

Status: **groundwork only**. Three modules are written and unit-checked but **not yet wired into the app**:
`src/main/platform.js` (display backend and capabilities, native Wayland preferred), `src/main/wake.js`
(local "ARVI" matching, Spanish/English commands), `src/main/apps.js` (open installed apps by name).
Next session: start at "Next steps" at the end of this file.

Reference for look and behaviour: HeyClicky (https://www.youtube.com/watch?v=M7EZoppNP8Q): a compact floating
chat bar (mic button, "+", text field, speaker toggle, send) that sits over other apps, expands into the
conversation, and a cursor that points at controls in other applications.

## Target machine (verified by the user)

- Ubuntu 26.04.1 LTS, GNOME Shell 50.1, `XDG_SESSION_TYPE=wayland`, AMD Ryzen 5 5600H, 16 GB.
- `npm start` (`electron . --ozone-platform=x11`) opens the panel through XWayland. Native Wayland
  (`npm run start:wayland`) has not been tried yet.
- Project at `~/MemoBrOS`, `memobros@0.4.0`, branch `claude/festive-wozniak-5h9t6d`, PR #1.

## Goal

MemoBrOS should feel like a native assistant that lives in the background, not an Electron window tied to a
terminal. Keep everything that exists (Kiro CLI over ACP, crew, routines, memory, skills, connectors).

## Requirements

### 1. Installed app, background process
- Launch from the GNOME applications menu; no terminal needed. Not solved with `nohup`, `&` or an open terminal.
- Keeps running when the window is closed or hidden. Distinguish three things: close window, quit completely, stop the assistant.
- Global, configurable shortcut to show/hide the interface.
- Visible status indicator, and a clear way to quit completely.
- Evaluate a `systemd --user` service or other autostart; **do not enable it without the user's authorization**.
- Installable Ubuntu package, `.deb` or AppImage, whichever is verified to work.

### 2. Global interaction with the desktop
- With authorization: active-window information, screen context from authorized captures, pointing at on-screen
  elements, clicks and keyboard input in other applications (browser, code editor, others).
- Any automated action can be stopped immediately.
- Wayland: use official mechanisms (XDG Desktop Portals: ScreenCast/Screenshot, RemoteDesktop, GlobalShortcuts;
  PipeWire). Do not assume `xdotool` / X11 APIs can control Wayland apps. Do not switch the user's session to X11.
  Do not bypass compositor security.
- Where something needs a permission, user action, or is unavailable: document the exact limit and propose an alternative.

### 3. Wake word "ARVI"
- Default wake word ARVI, changeable later. Examples: "ARVI, abre Visual Studio Code", "ARVI, muéstrame MemoBrOS",
  "ARVI, analiza mi pantalla", "ARVI, oculta la ventana", "ARVI, revisa el estado del proyecto".
- Wake-word detection runs locally where feasible; command processing happens after activation.
- Visible microphone state; a control to enable/disable listening; explicit microphone permission.
- Never stream audio continuously to external services. No sensitive action from a voice command without confirmation.
- Research Linux-compatible libraries; moderate CPU and RAM.

### 4. Floating interface like HeyClicky
- Show/hide by global shortcut; compact and expandable; floating; sensible screen position; preferences persist;
  discreet, smooth animations.
- Keeps Chat, Routines, Skills, Memory, Settings and the current tools. A visible button that really quits the process.
- Keep MemoBrOS's visual identity.

### 5. Architecture and security
- Separate: (1) Electron main process, (2) windows and shortcuts, (3) wake-word service, (4) visual context and
  screen permissions, (5) authorized desktop control, (6) UI, (7) agent orchestration.
- Granular permissions, confirmations for sensitive actions, cancellation everywhere.
- The app must show clearly when it is listening, capturing the screen, or controlling other applications.

### 6. Method
Audit before changing files (package.json, main process, how the mouse is implemented today, the real graphics
session, GNOME/Wayland compatibility, the technical documentation, what already exists so nothing is duplicated).
Then phases:
- **A** installable app and background execution
- **B** floating window and global shortcuts
- **C** authorized desktop interaction
- **D** wake word "ARVI"
- **E** tests, optimization, documentation, packaging

First deliverable: A and B working. Then the rest according to what is verified to work.
**Do not declare anything complete without real tests.**

### 7. Acceptance
Open from the applications menu · close the window without ending the assistant · bring it back with a global
shortcut · a clear way to quit completely · interacts with external apps using proper permissions · "ARVI"
activation verifiably works · no screen capture or audio sent without authorization · original functions kept ·
stable on Ubuntu 26.04.1 LTS.

### 8. Deliverables
Code · installable package where possible · install instructions · permissions manual · list of Wayland limits ·
test results · documentation of the new functions · recommendations for later versions.

## Audit so far (what exists, what is missing)

| Area | Already in the code | Missing / wrong for this goal |
|---|---|---|
| Background | Closing the panel hides it (`main.js` `panel.on('close')`); tray icon with Quit; single-instance lock | Tray may not show on GNOME without the AppIndicator extension; no in-window Quit button; "stop the assistant" state does not exist |
| Launch | `npm run dist:linux` builds AppImage and `.deb` (built and smoke-tested in CI-like container, never installed on real Ubuntu); `.desktop` entry via electron-builder; Settings → "Start with the system" writes `~/.config/autostart/memobros.desktop` | Not verified from the GNOME menu; packaged app on a Wayland session relaunches itself with `--ozone-platform=x11` (untested on real hardware); no systemd user unit |
| Shortcuts | Electron `globalShortcut` for ask/agent/dictate/next/panel/approve/stop, editable in Settings | Under XWayland they fire only while an X11 window has focus; native Wayland needs the GlobalShortcuts portal (`--enable-features=GlobalShortcutsPortal`), untested |
| Window | Normal framed 400×620 window with a File/Edit menu bar | Needs frameless floating bar, compact/expanded states, remembered position, animations, no menu bar |
| Screen | `desktopCapturer` in `screen.js` | Under XWayland, native Wayland windows likely come out black; needs the portal/PipeWire path and a visible "capturing" indicator |
| Mouse/keyboard | nut.js (`input.js`), which is X11 XTest | Cannot control Wayland apps. Needs the RemoteDesktop portal (libei) or documented fallback |
| Active window | none | GNOME gives no portal for this; options to evaluate: a small GNOME Shell extension, or AT-SPI |
| Voice | Hotkey-toggled listening, on-device Whisper via transformers.js, VAD in `panel.js` | No always-on wake word. Candidates to evaluate: openWakeWord (ONNX, can train a custom "ARVI"), Vosk keyword grammar, Porcupine (needs an access key) |
| Indicators | Overlay badge and panel status for listening/thinking/acting | No persistent indicator for "capturing screen"; no per-capability permission switches |

## Answers from the user (settled)
1. Tray icon unverified → implement tray plus a fallback that always allows show, hide and full quit.
2. Native Wayland is the preferred target; use the GlobalShortcuts portal; on failure give clear diagnostics and
   a configurable alternative. Do not rely only on X11/XWayland.
3. A small GNOME Shell extension is acceptable if truly needed: GNOME 50.1 compatible, minimal and auditable,
   standard APIs, no security bypass, **ask before installing or enabling**, optional, documented, and MemoBrOS
   must stay usable without it.
4. ARVI in Spanish and English with automatic detection; default `es-MX`, `en-US` fully supported; reply in the
   spoken language; configurable language preferences; local recognition; visible mic indicators; manual mic
   off; no continuous cloud audio; confirmation before sensitive desktop actions.
Do not mark hardware-dependent features verified until tested on the user's GNOME/Wayland session.

## Next steps (in order)
**A. Background app**
- `main.js`: replace the display block with `platform.setup()`; skip the overlay and synthetic input when
  `caps.overlay` / `caps.control` are false (native Wayland), with clear messages instead of silent failure.
- Control through a second launch: `memobros --toggle | --show | --hide | --quit | --pause | --resume`
  (single-instance `second-instance` handler). This is the fallback for tray and shortcuts: the user can bind
  `memobros --toggle` in GNOME Settings → Keyboard → Custom Shortcuts.
- "Pause assistant" state (stop tasks, mic, routines, action hotkeys) distinct from hide and quit.
- In-window Quit button; tray menu with Show/Hide, Pause, Mic, Quit.
- `scripts/install-desktop.js` (`npm run install:desktop`): writes `~/.local/share/applications/memobros.desktop`
  with those actions and the icon, for running from the applications menu without a terminal. Optional
  `--systemd` writes a user unit but never enables it.
- Verify the `.deb` desktop entry and actions.

**B. Floating interface**
- Frameless always-on-top panel, no menu bar, custom header (drag, compact/expand, hide, pause, quit).
- Compact bar like HeyClicky: mic, +, text field, speaker toggle, send; expands to the full tabs.
- Remember position and mode; discreet CSS transitions.
- Settings → Shortcuts: show how each shortcut was registered (X11 / portal / failed) and the fallback command.

**D. ARVI** (after A and B)
- Panel: continuous VAD segments in "wake" mode → local Whisper → `wake.match` → `wake.interpret`.
- Spoken approvals only count when prefixed with the wake word. Ignore segments while Memo is speaking.
- Off by default; explicit opt-in; mic indicator; voice chosen per reply language (`wake.languageOf`).

**Permissions** (with A): per-capability switches (screen, control, microphone, wake word), off until the user
allows each one the first time it is needed; indicators for listening, capturing and controlling.

**C. Desktop interaction on Wayland** (needs on-device testing): one persistent portal screen-share stream
instead of a prompt per capture; RemoteDesktop portal or the optional GNOME extension for input and
always-on-top; active-window info via the extension.

## Open questions for the user
1. Does the tray icon appear in the GNOME top bar when MemoBrOS runs?
2. Does `npm run start:wayland` open the panel, and does `Ctrl+Alt+M` hide/show it there?
3. Is installing a small GNOME Shell extension acceptable (for always-on-top and active-window info)?
4. Should "ARVI" respond in Spanish, English, or both?
