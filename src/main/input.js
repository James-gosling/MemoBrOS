// Synthetic mouse / keyboard input (agent mode and dictation), via nut.js.
const { clipboard } = require('electron');

let nut;
function lib() {
  if (!nut) {
    nut = require('@nut-tree-fork/nut-js');
    nut.keyboard.config.autoDelayMs = 8;
    nut.mouse.config.autoDelayMs = 4;
    nut.mouse.config.mouseSpeed = 2500;
  }
  return nut;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMac = process.platform === 'darwin';

const ALIASES = {
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', option: 'LeftAlt', opt: 'LeftAlt',
  cmd: 'LeftSuper', command: 'LeftSuper', meta: 'LeftSuper', super: 'LeftSuper', win: 'LeftSuper', windows: 'LeftSuper',
  mod: isMac ? 'LeftSuper' : 'LeftControl',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', capslock: 'CapsLock',
  '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
  '[': 'LeftBracket', ']': 'RightBracket', '\\': 'Backslash', '`': 'Grave', plus: 'Equal', minus: 'Minus',
};

// "ctrl+shift+s" → [Key.LeftControl, Key.LeftShift, Key.S]
function parseCombo(combo) {
  const { Key } = lib();
  return String(combo).split('+').map((raw) => {
    const p = raw.trim().toLowerCase();
    let name = ALIASES[p];
    if (!name && /^[a-z]$/.test(p)) name = p.toUpperCase();
    if (!name && /^[0-9]$/.test(p)) name = `Num${p}`;
    if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(p)) name = p.toUpperCase();
    if (!name || Key[name] === undefined) throw new Error(`Unknown key "${raw}" in "${combo}"`);
    return Key[name];
  });
}

async function move(pt) { const { mouse, Point, straightTo } = lib(); await mouse.move(straightTo(new Point(pt.x, pt.y))); }
async function click(pt, button = 'left', double = false) {
  const { mouse, Button } = lib();
  await move(pt);
  await sleep(60);
  const b = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE }[button] ?? Button.LEFT;
  if (double) await mouse.doubleClick(b); else await mouse.click(b);
}
async function drag(from, to) {
  const { mouse, Button } = lib();
  await move(from); await mouse.pressButton(Button.LEFT); await sleep(80);
  await move(to); await sleep(80); await mouse.releaseButton(Button.LEFT);
}
async function scroll(pt, dy) {
  const { mouse } = lib();
  if (pt) await move(pt);
  const n = Math.round(Math.abs(dy));
  if (dy > 0) await mouse.scrollDown(n); else await mouse.scrollUp(n);
}
async function key(combo) {
  const { keyboard } = lib();
  const keys = parseCombo(combo);
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys); // nut.js expects modifiers first for release as well
}

// Paste through the clipboard: fast and correct for every script (accents, CJK, emoji, RTL).
async function paste(text) {
  const previous = String((await clipboard.readText()) || ''); // async in newer Electron, sync in older
  await clipboard.writeText(text);
  await sleep(40);
  await key('mod+v');
  await sleep(150);
  await clipboard.writeText(previous);
}
async function type(text) {
  if (/^[\x20-\x7e]{1,120}$/.test(text)) await lib().keyboard.type(text);
  else await paste(text);
}

module.exports = { move, click, drag, scroll, key, type, paste, parseCombo, sleep };
