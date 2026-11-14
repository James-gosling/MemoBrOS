# MemoBrOS v0.5 repair: task state

Checkpoint for whoever continues this work. Updated at milestones.

- **Objective:** reliable local speech recognition (P0), model lifecycle (P1), bilingual ARVI (P2), dependency
  audit (P3), desktop-wide assistant pointer on GNOME Wayland (P4).
- **Branch:** `claude/festive-wozniak-5h9t6d` (PR #1). Work happens in a cloud Linux container, not on the target
  laptop; nothing here has been run on Ubuntu 26.04 / GNOME 50.

## Confirmed findings (with evidence)

1. **Exit code 133 is SIGTRAP (128+5):** the speech process is killed by a trap instruction, the way V8 and
   Chromium abort; it is not a plain crash of the ONNX runtime (that would be 139 or 134).
2. **`onnxruntime-node` 1.30 itself runs in Electron 45:** a real Whisper encoder ran to completion in plain
   Node, in an Electron utility process and in the Electron main process (exit 0 in all three). So "ONNX Runtime
   cannot run in Electron" is ruled out.
3. **The exact trigger inside the old pipeline (transformers.js Whisper + onnxruntime-node) is NOT identified.**
   It could not be reproduced: its model files come from huggingface.co, which this environment cannot reach.
4. **The old engine never detected the language.** Its own log line "No language specified - defaulting to
   English (en)" shows that "Auto-detect" silently meant English. Spanish speech was decoded as English, which
   produced the looping nonsense text.
5. **Electron forbids native add-ons from creating external buffers** (V8 sandbox): reproduced as "External
   buffers are not allowed" with the new engine's file reader; avoided by copying.
6. **sherpa-onnx (`sherpa-onnx-node` 2.0.1) with multilingual Whisper works inside an Electron utility process:**
   real audio transcribed with tiny, base and small; language reported per utterance; language switchable at
   run time. Measured in this container (2 threads): tiny ~0.1-0.4 s per phrase, ~300 MB; base ~0.2-0.7 s,
   ~450 MB; small ~0.6-2.1 s, ~880 MB.
7. Automatic language detection on very short phrases is unreliable (a three-word phrase was detected as Thai),
   so detection must be restricted to the user's preferred languages.

## Decision

Replace the old speech engine with sherpa-onnx in the speech process; own the model download and cache; restrict
language detection to the preferred languages; use the tiny model for wake-word detection and the chosen model
for the command.

## Status

See the end of this file.

### Milestone 1 (done, committed): speech engine replaced and verified

- `src/main/speech/models.js` model lifecycle (download with resume, cancel, verify, atomic install, cache check).
- `src/main/speech/policy.js` language policy and two-stage wake word. `worker.js` speech process (sherpa-onnx).
  `engine.js` supervisor (crash isolation, three-failures-a-minute stop, model released on switch, idle shutdown).
- `@huggingface/transformers` (and with it `onnxruntime-node`, `protobufjs`, `sharp`) removed; `sherpa-onnx-node`
  added. No dependency needs an install script any more.
- Tests: `test/speech-models.test.js` 11/11; `test/e2e-desktop.js` 11/11; `test/speech-real.test.js` 4/4 with the
  real tiny/base/small models and synthetic Spanish/English speech inside the app.
- Remaining for speech: real microphone and real human voice on the target laptop.

### Milestone 2 (done, committed): pointer, dependency audit, packaging, documentation

- Pointer: follow and guide modes; X11 overlay honours follow/size/offset (tested); native Wayland goes through
  the optional GNOME Shell extension `gnome-extension/memobros-pointer@memobros.app` via `src/main/pointer.js`
  (driver tested against a stand-in `gdbus`; **the extension itself has never run on GNOME**).
- `scripts/install-pointer-extension.js` copies the extension and never enables it.
- `.deb` 0.5.1 builds (117 MB), installs, and the real-model speech test passes against the installed app.
- npm audit: 13 moderate, none reachable from MemoBrOS code; nothing force-fixed. Documented.
- User documentation: `docs/desktop-assistant.md` (speech, languages, pointer, checklist, npm notes).

### Test results at this point

worktrees 8/8 · voice 7/7 · speech-models 11/11 · pointer 4/4 · e2e 9/9 · e2e-free 13/13 · e2e-desktop 13/13 ·
speech-real 4/4 (source tree and installed .deb).

### Milestone 3 (done, committed): first results from the target laptop

Confirmed by the user on Ubuntu 26.04 / GNOME 50 / Wayland with v0.5.1: Tiny and Base download and reach "Ready";
the wake word arms and triggers; speech is transcribed; **screen capture works on native Wayland** (the model
described the screen). Found there and fixed: a Spanish request after the wake word was decoded as English
("What was very my pantaya?") because the language was taken from whichever Tiny attempt caught the name; the
chosen model now decides the language from the phrase itself. Replies no longer show raw markdown marks.

### Still open

1. **Exit 133 root cause in the old engine: unidentified** (see findings 1-3). The engine is gone; the question
   only matters if someone brings it back.
2. On the target laptop: real microphone + human voice with tiny/base/small; ARVI accuracy in es/en.
3. GNOME extension on GNOME Shell 50.1 (follow, guide, multi-monitor, scaling). Expect small API fixes.
4. Wayland input control (remote-desktop portal) and active-window info: not started.
5. Persistent screen-share stream on Wayland instead of a prompt per capture: not started.

### Next executable action

Run the checklist in `docs/desktop-assistant.md` ("Checklist for the target desktop") on the laptop and fix what
it shows, starting with step 1 (speech) and step 2 (ARVI `heard:` lines).
