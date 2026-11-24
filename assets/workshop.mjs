// โต๊ะทำกระทง: แผนที่ประเทศไทย + ห้องทำกระทงร่วมกัน
// เบราว์เซอร์วาดและตัดแต่งทั้งหมด เซิร์ฟเวอร์ตรวจและเก็บเฉพาะรายการแก้ไข (ops) แล้วส่งสถานะห้องให้เพื่อนในห้องเดียวกัน
import { materialNames, pieceSizes, paintBoard, paintMaterial, toLocal, hit } from './workshop-art.mjs';
import { places, insideThailand } from './workshop-map.mjs';

const $ = (s) => document.querySelector(s);
const API = '/api/workshop';
const NS = 'http://www.w3.org/2000/svg';
const KINDS = ['base', 'leaf', 'fold', 'lotus', 'marigold', 'candle'];
const ALPHA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rid = (n) => { const a = crypto.getRandomValues(new Uint8Array(n)); let s = ''; for (const b of a) s += ALPHA[b % ALPHA.length]; return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- helpers ---------------- */
let memToken = null;
function token(){
  try {
    let t = localStorage.getItem('e-kratong.token');
    if (!t || !/^[A-Za-z0-9_-]{16,128}$/.test(t)){ t = rid(36); localStorage.setItem('e-kratong.token', t); }
    return t;
  } catch (e){ return memToken || (memToken = rid(36)); }
}
async function api(method, path, body){
  const r = await fetch(API + path, {
    method, cache: 'no-store',
    headers: Object.assign({ 'X-Client-Token': token() }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, data };
}
const ERRORS = {
  rate_limited: 'ทำเร็วไปหน่อย รอสักครู่แล้วลองใหม่',
  room_gone: 'โต๊ะนี้หมดอายุหรือไม่มีอยู่แล้ว',
  outside_thailand: 'จุดนี้อยู่นอกประเทศไทย เลือกจุดในพื้นที่สีเขียว',
  blocked_words: 'มีคำที่ไม่เหมาะกับสายน้ำ ลองเขียนใหม่อีกครั้งนะ',
  piece_limit: 'วางชิ้นงานได้ไม่เกิน 64 ชิ้น',
  sticker_limit: 'สติกเกอร์เต็มแล้ว (ไม่เกิน 20 รูป หรือ 2 MB ต่อโต๊ะ)',
  already_floated: 'กระทงใบนี้ลอยไปแล้ว แก้ไขไม่ได้อีก',
  empty_craft: 'โต๊ะยังว่างอยู่ ลองวางวัสดุก่อนนะ',
  image_too_large: 'รูปใหญ่เกินไป',
  missing_token: 'เบราว์เซอร์นี้เก็บรหัสผู้ใช้ไม่ได้ ลองเปิดโหมดปกติ',
};
const errText = (d) => ERRORS[d && d.error] || 'ทำไม่สำเร็จ ลองอีกครั้งได้';
let noticeTimer = null;
function notice(msg){
  const n = $('#notice'); n.textContent = msg; n.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, 4200);
}
const placeName = (id) => (places.find((p) => p.id === id) || {}).name || 'จุดที่ปักบนแผนที่';
const coordText = (lon, lat) => lat.toFixed(3) + '°N ' + lon.toFixed(3) + '°E';
const rtf = new Intl.RelativeTimeFormat('th', { numeric: 'auto' });
function ago(ms){
  const s = (ms - Date.now()) / 1000, a = Math.abs(s);
  if (a < 60) return 'เมื่อสักครู่';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
function el(name, attrs, text){
  const e = document.createElementNS(NS, name);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}
function hashOf(s){ let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

/* ---------------- map ---------------- */
const W = 385, H = 535;
let outline = null, proj = null, loc = { lon: 100.49, lat: 13.743, place: 'chao' }, mapTimer = null;

function makeProjection(rings){
  let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
  for (const ring of rings) for (const [x, y] of ring){ minLon = Math.min(minLon, x); maxLon = Math.max(maxLon, x); minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y); }
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180), pad = 14;
  const w = (maxLon - minLon) * kx, h = maxLat - minLat, scale = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
  const ox = (W - w * scale) / 2, oy = (H - h * scale) / 2;
  return {
    to: (lon, lat) => [ox + (lon - minLon) * kx * scale, oy + (maxLat - lat) * scale],
    from: (x, y) => [(x - ox) / (scale * kx) + minLon, maxLat - (y - oy) / scale],
  };
}
let real = null;   // the MapLibre map when it could start; otherwise the SVG map is used
function setLoc(lon, lat, place){
  loc = { lon, lat, place: place || null };
  if (real) real.setLoc(lon, lat);
  const [x, y] = proj.to(lon, lat);
  $('#pin').setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')');
  $('#coordinates').textContent = coordText(lon, lat);
  $('#mapSite').value = place || 'custom';
}
function drawStaticMap(){
  const land = document.querySelector('g#land');
  land.setAttribute('fill', 'url(#landFill)'); land.setAttribute('stroke', '#9fd0b6'); land.setAttribute('stroke-width', '.9'); land.setAttribute('stroke-linejoin', 'round');
  for (const ring of outline){
    const d = ring.map(([lon, lat], i) => (i ? 'L' : 'M') + proj.to(lon, lat).map((v) => v.toFixed(1)).join(' ')).join('') + 'Z';
    land.appendChild(el('path', { d }));
  }
  const g = $('#mapPlaces'), sel = $('#mapSite');
  for (const p of places){
    const [x, y] = proj.to(p.lon, p.lat), short = p.name.split(' · ')[1] || p.name;
    const c = el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 5, fill: '#f6cd80', stroke: '#102f31', 'stroke-width': 1.5, class: 'map-choice', tabindex: 0, role: 'button', 'aria-label': 'เลือกจุดลอย ' + p.name, 'data-place': p.id });
    g.appendChild(c); g.appendChild(el('text', { x: (x + 8).toFixed(1), y: (y + 3).toFixed(1), class: 'map-label' }, short));
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  }
  const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = 'จุดที่ปักเอง'; sel.appendChild(custom);
}
function pickPlace(id){ const p = places.find((q) => q.id === id); if (p){ setLoc(p.lon, p.lat, p.id); if (real) real.flyTo(p.lon, p.lat); } }
async function initRealMap(){
  if (/[?&]map=svg\b/.test(location.search)) return;    // ?map=svg keeps the schematic map (also the fallback)
  const box = $('#realMap'); box.hidden = false;       // visible while it starts, so it measures its size
  try {
    const { createRealMap } = await import('./workshop-realmap.mjs?v=5');
    real = await createRealMap({
      container: box, outline, places,
      onPickPoint: (lon, lat) => { if (insideThailand(lon, lat, outline)) setLoc(r3(lon), r3(lat), null); else notice(ERRORS.outside_thailand); },
      onPickPlace: pickPlace, onFloat: showFloat,
      thumbUrl: (k) => API + '/floats/' + encodeURIComponent(k) + '/thumb.png', placeLabel: placeName,
    });
    $('#thaiMap').setAttribute('hidden', ''); $('#svgCredit').hidden = true;   // (SVG elements have no .hidden property)
    real.setLoc(loc.lon, loc.lat); real.setFloats(floats);
  } catch (e){ box.hidden = true; box.textContent = ''; real = null; }   // offline, no WebGL or blocked: keep the schematic map
}

