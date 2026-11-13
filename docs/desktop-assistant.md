# MemoBrOS as a desktop assistant

MemoBrOS runs in the background as a small floating window you show and hide, with a wake word, per-capability
permissions and a clear way to quit. This page covers installing it, using it, what each permission does, what
Wayland allows, and what has and has not been tested.

## Install on Ubuntu

**From a package** (recommended once you have built or downloaded one):

```bash
npm install
npm run dist:linux                              # builds dist/memobros_<version>_amd64.deb and an AppImage
sudo apt install ./dist/memobros_0.5.0_amd64.deb
```

MemoBrOS then appears in the applications menu. Right-clicking its icon offers *Show / hide*, *Pause*, *Resume*
and *Quit*. Remove it with `sudo apt remove memobros`.

**From a source checkout**, without building a package:

```bash
npm install
npm run install:desktop          # adds MemoBrOS to the applications menu (no terminal needed afterwards)
npm run install:desktop -- --remove
```

Neither method makes MemoBrOS start with your session. To do that, either tick **Settings → System → Start
MemoBrOS with the system**, or run `npm run install:desktop -- --systemd`, which writes a systemd user unit and
prints the one command that enables it. Nothing is enabled until you do one of those.

## Window, background and quitting

| You do | What happens |
|---|---|
| Close the window, press **—**, or `Ctrl+Alt+M` | The window hides. The assistant keeps running. |
| Press **❙❙** (or `memobros --pause`) | The assistant is paused: it stops what it was doing, stops listening, routines do not fire, and only the show/hide shortcut stays active. The window still works. **▶** resumes. |
| Press **⏻** (or `memobros --quit`, or *Quit* in the tray/launcher menu) | MemoBrOS exits completely. |
| Press **▁** | Switches between the compact bar (mic, attach, text, speaker, send, last answer) and the full interface with Chat, Routines, Skills, Memory and Settings. Approval cards open the full interface by themselves. |

The window is frameless, stays above other windows where the desktop allows it, and remembers its position and
size. Drag it by the title strip.

**Controlling it from outside.** A second `memobros` never opens a second assistant; it tells the running one
what to do: `--toggle`, `--show`, `--hide`, `--pause`, `--resume`, `--quit`. This is the fallback when a tray
icon or a global shortcut is not available: in GNOME Settings → Keyboard → View and Customize Shortcuts → Custom
Shortcuts, add a shortcut whose command is the one shown in MemoBrOS under **Settings → Shortcuts**.

**Shortcut diagnostics.** Settings → Shortcuts says whether every shortcut registered, how (X11, or the Wayland
shortcuts portal), and lists any that failed.

## Permissions

Everything is off the first time. MemoBrOS asks when a capability is first needed, and you can change each one
in **Settings → Permissions**.

| Permission | Asked when | What it allows | What it never does |
|---|---|---|---|
| See my screen | You ask something, start a walkthrough or an agent task | One screenshot per request, sent to the model you chose | No capture in the background or on a timer |
| Microphone | You press a voice hotkey or turn on the wake word | Recording while the **mic** indicator is on | With on-device recognition, audio never leaves the computer |
| Mouse and keyboard | Agent mode, or dictation that types for you | Clicks and keystrokes in other apps; each agent task still shows its plan first | Nothing without the plan being approved |

Indicators in the title strip show what is happening **right now**: **mic** (with the wake word when it is
armed), **screen** while a screenshot is taken, **control** while the agent drives the mouse and keyboard, and
**paused**. `Ctrl+Alt+.` or "ARVI, detente / stop" stops any automated action immediately.

Connected tools (MCP), uploads, form submissions and merges keep their own approvals, described in the README.

## Wake word: ARVI

Off by default. Turn it on in **Settings → Wake word** or from the tray menu.

- Say **"ARVI"** and then your request, in Spanish or English, without switching languages:
  "ARVI, abre Visual Studio Code" · "ARVI, open Visual Studio Code" · "ARVI, analiza mi pantalla" ·
  "ARVI, analyze my screen" · "ARVI, oculta MemoBrOS" · "ARVI, hide MemoBrOS" · "ARVI, muéstrame MemoBrOS" ·
  "ARVI, detente" · "ARVI, deja de escuchar". Saying only "ARVI" starts listening for one question.
- **It is local.** The microphone signal is cut into spoken phrases; each phrase is transcribed on this computer
  by the on-device speech model, even if you chose a cloud service for normal dictation. A phrase that does not
  start with the wake word is thrown away. Only a request addressed to ARVI goes on to the assistant.
