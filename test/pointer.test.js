// Unit tests for the pointer driver that talks to the optional GNOME Shell extension, against a stand-in `gdbus`.
// They prove the driver's behaviour and coordinate mapping; they do not prove anything about GNOME itself.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const fakeGdbus = require('./fakeGdbus');
const { ExtensionPointer } = require('../src/main/pointer');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const realPath = process.env.PATH;

test('without the extension the driver reports "not available" and every call is a harmless no-op', async () => {
  process.env.PATH = '/nonexistent';
  const p = new ExtensionPointer('/tmp/cursor.png');
  assert.equal(await p.detect(), false);
  assert.equal(await p.pointAt({ w: 1366, h: 768 }, 10, 10, 'x'), false);
  assert.equal(await p.highlight({ w: 1366, h: 768 }, { x: 1, y: 1, x2: 5, y2: 5 }, 'x'), false);
  await p.setFollow(true); await p.clear(); await p.stop();
});

test('follow mode: on and off are sent with the pointer image, offset and size', async () => {
  const g = fakeGdbus(); process.env.PATH = `${g.dir}:${realPath}`;
  const p = new ExtensionPointer('/opt/MemoBrOS/assets/cursor.png');
  assert.equal(await p.detect(), true);
  await p.setFollow(true, { offsetX: 20, offsetY: 24, size: 64 });
  await p.setFollow(false, { offsetX: 20, offsetY: 24, size: 64 });
  assert.deepEqual(g.calls(), ['Ping', 'SetFollow|true|"/opt/MemoBrOS/assets/cursor.png"|20|24|64', 'SetFollow|false|"/opt/MemoBrOS/assets/cursor.png"|20|24|64']);
  await p.stop();
});

test('guide mode: screenshot coordinates are mapped onto the monitor under the cursor, across monitors and scaling', async () => {
  const g = fakeGdbus(); process.env.PATH = `${g.dir}:${realPath}`;
  const p = new ExtensionPointer('/x.png');
  await p.detect();
  // a 2560x1440 monitor placed to the right of a 1920-wide one, screenshot scaled down to 1366x768
  assert.equal(await p.pointAt({ w: 1366, h: 768 }, 683, 384, 'Export button', 9), true);
  assert.equal(g.calls().at(-1), 'PointAt|3200|720|"Export button"|9', 'the middle of the screenshot is the middle of that monitor');
  assert.equal(await p.highlight({ w: 1366, h: 768 }, { x: 0, y: 0, x2: 1366, y2: 768 }, 'All of it'), true);
  assert.equal(g.calls().at(-1), 'Highlight|1920|0|2560|1440|"All of it"|20');
  await p.pointAt({ w: 1366, h: 768 }, 0, 0, 'He said "hi"');
  assert.equal(g.calls().at(-1), 'PointAt|1920|0|"He said \\"hi\\""|9', 'labels are passed as one quoted string');
  assert.deepEqual(ExtensionPointer.map({ w: 1280, h: 800 }, { x: 0, y: 0, width: 1280, height: 800 }, 400, 300), { x: 400, y: 300 }, 'no scaling when sizes match');
  const single = fakeGdbus([{ x: 0, y: 0, width: 1920, height: 1200, scale: 2, primary: true, current: false }]); process.env.PATH = `${single.dir}:${realPath}`;
  const q = new ExtensionPointer('/x.png'); await q.detect();
  await q.pointAt({ w: 1366, h: 854 }, 1366, 854, '');
  assert.equal(single.calls().at(-1), 'PointAt|1920|1200|""|9', 'with no monitor under the cursor the primary one is used');
  await p.stop(); await q.stop();
});

test('stopping MemoBrOS turns follow off and clears what was drawn; the extension is opt-in and only draws', async () => {
  const g = fakeGdbus(); process.env.PATH = `${g.dir}:${realPath}`;
  const p = new ExtensionPointer('/x.png');
  await p.detect(); await p.setFollow(true);
  await p.stop();
  assert.deepEqual(g.calls().slice(-2), ['SetFollow|false|""|0|0|0', 'Clear']);
  const ext = fs.readFileSync(path.join(__dirname, '..', 'gnome-extension', 'memobros-pointer@memobros.app', 'extension.js'), 'utf8');
  const code = ext.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/reactive: false/.test(code) && !/reactive: true/.test(code), 'everything it draws is click-through');
  for (const banned of ['VirtualInputDevice', 'notify_button', 'notify_key', 'Screenshot', 'warp_pointer', 'Meta.Cursor', 'set_pointer_visible', 'Soup', 'Gio.Subprocess']) assert.ok(!code.includes(banned), `the extension must not use ${banned}`);
  assert.ok(/SILENCE_SECONDS/.test(code) && /_hideAll\(\)/.test(code), 'it hides itself when MemoBrOS stops pinging');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gnome-extension', 'memobros-pointer@memobros.app', 'metadata.json'), 'utf8'));
  assert.ok(meta['shell-version'].includes('50'));
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-pointer-extension.js'), 'utf8');
  assert.ok(!/gnome-extensions['", ]+enable|execSync|spawn/.test(installer.replace(/console\.log\([\s\S]*?\);/g, '')), 'the installer copies files and never enables the extension itself');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
  }
  process.env.PATH = realPath;
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