let floats = [];
function drawFloats(){
  const g = $('#mapFloats'); g.textContent = '';
  floats.forEach((f, i) => {
    let [x, y] = proj.to(f.lon, f.lat);
    if (f.place !== 'pin'){ const h = hashOf(f.k), a = (h % 360) * Math.PI / 180, r = 7 + (h % 9); x += Math.cos(a) * r; y += Math.sin(a) * r; }
    const label = 'กระทงของ ' + (f.n || 'ผู้ร่วมทำ') + ' ที่ ' + placeName(f.place);
    const attrs = { class: 'float-dot', tabindex: 0, role: 'button', 'aria-label': label, 'data-k': f.k };
    if (i < 30) g.appendChild(el('image', Object.assign(attrs, { href: API + '/floats/' + f.k + '/thumb.png', x: (x - 16).toFixed(1), y: (y - 18).toFixed(1), width: 32, height: 32 })));
    else g.appendChild(el('circle', Object.assign(attrs, { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.8, fill: '#ffcc6a', stroke: '#102f31', 'stroke-width': .8 })));
  });
  if (real) real.setFloats(floats);
  const list = $('#floatList'); list.textContent = '';
  if (!floats.length){ const p = document.createElement('p'); p.className = 'fine'; p.textContent = 'ยังไม่มีกระทงบนแผนที่ มาลอยใบแรกกันเลย'; list.appendChild(p); }
  for (const f of floats.slice(0, 8)){
    const b = document.createElement('button'); b.type = 'button'; b.dataset.k = f.k;
    const a = document.createElement('span'); a.textContent = (f.n || 'ไม่ระบุชื่อ') + ' · ' + (placeName(f.place).split(' · ')[1] || placeName(f.place));
    const s = document.createElement('small'); s.textContent = ago(f.at);
    b.append(a, s); list.appendChild(b);
  }
}
async function loadMap(){
  try { const r = await fetch(API + '/map'); if (r.ok){ floats = (await r.json()).floats || []; drawFloats(); } } catch (e) {}
  try {   // total krathongs floating right now (same number as the main river)
    const r = await fetch('/log/head.json'); if (r.ok){ const h = await r.json(); if (typeof h.count === 'number') $('#floatCount').textContent = h.count.toLocaleString('th-TH'); }
  } catch (e) {}
}
/* night sky behind the map: painted once, repainted on resize */
function paintSky(){
  const cv = $('#sky'), st = $('#mapView'); if (!cv || !st || st.hidden) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = st.clientWidth, h = st.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const n = Math.round(w * h / 2600);
  for (let i = 0; i < n; i++){
    const x = rnd() * w, y = rnd() * h, big = rnd() > .965, a = .25 + rnd() * .6, t = rnd();
    c.fillStyle = 'rgba(' + (t < .6 ? '255,255,255' : t < .85 ? '205,222,255' : '255,230,200') + ',' + a.toFixed(2) + ')';
    c.beginPath(); c.arc(x, y, big ? 1.2 : .4 + rnd() * .6, 0, Math.PI * 2); c.fill();
  }
}
window.addEventListener('resize', paintSky);
async function showFloat(k){
  const r = await api('GET', '/floats/' + encodeURIComponent(k));
  if (!r.ok){ notice('กระทงใบนี้ลอยไปไกลแล้ว หาไม่เจอ'); return; }
  const d = r.data;
  $('#floatImage').src = API + '/floats/' + encodeURIComponent(k) + '/image.png';
  $('#floatPlace').textContent = placeName(d.place) + ' · ' + coordText(d.lon, d.lat);
  $('#floatWish').textContent = d.w ? '“' + d.w + '”' : '';
  $('#floatBy').textContent = (d.n ? 'ผู้ร่วมทำ: ' + d.n + ' · ' : '') + ago(d.at);
  $('#floatDetail').showModal();
}
function wireMap(){
  const svg = $('#thaiMap');
  svg.addEventListener('click', (e) => {
    const t = e.target.closest('[data-place],[data-k]');
    if (t && t.dataset.place){ pickPlace(t.dataset.place); return; }
    if (t && t.dataset.k){ showFloat(t.dataset.k); return; }
    const m = svg.getScreenCTM(); if (!m) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()), [lon, lat] = proj.from(pt.x, pt.y);
    if (insideThailand(lon, lat, outline)) setLoc(r3(lon), r3(lat), null);
    else notice(ERRORS.outside_thailand);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-place],[data-k]'); if (!t) return;
    e.preventDefault(); if (t.dataset.place) pickPlace(t.dataset.place); else showFloat(t.dataset.k);
  });
  $('#mapSite').addEventListener('change', (e) => { if (e.target.value !== 'custom') pickPlace(e.target.value); });
  $('#floatList').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) showFloat(b.dataset.k); });
  $('#refreshMap').addEventListener('click', loadMap);
  $('#closeDetail').addEventListener('click', () => $('#floatDetail').close());
  $('#createRoom').addEventListener('click', async () => {
    const b = $('#createRoom'); b.disabled = true;
    try {
      const r = await api('POST', '/rooms', { lon: loc.lon, lat: loc.lat });
      if (r.ok) location.hash = 'room=' + r.data.id; else notice(errText(r.data));
    } catch (e) { notice('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); }
    b.disabled = false;
  });
}

/* ---------------- room: shared board ---------------- */
const board = $('#board'), ctx = board.getContext('2d');
const images = new Map();
let roomId = null, S = null, es = null, selectedId = null, drag = null, cutting = false, cutPts = null;
const pending = { adds: new Map(), overrides: new Map(), removed: new Set(), busy: new Map() };
let queue = [], sending = false, painting = false;

function view(){
  if (!S) return [];
  const out = [], seen = new Set();
  for (const p of S.pieces){
    seen.add(p.id);
    if (pending.removed.has(p.id)) continue;
    const o = pending.overrides.get(p.id); out.push(o ? Object.assign({}, p, o) : p);
  }
  for (const p of pending.adds.values()) if (!seen.has(p.id)) out.push(Object.assign({}, p, pending.overrides.get(p.id) || {}));
  return out;
}
const selected = () => view().find((p) => p.id === selectedId) || null;
function schedule(){
  if (painting) return; painting = true;
  requestAnimationFrame(() => { painting = false; paintBoard(ctx, view(), images, selected(), cutting ? cutPts : null); });
}
function loadSticker(hash){
  if (images.has(hash)) return;
  const img = new Image(); img.onload = schedule;
  img.src = API + '/rooms/' + roomId + '/stickers/' + hash; images.set(hash, img);
}
function setSync(text){ $('#syncState').textContent = text; }

function applyState(s){
  if (!s || (S && s.rev < S.rev)) return;
  S = s;
  for (const p of s.pieces) if (p.kind === 'sticker' && p.asset) loadSticker(p.asset);
  if (selectedId && !view().some((p) => p.id === selectedId)) selectedId = null;
  updateUI(); schedule();
}
function updateUI(){
  const floated = !!(S && S.floated), p = selected();
  const layer = $('#layer'); layer.textContent = '';
  const list = view().slice().reverse();
  list.forEach((q, i) => {
    const o = document.createElement('option'); o.value = q.id; o.textContent = (list.length - i) + '. ' + (materialNames[q.kind] || q.kind); layer.appendChild(o);
  });
  layer.value = p ? p.id : ''; layer.disabled = floated;
  $('#pieceTools').disabled = !p || floated;
  if (p) $('#pieceSize').value = p.size;
  $('#cut').setAttribute('aria-pressed', String(cutting)); board.classList.toggle('cutting', cutting);
  $('#uncut').disabled = !p || !p.cut;
  for (const b of document.querySelectorAll('#materials button, #stickerFile')) b.disabled = floated;
  $('#openFloat').textContent = floated ? 'ดูกระทงที่ลอยแล้ว' : 'นำไปลอย';
  $('#gestureHint').textContent = floated ? 'กระทงใบนี้ลอยไปแล้ว แก้ไขไม่ได้อีก' : cutting ? 'ลากวนรอบส่วนที่อยากเก็บไว้ของชิ้นที่เลือก แล้วปล่อยนิ้ว' : 'แตะวัสดุบนโต๊ะแล้วลากเพื่อย้าย';
}

/* edits are queued and sent one at a time; the server answers with the room's latest state */
function enqueue(op){
  const last = queue[queue.length - 1];
  if (op.type === 'change' && last && last.type === 'change' && last.id === op.id) Object.assign(last.fields, op.fields);
  else { queue.push(op); pending.busy.set(op.id, (pending.busy.get(op.id) || 0) + 1); }
  pump();
}
function finishOp(op){
  const n = (pending.busy.get(op.id) || 1) - 1;
  if (n > 0){ pending.busy.set(op.id, n); return; }
  pending.busy.delete(op.id);
  if (!(drag && drag.id === op.id)) pending.overrides.delete(op.id);
  pending.adds.delete(op.id); pending.removed.delete(op.id);
}
async function sendOp(op){
  const piece = S && S.pieces.find((p) => p.id === op.id);
  if (op.type !== 'add' && !piece) return;                     // removed by a friend in the meantime
  const body = Object.assign({ opId: op.opId || (op.opId = rid(14)), id: op.id, type: op.type }, op.fields);
  if (op.type !== 'add') body.expected = piece.rev;
  for (let attempt = 0; ; attempt++){
    let r;
    try { r = await api('POST', '/rooms/' + roomId + '/ops', body); }
    catch (e){ setSync('ออฟไลน์ กำลังลองส่งอีกครั้ง…'); await sleep(Math.min(8000, 1500 * (attempt + 1))); continue; }
    if (r.status === 200){ applyState(r.data); return; }
    if (r.status === 409 && r.data && r.data.state){
      applyState(r.data.state);
      if (r.data.error === 'piece_changed'){ pending.overrides.delete(op.id); notice('เพื่อนแก้ชิ้นนี้พร้อมกัน จึงใช้ค่าล่าสุดแทน'); }
      else if (r.data.error === 'already_floated') notice(ERRORS.already_floated);
      return;
    }
    if (r.status === 429){ await sleep(1200); continue; }
    notice(errText(r.data)); return;
  }
}
async function pump(){
  if (sending) return; sending = true;
  while (queue.length){
    const op = queue.shift();
    try { await sendOp(op); } catch (e) {}
    finishOp(op); updateUI(); schedule();
  }
  sending = false;
}
const drain = async () => { for (let i = 0; i < 100 && (sending || queue.length); i++) await sleep(50); };

function change(id, fields){
  pending.overrides.set(id, Object.assign(pending.overrides.get(id) || {}, fields));
  enqueue({ type: 'change', id, fields: Object.assign({}, fields) }); schedule();
}
function addPiece(kind, asset){
  if (!S || S.floated) return;
  if (view().length >= 64){ notice(ERRORS.piece_limit); return; }
  const id = rid(12), j = () => (Math.random() - .5) * 20;
  const fields = { kind, x: r3(clamp(50 + j(), 10, 90)), y: r3(clamp(50 + j(), 10, 90)), size: pieceSizes[kind] };
  if (asset) fields.asset = asset;
  pending.adds.set(id, Object.assign({ id, angle: 0, rev: 0 }, fields));
  selectedId = id; enqueue({ type: 'add', id, fields }); updateUI(); schedule();
}
function removePiece(id){
  pending.removed.add(id); if (selectedId === id) selectedId = null;
  enqueue({ type: 'remove', id, fields: {} }); updateUI(); schedule();
}

/* pointer: move pieces, or draw a cut outline */
function boardPoint(e){
  const r = board.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * 100, (e.clientY - r.top) / r.height * 100];
}
const capture = (e) => { try { board.setPointerCapture(e.pointerId); } catch (err) {} };
board.addEventListener('pointerdown', (e) => {
  if (!S || S.floated) return;
  const [x, y] = boardPoint(e), cur = selected();
  if (cutting && cur){
    cutPts = [toLocal(cur, x, y)]; drag = { id: cur.id, cut: true }; capture(e); e.preventDefault(); return;
  }
  const list = view();
  for (let i = list.length - 1; i >= 0; i--){
    if (hit(list[i], x, y)){
      selectedId = list[i].id; drag = { id: list[i].id, dx: x - list[i].x, dy: y - list[i].y, last: 0, moved: false };
      capture(e); e.preventDefault(); updateUI(); schedule(); return;
    }
  }
  selectedId = null; updateUI(); schedule();
});
board.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = boardPoint(e);
  if (drag.cut){
    const cur = selected(); if (!cur) return;
    const q = toLocal(cur, x, y), l = cutPts[cutPts.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) > .012 && cutPts.length < 400) cutPts.push(q);
    schedule(); return;
  }
  drag.moved = true;
  const nx = r3(clamp(x - drag.dx, 0, 100)), ny = r3(clamp(y - drag.dy, 0, 100));
  pending.overrides.set(drag.id, Object.assign(pending.overrides.get(drag.id) || {}, { x: nx, y: ny }));
  const now = performance.now();
  if (now - drag.last > 200){ drag.last = now; enqueue({ type: 'change', id: drag.id, fields: { x: nx, y: ny } }); }
  schedule();
});
function endPointer(){
  if (!drag) return;
  const d = drag; drag = null;
  if (d.cut){ finishCut(d.id); return; }
  const o = pending.overrides.get(d.id);
  if (d.moved && o) enqueue({ type: 'change', id: d.id, fields: { x: o.x, y: o.y } });
  else if (!pending.busy.get(d.id)) pending.overrides.delete(d.id);
}
board.addEventListener('pointerup', endPointer);
board.addEventListener('pointercancel', endPointer);

