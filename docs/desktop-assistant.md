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
- CPU is used only while someone is speaking near the microphone: each spoken phrase is decoded by the Tiny
  model (a fraction of a second). A dedicated keyword model would use less still; see Recommendations.

### On-device speech recognition

Speech is recognised by multilingual Whisper running on this computer through sherpa-onnx, in a process of its
own. Settings → Voice lists the three models and what each one is doing:

| Model | Download | Memory when loaded | Notes |
|---|---|---|---|
| Tiny | 111 MB | about 300 MB | fastest; always used for the wake word |
| Base | 190 MB | about 450 MB | default |
| Small | 610 MB | about 900 MB | most accurate, especially for Spanish; slower |

- **States are real.** Not downloaded → Downloading (megabytes received of the total) → Checking the files →
  Downloaded → Loading into memory → Ready → Transcribing, with Interrupted, Cancelled and Failed when those
  happen. Download and loading are separate stages, so a finished download never sits at "98%".
- **Downloads resume.** An interrupted or cancelled download continues from where it stopped. A damaged file is
  detected, removed and downloaded again on retry. A model already on disk is never downloaded again, and is
  checked against the sizes recorded when it was installed.
- **Switching models** closes the speech process that held the old one, so its memory is returned. The process
  also closes after ten minutes without use.
- **If the speech process fails**, MemoBrOS stays open and shows what happened; after three failures in a
  minute it stops retrying until you change the model or try again later. The wake word switches itself off
  instead of looping.
- **Silence** is never sent to a recogniser, and text a recogniser invents from noise (a phrase in a loop,
  "[Música]", "Thank you.") is never acted on.
- Models come from the sherpa-onnx project's releases on GitHub. Nothing else is downloaded, and audio never
  leaves the computer unless you choose cloud speech recognition.

### Languages

"Spoken language: Automatic" chooses between your preferred languages (Settings → Voice, `es-MX, en-US` by
default; the first is the default language). The model's own detection is used only when it names one of them;
otherwise the phrase is decoded in your first language. Short phrases are easy to misdetect, so this is
deliberate: MemoBrOS never falls back to English on its own. You can also fix one language.

For the wake word, each phrase is decoded by the Tiny model once per preferred language. Only when one of those
starts with the wake word is the phrase decoded again with your chosen model, in the language that matched, to
get the command right. Ordinary conversation never reaches the larger model.

### If the microphone does not work

MemoBrOS reports the problem once and says what it found. "Cannot find any microphone" means the system offers
it no input device at all: open your system Settings → Sound → Input, choose a microphone and check that the
level moves when you speak. Then use **Settings → Voice → Test microphone** in MemoBrOS, which listens for
three seconds and tells you which device it opened and whether it heard anything. You can pick a specific
microphone in the same place. If the wake word cannot open the microphone it switches itself off and shows the
reason next to its checkbox.

## The assistant pointer

MemoBrOS has its own pointer. It is a second, purely visual pointer: it never replaces, moves or hides your real
mouse cursor, and it never clicks. Pointing at something and acting on it are separate; clicking and typing
belong to agent mode and its own permission.

- **Follow mode** (Settings → Pointer): the pointer accompanies your cursor everywhere, also while the MemoBrOS
  window is hidden. Size and offset are adjustable; unticking the box removes it at once.
- **Guide mode**: when Memo answers about something on screen, the pointer flies to it and the area is
  highlighted, then it returns to following.

Who draws it depends on the display mode:

| Display mode | Drawn by | Status |
|---|---|---|
| X11 (and XWayland) | MemoBrOS's own click-through overlay window | tested |
| Native Wayland | the optional **MemoBrOS Pointer** GNOME Shell extension | written, **not yet run on GNOME** |
| Native Wayland without the extension | nothing is drawn; Memo names the control in words | tested |

**The GNOME extension (optional).** Wayland does not let an application draw above other windows; GNOME Shell
itself can. The extension is about 180 lines in `gnome-extension/memobros-pointer@memobros.app/extension.js`:
it offers a few drawing calls on your session's D-Bus and draws three click-through items (pointer, label,
highlight frame). It reads the pointer position to follow it and the monitor layout to place things. It does
not inject input, read window contents or capture the screen, and it hides everything if MemoBrOS stops
answering for 15 seconds.