- Show/hide, stop, mute and opening an installed app are handled locally without any model call.
- Anything sensitive still goes through its normal approval. A spoken "sí" or "yes" approves a pending card
  only when you say it with the name: "ARVI, sí".
- Answers are spoken in the language you used. Preferred voices are `es-MX` then `en-US`; change the order in
  Settings → Voice. Which voices exist depends on what your system has installed.
- Change the word in Settings. Recognisers write "ARVI" in several ways ("Arbi", "Harvey", "RV"); the common
  ones are accepted, and you can add more under "Also accept".
- CPU is used only while someone is speaking near the microphone, because each spoken phrase is transcribed.
  A dedicated keyword model would use less; see Recommendations.

## Wayland on Ubuntu / GNOME

MemoBrOS prefers to run natively on Wayland when your session is Wayland. It never changes your session and does
not work around the compositor's protections. What that means in practice:

| Capability | Native Wayland (default) | X11 mode through XWayland (Settings → System → Display mode) |
|---|---|---|
| Window, chat, routines, crew, connectors, background tasks | Yes | Yes |
| Show / hide / pause / quit from outside (`memobros --toggle` …) | Yes | Yes |
| Global shortcuts | Through the desktop's shortcuts portal, which asks you to approve them; if the desktop does not offer it, use the custom-shortcut fallback above | Only while an X11 window has focus |
| Stay above other windows, choose its own position | Not allowed by Wayland; the compositor decides | Yes |
| Cursor that points and draws over other apps | Not available. Memo names the control instead ("Look for: Export button") | Yes, over all windows |
| Seeing the screen | Through the system's screen-sharing dialog, which you approve | Only X11 windows; native Wayland windows may appear black |
| Agent clicking and typing in other apps | Not available. Agent mode says so instead of failing silently | Only into X11 apps |
| Dictation | Text is copied to the clipboard; press Ctrl+V | Typed into X11 apps |
| Opening installed apps by name | Yes | Yes |
| Active-window information | Not available | Not implemented |

Closing the gaps on native Wayland needs one of two things, neither built yet: the desktop's remote-control
portal for input, or a small optional GNOME Shell extension for always-on-top, the pointing overlay and
active-window information. An extension will only be installed or enabled after you approve it, and MemoBrOS
keeps working without it.

## What has been tested, and where

Run everything with `npm test`.

| Suite | What it proves | Result |
|---|---|---|
| `test/worktrees.test.js` | Git isolation for coders | 8/8 |
| `test/voice.test.js` | Wake-word matching, Spanish/English local commands, language detection, finding and starting installed apps | 6/6 |
| `test/e2e.js`, `test/e2e-free.js` | The existing features (ask, agent, dictation, routines, MCP, crew, uploads) still work | 9/9, 13/13 |
| `test/e2e-desktop.js` on X11 | Frameless floating window, compact bar, remembered position; close/hide keeps it running; a real `Ctrl+Alt+M` key press shows and hides it; control commands; pause; each permission asked before first use and revocable; wake word flow including a phrase through the live microphone path; explicit quit | 6/6 |
| `test/e2e-desktop.js` on native Wayland | Starts with no X11 at all, no overlay window, honest capability report, control commands, agent refusal, clipboard dictation, a clear message when screen sharing is unavailable | 2/2 |
| Installed `.deb` | Installs, registers the launcher with its actions, and the desktop suite passes against `/usr/bin/memobros` | 8/8 |

Environment for all of the above: Ubuntu 24.04 container, Xvfb for X11, a headless Weston compositor for
Wayland, a scripted stand-in for the model, a fake audio device and a stand-in transcript.

**Not yet verified on the target machine (Ubuntu 26.04.1, GNOME 50.1):**

- that the tray icon appears in the GNOME top bar;
- that GNOME's shortcuts portal accepts the shortcuts on native Wayland (Weston has no portal; registration
  reporting "ok" there proves nothing about GNOME);
- that the screen-sharing dialog appears and capture works on native Wayland;
- the wake word with a real microphone and the real on-device speech model, including how reliably "ARVI" is
  recognised in each language, and its CPU use;
- Spanish and English system voices;
- the `.deb` on Ubuntu 26.04 and launching from the GNOME applications menu.

## Recommendations for later versions

1. Test the list above on the target machine and fix what it shows before adding more.
2. Screen capture on Wayland: hold one approved screen-share stream for the session instead of asking per
   request.
3. Input on Wayland: the remote-control portal, with its own permission and indicator.
4. Optional GNOME Shell extension for always-on-top, the pointing overlay and active-window information.
5. A dedicated keyword model for "ARVI" to cut CPU use; the current approach transcribes every spoken phrase.
6. Sign the packages and add an update channel.
