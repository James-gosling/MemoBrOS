#!/usr/bin/env node
// Adds MemoBrOS to the desktop's applications menu for a source checkout, so it starts without a terminal.
//   node scripts/install-desktop.js             install the launcher (with Show/Hide, Pause and Quit actions)
//   node scripts/install-desktop.js --systemd   also write a systemd user unit (NOT enabled; see the printed command)
//   node scripts/install-desktop.js --remove    remove what this script installed
// Installed builds (.deb / AppImage) bring their own launcher and do not need this.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'linux') { console.error('This script is for Linux desktops.'); process.exit(1); }
const root = path.join(__dirname, '..');
const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const launcher = path.join(data, 'applications', 'memobros.desktop');
const iconFile = path.join(data, 'icons', 'hicolor', '512x512', 'apps', 'memobros.png');
const unit = path.join(config, 'systemd', 'user', 'memobros.service');

if (process.argv.includes('--remove')) {
  for (const f of [launcher, iconFile, unit]) if (fs.existsSync(f)) { fs.rmSync(f); console.log(`removed ${f}`); }
  console.log('If you enabled the systemd unit, run: systemctl --user disable --now memobros.service');
  process.exit(0);
}

let electron;
try { electron = require(path.join(root, 'node_modules', 'electron')); } catch { console.error('Run "npm install" first.'); process.exit(1); }
const run = `"${electron}" "${root}"`;

fs.mkdirSync(path.dirname(launcher), { recursive: true });
fs.mkdirSync(path.dirname(iconFile), { recursive: true });
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), iconFile);
fs.writeFileSync(launcher, `[Desktop Entry]
Type=Application
Name=MemoBrOS
GenericName=Desktop assistant
Comment=Screen-aware AI assistant that stays in the background
Exec=${run}
Icon=memobros
Terminal=false
Categories=Utility;
StartupWMClass=MemoBrOS
Actions=Toggle;Pause;Resume;Quit;

[Desktop Action Toggle]
Name=Show / hide MemoBrOS
Exec=${run} --toggle

[Desktop Action Pause]
Name=Pause the assistant
Exec=${run} --pause

[Desktop Action Resume]
Name=Resume the assistant
Exec=${run} --resume

[Desktop Action Quit]
Name=Quit MemoBrOS completely
Exec=${run} --quit
`);
console.log(`Launcher written: ${launcher}`);
console.log('MemoBrOS is now in the applications menu. Closing its window keeps it running; use the ⏻ button or the "Quit" action to stop it.');
console.log(`To bind show/hide to a key: Settings → Keyboard → Custom Shortcuts, command:\n  ${run} --toggle`);

if (process.argv.includes('--systemd')) {
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, `[Unit]
Description=MemoBrOS desktop assistant
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=${run} --hidden
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
`);
  console.log(`\nsystemd user unit written (not enabled): ${unit}`);
  console.log('To start MemoBrOS with your session:  systemctl --user enable --now memobros.service');
  console.log('To undo:                              systemctl --user disable --now memobros.service');
}