function finishCut(id){
  const raw = cutPts || []; cutPts = null; cutting = false;
  const pts = [];
  for (const q of raw){ const c = [r3(clamp(q[0], -.5, .5)), r3(clamp(q[1], -.5, .5))], l = pts[pts.length - 1]; if (!l || Math.hypot(c[0] - l[0], c[1] - l[1]) > .03) pts.push(c); }
  let out = pts;
  if (pts.length > 48){ out = []; for (let i = 0; i < 48; i++) out.push(pts[Math.floor(i * pts.length / 48)]); }
  let area = 0; for (let i = 0; i < out.length; i++){ const a = out[i], b = out[(i + 1) % out.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (out.length < 3 || Math.abs(area) / 2 < .004){ notice('ลากให้เป็นวงปิดใหญ่กว่านี้อีกนิด'); updateUI(); schedule(); return; }
  change(id, { cut: out }); updateUI();
}
$('#cut').addEventListener('click', () => {
  if (!selected()){ notice('เลือกชิ้นงานก่อน แล้วค่อยกดตัดรูปทรง'); return; }
  cutting = !cutting; cutPts = null; updateUI(); schedule();
});
$('#uncut').addEventListener('click', () => { const p = selected(); if (p){ change(p.id, { cut: null }); updateUI(); } });
$('#layer').addEventListener('change', (e) => { selectedId = e.target.value || null; updateUI(); schedule(); });
$('#pieceSize').addEventListener('input', (e) => { const p = selected(); if (p) change(p.id, { size: clamp(Number(e.target.value), 6, 82) }); });
const turn = (deg) => { const p = selected(); if (p) change(p.id, { angle: r3(((p.angle + deg + 180) % 360 + 360) % 360 - 180) }); };
$('#left').addEventListener('click', () => turn(-15));
$('#right').addEventListener('click', () => turn(15));
$('#front').addEventListener('click', () => { const p = selected(); if (p) enqueue({ type: 'front', id: p.id, fields: {} }); });
$('#back').addEventListener('click', () => { const p = selected(); if (p) enqueue({ type: 'back', id: p.id, fields: {} }); });
$('#remove').addEventListener('click', () => { const p = selected(); if (p) removePiece(p.id); });
board.addEventListener('keydown', (e) => {
  const p = selected(); if (!p || !S || S.floated) return;
  const step = e.shiftKey ? 5 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]){ e.preventDefault(); change(p.id, { x: r3(clamp(p.x + moves[e.key][0], 0, 100)), y: r3(clamp(p.y + moves[e.key][1], 0, 100)) }); }
  else if (e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); removePiece(p.id); }
  else if (e.key === '+' || e.key === '='){ change(p.id, { size: clamp(p.size + 2, 6, 82) }); }
  else if (e.key === '-'){ change(p.id, { size: clamp(p.size - 2, 6, 82) }); }
  else if (e.key === 'Escape' && cutting){ cutting = false; cutPts = null; updateUI(); schedule(); }
});

