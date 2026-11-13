#!/usr/bin/env node
// Installs (copies) the optional MemoBrOS Pointer GNOME Shell extension for the current user. It does NOT enable it.
//   node scripts/install-pointer-extension.js            copy the extension and print how to enable it
//   node scripts/install-pointer-extension.js --remove   remove it again
const fs = require('fs');
const os = require('os');
const path = require('path');

const uuid = 'memobros-pointer@memobros.app';
const from = path.join(__dirname, '..', 'gnome-extension', uuid);
const to = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'gnome-shell', 'extensions', uuid);

if (process.argv.includes('--remove')) {
  fs.rmSync(to, { recursive: true, force: true });
  console.log(`Removed ${to}\nIf it was enabled, also run:  gnome-extensions disable ${uuid}`);
  process.exit(0);
}
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log(`Copied the extension to ${to}

It is not enabled yet. To use it:
  1. Log out and log in again (on Wayland, GNOME only notices new extensions at login).
  2. gnome-extensions enable ${uuid}
  3. Restart MemoBrOS. Settings → Pointer should say "GNOME extension".

To turn it off:   gnome-extensions disable ${uuid}
To remove it:     node scripts/install-pointer-extension.js --remove
What it can do is written at the top of ${path.join(to, 'extension.js')}.`);