The extension ships with MemoBrOS (it arrives with `git pull` and is inside the packages). In native Wayland
mode, **Settings → Pointer** shows a "GNOME pointer extension" box with **Install…**, **Enable…** and
**Remove…**. Each asks for your approval first. Install copies two files into your own GNOME extensions folder;
then log out and in once so GNOME notices it, and press Enable. The same from a terminal:

```bash
npm run pointer:install          # copies it to ~/.local/share/gnome-shell/extensions; does not enable it
# log out and in again, then:
gnome-extensions enable memobros-pointer@memobros.app
# to turn it off or remove it:
gnome-extensions disable memobros-pointer@memobros.app
npm run pointer:install -- --remove
```

Then restart MemoBrOS; Settings → Pointer should say it is drawn by the GNOME extension. Known limits: with
several monitors the screenshot is assumed to show the monitor your cursor is on; active-window information is
still not available.

## Wayland on Ubuntu / GNOME

MemoBrOS prefers to run natively on Wayland when your session is Wayland. It never changes your session and does
not work around the compositor's protections. What that means in practice:

| Capability | Native Wayland (default) | X11 mode through XWayland (Settings → System → Display mode) |
|---|---|---|
| Window, chat, routines, crew, connectors, background tasks | Yes | Yes |
| Show / hide / pause / quit from outside (`memobros --toggle` …) | Yes | Yes |
| Global shortcuts | Through the desktop's shortcuts portal, which asks you to approve them; if the desktop does not offer it, use the custom-shortcut fallback above | Only while an X11 window has focus |
| Stay above other windows, choose its own position | Not allowed by Wayland; the compositor decides | Yes |
| Pointer that follows the cursor and points at things | With the optional GNOME extension (untested on GNOME); otherwise Memo names the control ("Look for: Export button") | Yes, over all windows |
| Seeing the screen | Through the system's screen-sharing dialog, which you approve | Only X11 windows; native Wayland windows may appear black |
| Agent clicking and typing in other apps | Not available. Agent mode says so instead of failing silently | Only into X11 apps |
| Dictation | Text is copied to the clipboard; press Ctrl+V | Typed into X11 apps |
| Opening installed apps by name | Yes | Yes |
| Active-window information | Not available | Not implemented |

To get the pointer and agent control back, press **Switch to X11 mode and restart MemoBrOS** under Settings →
Permissions (or choose it under Settings → System → Display mode). Switch back the same way.

Clicking and typing in other apps on native Wayland still needs the desktop's remote-control portal, which is
not implemented.

To get the pointer and agent control back, press **Switch to X11 mode and restart MemoBrOS** under Settings →
Permissions (or choose it under Settings → System → Display mode). Switch back the same way.

Closing the gaps on native Wayland needs one of two things, neither built yet: the desktop's remote-control
portal for input, or a small optional GNOME Shell extension for always-on-top, the pointing overlay and
active-window information. An extension will only be installed or enabled after you approve it, and MemoBrOS
keeps working without it.

## What has been tested, and where

Run everything with `npm test`.

| Suite | What it proves | Result |
|---|---|---|
| `test/worktrees.test.js` | Git isolation for coders | 8/8 |
| `test/voice.test.js` | Wake-word matching, Spanish/English local commands, invented-text detection, finding and starting apps | 7/7 |
| `test/speech-models.test.js` | Model lifecycle: download progress, resume, cancel, damaged file, cache check, numbered operations; language policy; two-stage wake word | 11/11 |
| `test/pointer.test.js` | Pointer driver: follow on/off, coordinate mapping across monitors, clean-up, extension is draw-only and opt-in | 4/4 |
| `test/e2e.js`, `test/e2e-free.js` | Existing features (ask, agent, dictation, routines, MCP, crew, uploads) | 9/9, 13/13 |
| `test/e2e-desktop.js` | Floating window, background, control commands, pause, permissions, wake word, pointer follow mode on X11, speech-process failure handling, model list, and a native Wayland run | 13/13 |
| `test/speech-real.test.js` | **Real tiny, base and small models** inside the app: download, check, load, transcribe English and Spanish audio, switch models, restart from cache, no process left behind | 4/4, also against the installed `.deb` |

