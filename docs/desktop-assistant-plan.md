# MemoBrOS as a resident desktop assistant — work plan

Status: **not started**. This file is the hand-off for the next working session. Start at "Phase A".

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

## Open questions for the user
1. Does the tray icon appear in the GNOME top bar when MemoBrOS runs?
2. Does `npm run start:wayland` open the panel, and does `Ctrl+Alt+M` hide/show it there?
3. Is installing a small GNOME Shell extension acceptable (for always-on-top and active-window info)?
4. Should "ARVI" respond in Spanish, English, or both?
