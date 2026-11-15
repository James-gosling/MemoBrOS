// Minimal 5-field cron (minute hour day-of-month month day-of-week). Users never write these:
// the model turns "every Tuesday at 5 PM" into one, and MemoBrOS shows the plain-language version.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(src, [lo, hi]) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Bad cron field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    let a = lo, b = hi;
    if (m[1] !== '*') { [a, b] = m[1].split('-').map(Number); if (b === undefined) b = m[2] ? hi : a; }
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`Cron field "${src}" out of range`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs five fields');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}
const valid = (expr) => { try { parse(expr); return true; } catch { return false; } };

// First time strictly after `from` (local time) that matches, or null if none within two years.
function next(expr, from = new Date()) {
  const c = parse(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 2 * 366 * 86400000;
  while (d.getTime() < limit) {
    const dayOk = c.domAny || c.dowAny ? (c.dom.has(d.getDate()) && c.dow.has(d.getDay())) : (c.dom.has(d.getDate()) || c.dow.has(d.getDay()));
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d;
  }
  return null;
}

module.exports = { parse, valid, next };
