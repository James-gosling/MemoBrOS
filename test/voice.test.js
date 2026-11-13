// Unit tests for the local wake word, the bilingual local commands and app lookup (plain Node).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const wake = require('../src/main/wake');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const kind = (t, word) => { const m = wake.match(t, word); return m ? wake.interpret(m.command) : null; };

test('"ARVI" is recognised in Spanish and English, including the ways recognisers spell it', () => {
  for (const t of ['ARVI, abre Visual Studio Code.', 'Arvi open Visual Studio Code', 'Arbi, analiza mi pantalla', 'Harvey, analyze my screen', 'Oye Arvi, oculta MemoBrOS', 'hey RV, hide MemoBrOS', 'Arvy', 'ARBÍ revisa el estado del proyecto', 'Ar vi, muéstrame MemoBrOS']) {
    assert.ok(wake.match(t), `should wake on: ${t}`);
  }
  assert.equal(wake.match('ARVI, abre Visual Studio Code.').command, 'abre Visual Studio Code.');
  assert.equal(wake.match('Oye Arvi, ¿qué hay en mi pantalla?').command, '¿qué hay en mi pantalla?');
});

test('speech that is not addressed to the assistant is ignored', () => {
  for (const t of ['abre Visual Studio Code', 'let us arrive at the station', 'Harvard is a university', 'the army is large', 'vamos a abrir el archivo', 'I told Arvi to open it', '', 'sí', 'yes do it']) {
    assert.equal(wake.match(t), null, `should not wake on: ${t}`);
  }
});

test('the wake word can be changed', () => {
  assert.ok(wake.match('Memo, hide the window', 'Memo'));
  assert.equal(wake.match('ARVI, hide the window', 'Memo'), null);
  assert.ok(wake.match('jarvis open the panel', 'Jarvis'));
  assert.ok(wake.match('Nova abre la ventana', 'ARVI', ['nova']), 'extra spellings from settings are accepted');
});

test('local commands are understood in both languages', () => {
  const cases = {
    show: ['ARVI, muéstrame MemoBrOS', 'ARVI, show MemoBrOS', 'ARVI abre la ventana', 'Arvi, show me the window'],
    hide: ['ARVI, oculta MemoBrOS.', 'ARVI, hide MemoBrOS', 'ARVI, oculta la ventana', 'Arvi close the window'],
    stop: ['ARVI, detente', 'ARVI, stop', 'ARVI para todo', 'Arvi cancel that'],
    mute: ['ARVI, deja de escuchar', 'ARVI, stop listening', 'Arvi mute the microphone'],
    yes: ['ARVI, sí', 'ARVI, yes', 'Arvi adelante', 'Arvi, approve'],
    no: ['ARVI, no', 'ARVI, cancélalo', 'Arvi deny'],
    listen: ['ARVI', 'Arvi.'],
  };
  for (const [want, phrases] of Object.entries(cases)) for (const p of phrases) assert.equal(kind(p).kind, want, p);
  assert.deepEqual(kind('ARVI, abre Visual Studio Code.'), { kind: 'open', app: 'Visual Studio Code' });
  assert.deepEqual(kind('ARVI, open Visual Studio Code'), { kind: 'open', app: 'Visual Studio Code' });
  assert.deepEqual(kind('ARVI, analiza mi pantalla'), { kind: 'ask', text: 'analiza mi pantalla' });
  assert.deepEqual(kind('ARVI, analyze my screen'), { kind: 'ask', text: 'analyze my screen' });
  assert.equal(kind('ARVI, revisa el estado del proyecto').kind, 'ask');
  assert.equal(kind('ARVI, open the file I was editing yesterday and fix it').kind, 'ask', 'a long request is not mistaken for an app name');
  assert.equal(kind('ARVI, borra todos mis archivos').kind, 'ask', 'anything else goes through the normal, confirmed path');
});

test('the language of a sentence picks the voice', () => {
  assert.equal(wake.languageOf('Haz clic en el botón azul que está aquí'), 'es');
  assert.equal(wake.languageOf('Abriendo Visual Studio Code.'), 'es');
  assert.equal(wake.languageOf('Click the blue button here'), 'en');
  assert.equal(wake.languageOf('Opening the project for you'), 'en');
});

test('text the recogniser invents from noise is never treated as something the user said', () => {
  const { garbled } = require('../src/main/stt');
  const loop = `I'm not sure if I can ${'get a chance to '.repeat(40)}get`;
  assert.equal(garbled(loop), true, 'a phrase repeated in a loop');
  for (const t of ['Thank you.', 'Thanks for watching!', 'Subtítulos realizados por la comunidad de Amara.org', '[Música]', 'you', 'no no no no no no no no no no no no', 'la la la la la la la la la la']) assert.equal(garbled(t), true, t);
  for (const t of ['ARVI, abre Visual Studio Code', 'ARVI, analiza mi pantalla y dime qué botón debo pulsar para exportar el video', 'How do I add a scroll animation to this selected section in Framer? Point to each step and wait for me to follow it.',
    'Every Tuesday at 5 PM, check my inbox for invoices and tell me what arrived', 'sí', 'no, no, espera', 'Arvi', 'memo agent, abre el navegador y busca el clima de hoy en la Ciudad de México']) assert.equal(garbled(t), false, t);
});

test('installed applications are found by spoken name and started detached', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  fs.mkdirSync(path.join(data, 'applications'));
  const marker = path.join(data, 'started');
  const entry = (file, lines) => fs.writeFileSync(path.join(data, 'applications', file), `[Desktop Entry]\nType=Application\n${lines}\n`);
  entry('code.desktop', `Name=Visual Studio Code\nGenericName=Text Editor\nExec=sh -c "echo code >> ${marker}" %F`);
  entry('org.gnome.Nautilus.desktop', 'Name=Files\nName[es]=Archivos\nExec=true %U');
  entry('hidden.desktop', 'Name=Hidden Thing\nNoDisplay=true\nExec=true');
  process.env.XDG_DATA_HOME = data; process.env.XDG_DATA_DIRS = path.join(data, 'none');
  const apps = require('../src/main/apps');
  if (process.platform !== 'linux') return;
  assert.equal(apps.find('Visual Studio Code').id, 'code.desktop');
  assert.equal(apps.find('vs code').id, 'code.desktop');
  assert.equal(apps.find('el Visual Studio Code').id, 'code.desktop');
  assert.equal(apps.find('archivos').id, 'org.gnome.Nautilus.desktop', 'localised names match');
  assert.equal(apps.find('hidden thing'), null, 'entries hidden from the menu are not offered');
  assert.equal(apps.find('photoshop'), null);
  assert.throws(() => apps.open('photoshop'), /couldn't find an installed app/);
  assert.equal(apps.open('Visual Studio Code'), 'Visual Studio Code');
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'code\n', 'the app was started, without its %F placeholder');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 4).join(' | ')}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