/* materials tray and stickers from this device */
function buildTray(){
  const box = $('#materials'); box.textContent = '';
  for (const kind of KINDS){
    const b = document.createElement('button'); b.type = 'button'; b.dataset.kind = kind;
    const c = document.createElement('canvas'); c.width = c.height = 48; c.setAttribute('aria-hidden', 'true');
    const g = c.getContext('2d'); g.setTransform(40, 0, 0, 40, 24, 24); paintMaterial(g, kind);
    b.append(c, document.createTextNode(materialNames[kind])); b.addEventListener('click', () => addPiece(kind)); box.appendChild(b);
  }
}
async function toSticker(file){
  const bmp = await createImageBitmap(file);
  try {
    for (const side of [192, 160, 128, 96, 64]){
      const sc = Math.min(1, side / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');
      if ((url.length - 22) * 0.75 <= 150 * 1024) return url;
    }
  } finally { bmp.close && bmp.close(); }
  throw new Error('too_complex');
}
$('#stickerFile').addEventListener('change', async (e) => {
  const input = e.target, file = input.files && input.files[0]; input.value = '';
  if (!file || !S || S.floated) return;
  if (file.size > 15 * 1024 * 1024){ notice('ไฟล์ใหญ่เกิน 15 MB'); return; }
  notice('กำลังเตรียมสติกเกอร์…');
  try {
    const url = await toSticker(file);
    const r = await api('POST', '/rooms/' + roomId + '/stickers', { image: url });
    if (!r.ok){ notice(errText(r.data)); return; }
    const img = new Image(); img.onload = schedule; img.src = url; images.set(r.data.asset, img);
    addPiece('sticker', r.data.asset); notice('แปะสติกเกอร์แล้ว เพื่อนในโต๊ะจะเห็นรูปนี้ด้วย');
  } catch (err){ notice('เปิดรูปนี้ไม่ได้ ลองไฟล์ PNG, JPG หรือ WebP อื่น'); }
});

/* invite */
$('#invite').addEventListener('click', async () => {
  const url = location.origin + location.pathname + '#room=' + roomId, box = $('#copyBox'), input = $('#inviteUrl');
  box.hidden = false; input.value = url; input.select();
  try { await navigator.clipboard.writeText(url); notice('คัดลอกลิงก์แล้ว ส่งให้เพื่อนได้เลย'); } catch (e) { notice('กดคัดลอกลิงก์ในช่องด้านล่างได้เลย'); }
});

/* float: pick a place, add a wish, publish the picture of the finished krathong */
function snapshot(size, maxBytes){
  for (const s of [size, Math.round(size * .75), Math.round(size * .6)]){
    const c = document.createElement('canvas'); c.width = c.height = s;
    paintBoard(c.getContext('2d'), view(), images, null, null);
    const url = c.toDataURL('image/png');
    if ((url.length - 22) * 0.75 <= maxBytes) return url;
  }
  throw new Error('image_too_large');
}
function releaseOptions(){
  const sel = $('#releaseSite'); sel.textContent = '';
  const named = places.find((p) => Math.abs(p.lon - S.lon) < .002 && Math.abs(p.lat - S.lat) < .002);
  for (const p of places){ const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
  if (!named){ const o = document.createElement('option'); o.value = 'room'; o.textContent = 'จุดที่ปักไว้ · ' + coordText(S.lon, S.lat); sel.appendChild(o); }
  sel.value = named ? named.id : 'room';
}
$('#openFloat').addEventListener('click', async () => {
  if (!S) return;
  if (S.floated){ showFloat(S.floated); return; }
  await drain(); releaseOptions();
  $('#releaseError').hidden = true;
  paintBoard($('#finalPreview').getContext('2d'), view(), images, null, null);
  $('#release').showModal();
});
$('#cancelRelease').addEventListener('click', () => $('#release').close());
$('#releaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#releaseButton'), err = $('#releaseError'); err.hidden = true; btn.disabled = true;
  try {
    await drain();
    const v = $('#releaseSite').value, p = places.find((q) => q.id === v);
    const body = { rev: S.rev, lon: p ? p.lon : S.lon, lat: p ? p.lat : S.lat, n: $('#by').value.trim(), w: $('#wish').value.trim(), image: snapshot(256, 270 * 1024), thumb: snapshot(64, 26 * 1024) };
    const r = await api('POST', '/rooms/' + roomId + '/float', body);
    if (r.status === 201 || (r.status === 200 && r.data && r.data.k)){
      $('#release').close(); S = Object.assign({}, S, { floated: r.data.k }); updateUI();
      notice('กระทงของพวกเราลอยแล้ว'); showFloat(r.data.k);
    } else if (r.status === 409 && r.data && r.data.state){
      applyState(r.data.state); err.textContent = 'มีคนแก้กระทงระหว่างที่กำลังลอย ตรวจดูอีกครั้งแล้วกดลอยใหม่'; err.hidden = false;
    } else { err.textContent = errText(r.data); err.hidden = false; }
  } catch (x){ err.textContent = 'ลอยไม่สำเร็จ ลองอีกครั้งได้'; err.hidden = false; }
  btn.disabled = false;
});