`test/speech-real.test.js` needs about 1 GB of fixtures and skips itself without them:
`sh scripts/fetch-speech-fixtures.sh && npm run test:speech`.

Environment for all of the above: Ubuntu 24.04 container, Xvfb for X11, a headless Weston compositor for
Wayland, a scripted stand-in for the chat model, a fake audio device, and synthetic (espeak) voices for the real
speech test. Measured there with the real models: Base 0.8 s per phrase and 455 MB; Small 0.8 to 2 s and 870 MB;
Tiny plus Base loaded together 690 MB; first use about 25 s including download and loading; 1.2 s after a
restart with the model cached.

**Not yet verified on the target machine (Ubuntu 26.04.1, GNOME 50.1):**

- (confirmed by the user: the tray icon appears in the GNOME top bar, and the app opens from the applications menu)
- that GNOME's shortcuts portal accepts the shortcuts on native Wayland (Weston has no portal; registration
  reporting "ok" there proves nothing about GNOME);
- that the screen-sharing dialog appears and capture works on native Wayland;
- speech with a real microphone and a human voice: how reliably "ARVI" and commands are recognised in Spanish
  and English (the synthetic test voice was understood well in English and in longer Spanish sentences, poorly
  in very short Spanish phrases), and CPU use;
- the MemoBrOS Pointer GNOME extension on GNOME Shell 50.1: follow mode, guide mode, several monitors, display
  scaling;
- Spanish and English system voices;
- the `.deb` on Ubuntu 26.04 and launching from the GNOME applications menu.

## Checklist for the target desktop

On Ubuntu 26.04 / GNOME 50 / Wayland, after `git pull && npm install`:

1. **Speech:** Settings → Voice → Download *Base*; the row should go Downloading → Checking → Downloaded. Press
   `Ctrl+Alt+Space` (or the mic button), say a sentence in Spanish, then one in English; each should appear as
   typed. Repeat with *Small* selected; *Base* should return to "Downloaded".
2. **ARVI:** tick "Listen for the wake word" and "Show in the chat what the wake word hears". Say "ARVI, oculta
   MemoBrOS", "ARVI, show MemoBrOS", "ARVI, abre Visual Studio Code", "ARVI, analyze my screen". Note the
   `heard:` lines for any that fail.
3. **Pointer, X11 mode:** Settings → Permissions → Switch to X11 mode. Move the mouse over other apps: the
   pointer should follow, also with the MemoBrOS window hidden. Untick Follow: it disappears.
4. **Pointer, native Wayland with the extension:** install and enable it as above. Check follow mode over
   several apps, on each monitor if you have more than one, and with display scaling other than 100%. Ask Memo
   where a button is and check the pointer lands on it. Quit MemoBrOS: the pointer should vanish within 15 s.
5. **Microphone permissions and indicator:** the **mic** badge is on only while listening.

## Installing and npm messages

- `npm install` needs no install scripts from dependencies any more. The earlier advice to run
  `npm install-scripts approve onnxruntime-node` came from a warning printed by npm on the target machine; that
  package is no longer used, so the warning about it is gone and the command is not needed.
- `npm audit` reports 13 moderate findings and nothing higher. Six are in the packaging tool (`electron-builder`
  → `minimatch`), used only when building installers. Seven come from one advisory in `file-type`, pulled in by
  the image code inside `nut-js`; MemoBrOS uses nut-js only for mouse and keyboard input and never parses image
  files with it, so that code is not reached. No fix is published for it, and `npm audit fix --force` would
  downgrade the packaging tool, so nothing was force-fixed.

## Recommendations for later versions

1. Test the list above on the target machine and fix what it shows before adding more.
2. Screen capture on Wayland: hold one approved screen-share stream for the session instead of asking per
   request.
3. Input on Wayland: the remote-control portal, with its own permission and indicator.
4. Extend the GNOME Shell extension, after it is verified on GNOME 50, to keep the MemoBrOS window on top and
   to report the active window.
5. A dedicated keyword-spotting model for "ARVI" (sherpa-onnx offers them) to cut CPU use further, once real-voice
   recordings are available to tune it.
6. Sign the packages and add an update channel.
