# MemoBrOS on Windows: status

Nothing here has been run on Windows. This page says what is written for it, how to check it, and what is known
to be missing.

## How to check

- **On a Windows machine:** install Node.js 22 and Git, then `npm install`, `npm start`. Build the installer with
  `npm run dist:win` (NSIS, in `dist/`). Build it on Windows: the speech runtime is fetched per platform.
- **Without a Windows machine:** the repository has a workflow, *Cross-platform tests*, that runs the
  platform-independent suites on Windows and Linux and builds the Windows installer. It never runs by itself:
  start it from the repository's Actions tab → Cross-platform tests → Run workflow. It has not been run yet, so
  expect its first run to find things.

## Written for Windows, untested

| Area | What the code does on Windows |
|---|---|
| Running commands | `cmd.exe /d /s /c` for shell lines; the whole process tree is stopped with `taskkill /T /F`; the never-run list covers `format`, `diskpart`, `bcdedit`, `reg delete`, `del /s`, `rd /s` on a drive, `runas` |
| Coding agents | adapters start `claude`, `codex`, `jules` by name; test stand-ins also install `.cmd` shims |
| Remote worker | plain Node; no platform-specific code |
| Speech models | downloaded and unpacked with `tar`, which Windows 10 and later include |
| Window, tray, hotkeys | Electron's own Windows support; `Ctrl+Alt+…` shortcuts; app id set for notifications |
| Overlay pointer | the click-through overlay window (same as X11), excluded from screenshots |
| Mouse/keyboard, dictation | nut.js, with coordinates converted for display scaling |
| Installer | NSIS, per-user, with a desktop shortcut |

## Known gaps on Windows

- Opening apps by name ("ARVI, open …") is implemented for Linux only.
- "Start with the system" works for installed builds only.
- `npm run install:desktop` and the GNOME pointer extension are Linux-only by nature.
- The on-screen parts (overlay, agent control, dictation) and the microphone have never been exercised there.