/* open / leave a room */
function closeRoom(){
  if (es){ es.close(); es = null; }
  roomId = null; S = null; selectedId = null; cutting = false; cutPts = null; drag = null;
  queue = []; images.clear(); pending.adds.clear(); pending.overrides.clear(); pending.removed.clear(); pending.busy.clear();
}
async function openRoom(id){
  closeRoom(); roomId = id; clearInterval(mapTimer);
  $('#mapView').hidden = true; $('#roomView').hidden = false; $('#copyBox').hidden = true; setSync('กำลังเปิดโต๊ะ…');
  let r;
  try { r = await api('GET', '/rooms/' + id); } catch (e){ setSync('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'); return; }
  if (!r.ok){ notice(errText(r.data)); location.hash = ''; return; }
  applyState(r.data); schedule();
  es = new EventSource(API + '/rooms/' + id + '/events');
  es.onmessage = (m) => { try { applyState(JSON.parse(m.data)); } catch (e) {} setSync(S && S.floated ? 'กระทงใบนี้ลอยแล้ว' : 'ซิงก์กับเพื่อนในโต๊ะแล้ว · แก้ไขแล้วเห็นพร้อมกัน'); };
  es.onerror = () => { if (es && es.readyState === 2){ notice(ERRORS.room_gone); location.hash = ''; } else setSync('ขาดการเชื่อมต่อ กำลังต่อใหม่…'); };
  setSync('ซิงก์กับเพื่อนในโต๊ะแล้ว · แก้ไขแล้วเห็นพร้อมกัน');
}
function showMap(){
  closeRoom(); $('#roomView').hidden = true; $('#mapView').hidden = false;
  paintSky(); if (real) real.resize(); loadMap(); clearInterval(mapTimer);
  mapTimer = setInterval(() => { if (!document.hidden) loadMap(); }, 20000);
}
function route(){
  const m = /^#room=([A-Za-z0-9_-]{24})$/.exec(location.hash);
  if (m) openRoom(m[1]); else showMap();
}

/* ---------------- start ---------------- */
buildTray();
try {
  outline = await (await fetch('assets/thailand-outline.json')).json();
  proj = makeProjection(outline); drawStaticMap(); wireMap(); setLoc(100.49, 13.743, 'chao');
} catch (e){ notice('โหลดแผนที่ไม่สำเร็จ ลองรีเฟรชหน้านี้'); }
window.addEventListener('hashchange', route);
route();
if (outline) initRealMap();   // after the first screen is up; the SVG map shows meanwhile
