// The transparent, click-through layer above every app: Memo's cursor buddy, annotations and captions.
const SVG = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const ink = $('ink'), buddy = $('buddy'), label = $('label'), badge = $('badge'), caption = $('caption');

const HOME = { x: 14, y: 16 };            // where the buddy sits relative to the real cursor
let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
let pos = { ...mouse };
let flight = null;                        // { from, to, ctrl, t0, dur } — bezier flight to a pointed target
let pointUntil = 0, pointAt = null;
let captionTimer = null, inkTimer = null;

const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

function fly(to) {
  const from = { ...pos };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  flight = { from, to, ctrl: { x: mid.x, y: mid.y - Math.min(160, dist * 0.35) }, t0: performance.now(), dur: Math.min(900, 350 + dist * 0.6) };
}

function frame(now) {
  if (flight) {
    const t = Math.min(1, (now - flight.t0) / flight.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const { from, to, ctrl } = flight;
    pos.x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * ctrl.x + e * e * to.x;
    pos.y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * ctrl.y + e * e * to.y;
    if (t === 1) flight = null;
  } else if (pointAt && now < pointUntil) {
    pos.x = pointAt.x; pos.y = pointAt.y + Math.sin(now / 260) * 2.5; // gentle bob while pointing
  } else {
    if (pointAt) { pointAt = null; buddy.classList.remove('pointing'); label.classList.remove('on'); }
    const tx = mouse.x + HOME.x, ty = mouse.y + HOME.y;
    pos.x += (tx - pos.x) * 0.22; pos.y += (ty - pos.y) * 0.22;
  }
  buddy.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  // Caption floats next to the buddy, flipped when it would leave the screen.
  const cw = caption.offsetWidth, ch = caption.offsetHeight;
  let cx = pos.x + 62, cy = pos.y + 56;
  if (cx + cw > innerWidth - 8) cx = pos.x - cw - 10;
  if (cy + ch > innerHeight - 8) cy = pos.y - ch - 10;
  caption.style.transform = `translate(${Math.max(8, cx)}px, ${Math.max(8, cy)}px)`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function point({ x, y, label: text }) {
  pointAt = { x, y };
  pointUntil = performance.now() + 9000;
  fly(pointAt);
  buddy.classList.add('pointing');
  label.textContent = text || '';
  label.classList.toggle('on', !!text);
}

function pathFor(s) {
  const { x, y } = s;
  const x2 = s.x2 ?? x + 60, y2 = s.y2 ?? y;
  if (s.type === 'circle') {
    const cx = (x + (s.x2 ?? x)) / 2, cy = (y + (s.y2 ?? y)) / 2;
    const rx = s.x2 == null ? 28 : Math.abs(x2 - x) / 2 + 8, ry = s.y2 == null ? 28 : Math.abs(y2 - y) / 2 + 8;
    return { d: `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy}`, labelAt: { x: cx - rx, y: cy - ry - 8 } };
  }
  if (s.type === 'box') {
    const l = Math.min(x, x2) - 5, t = Math.min(y, y2) - 5, r = Math.max(x, x2) + 5, b = Math.max(y, y2) + 5;
    return { d: `M ${l} ${t} H ${r} V ${b} H ${l} Z`, labelAt: { x: l, y: t - 8 } };
  }
  if (s.type === 'underline') return { d: `M ${x} ${y + 3} Q ${(x + x2) / 2} ${(y + y2) / 2 + 9} ${x2} ${y2 + 3}`, labelAt: { x, y: Math.max(y, y2) + 24 } };
  if (s.type === 'arrow') return { d: `M ${x} ${y} L ${x2} ${y2}`, labelAt: { x: x + 8, y: y - 8 }, head: { x: x2, y: y2, a: Math.atan2(y2 - y, x2 - x) } };
  return { d: null, labelAt: { x, y } };
}

function draw(shapes) {
  clearTimeout(inkTimer);
  const g = el('g', {}, ink);
  shapes.forEach((s, i) => {
    const p = pathFor(s);
    if (p.d) {
      for (const cls of ['halo draw', 'stroke draw']) {
        const path = el('path', { d: p.d, class: cls }, g);
        path.style.setProperty('--len', Math.ceil(path.getTotalLength()) + 2);
        path.style.animationDelay = `${i * 0.15}s`;
      }
    }
    if (p.head) {
      const { x, y, a } = p.head, L = 16, w = 0.45;
      const pts = [[x, y], [x - L * Math.cos(a - w), y - L * Math.sin(a - w)], [x - L * Math.cos(a + w), y - L * Math.sin(a + w)]];
      el('polygon', { points: pts.map((q) => q.join(',')).join(' '), class: 'head' }, g);
    }
    if (s.label) {
      const t = el('text', { x: Math.max(6, p.labelAt.x), y: Math.max(18, p.labelAt.y) }, g);
      t.textContent = s.label;
    }
  });
  inkTimer = setTimeout(clearInk, 45000);
}
function clearInk() {
  for (const g of [...ink.children]) { g.classList.add('fade'); setTimeout(() => g.remove(), 650); }
}

function showCaption(text, sticky) {
  clearTimeout(captionTimer);
  caption.textContent = text || '';
  caption.classList.toggle('on', !!text);
  if (text && !sticky) captionTimer = setTimeout(() => caption.classList.remove('on'), Math.min(20000, 3500 + text.length * 70));
}

const BADGES = { listening: 'Listening…', dictating: 'Dictating', thinking: '', acting: 'Agent' };
function setStatus(kind, text) {
  buddy.dataset.status = kind;
  const t = text || BADGES[kind] || '';
  badge.textContent = t;
  badge.classList.toggle('on', !!t);
}

window.memo.on((e) => {
  if (e.type === 'cursor') mouse = { x: e.x, y: e.y };
  else if (e.type === 'point') point(e);
  else if (e.type === 'draw') draw(e.shapes);
  else if (e.type === 'clear') { clearInk(); pointUntil = 0; }
  else if (e.type === 'caption') showCaption(e.text, e.sticky);
  else if (e.type === 'status') setStatus(e.kind, e.text);
  else if (e.type === 'ripple') {
    const r = document.createElement('div');
    r.className = 'ripple'; r.style.left = `${e.x}px`; r.style.top = `${e.y}px`;
    $('ripples').appendChild(r); setTimeout(() => r.remove(), 750);
  }
});
