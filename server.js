'use strict';
/*
 * E-Kratong server
 * Zero dependencies: Node.js 22.13+ (built-in node:sqlite), nothing to npm install.
 *
 * Who does what
 *  - The viewer's device does nearly everything: drawing and animating the river, krathongs,
 *    sky lanterns, stars and sparkles; assembling the river from the event log (newest first,
 *    at most 3 per person, last 48 h); counting blessings; spotting new arrivals; the
 *    synchronized lantern moment (worked out from the clock).
 *  - The server does only what a browser cannot be trusted with: it checks and stores writes
 *    (rate limits, word filter, ownership, one blessing per person) and appends every accepted
 *    change to an event log.
 *
 * The event log (/log/)
 *  - Accepted changes are buffered and sealed once a second into an immutable segment file.
 *  - Every 15 seconds with changes (or after 8 segments), a checkpoint holds the current river.
 *  - head.json (a few hundred bytes) names the latest checkpoint and the segments after it.
 *  - Browsers poll head.json every few seconds (ETag, so usually a tiny 304) and fetch only new
 *    segments. Segments and checkpoints never change, so browsers, nginx or a CDN can cache them
 *    forever, and nginx can serve the whole log folder without touching Node (see README).
 *  - Memory stays bounded: the river (300 items), the last ~2 minutes of log files, counters.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { setupWorkshop } = require('./workshop-server.cjs');

/* ---------------- config (environment variables) ---------------- */
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v))) ? d : Number(v);
const CONFIG = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dbFile: env.DB_FILE || path.join(__dirname, 'data', 'e-kratong.db'),
  pageFile: env.PAGE_FILE || path.join(__dirname, 'index.html'),
  windowHours: num(env.WINDOW_HOURS, 48),   // how long a krathong stays on the river
  riverSize: Math.max(0, Math.trunc(num(env.RIVER_SIZE, 300))),
  perPerson: Math.max(0, Math.trunc(num(env.PER_PERSON, 3))),
  maxPerOwner: num(env.MAX_PER_OWNER, 12),  // stored per person inside the window
  sealMs: num(env.SEAL_MS, 1000),           // how often buffered changes become a log segment
  checkpointMs: num(env.CHECKPOINT_MS, 15000),
  checkpointSegs: Math.max(1, Math.trunc(num(env.CHECKPOINT_SEGS, 8))),
  segMaxNew: Math.max(0, Math.trunc(num(env.SEG_MAX_NEW, 25))),
  logDir: env.LOG_DIR || path.join(path.dirname(env.DB_FILE || path.join(__dirname, 'data', 'e-kratong.db')), 'log'),
  onlineCount: env.ONLINE_COUNT !== 'off',  // turn off when nginx/CDN serves /log/ (Node no longer sees the polls)
  rateLimit: env.RATE_LIMIT !== 'off',
  trustProxy: env.TRUST_PROXY === '1',      // set when running behind nginx / a load balancer
  adminToken: env.ADMIN_TOKEN || '',
  publicUrl: env.PUBLIC_URL || '',          // link encoded in the big-screen QR code (auto-detected if empty)
  moments: (env.MOMENTS || '19:00,20:00,21:00,22:00').split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s)),
  reportHide: num(env.REPORT_HIDE, 3),      // reports from this many different people hide a krathong
};
const TYPES = ['suchada', 'pratheep', 'naga', 'saphao', 'lantern'];
const PLEDGES = ['litter', 'plastic', 'natural', 'family', 'water'];
const KEY_RE = /^[A-Za-z0-9_-]{4,24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/* ---------------- database ---------------- */
fs.mkdirSync(path.dirname(CONFIG.dbFile), { recursive: true });
const db = new DatabaseSync(CONFIG.dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS krathongs (
    k TEXT PRIMARY KEY,
    t TEXT NOT NULL,
    w TEXT NOT NULL DEFAULT '',
    n TEXT NOT NULL DEFAULT '',
    p INTEGER NOT NULL DEFAULT 0,
    owner TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS krathongs_at ON krathongs(at);
  CREATE INDEX IF NOT EXISTS krathongs_owner_at ON krathongs(owner, at);
  CREATE TABLE IF NOT EXISTS pledges (
    owner TEXT NOT NULL,
    pid TEXT NOT NULL,
    PRIMARY KEY (owner, pid)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS blessings (
    k TEXT NOT NULL,
    owner TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (k, owner)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS blessings_at ON blessings(at);
  CREATE TABLE IF NOT EXISTS reports (
    k TEXT NOT NULL,
    owner TEXT NOT NULL,
    iph TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (k, owner)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS reports_at ON reports(at);
`);
{ // columns added after the first release
  const cols = db.prepare('PRAGMA table_info(krathongs)').all().map((c) => c.name);
  if (!cols.includes('b')) db.exec('ALTER TABLE krathongs ADD COLUMN b INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('hidden')) db.exec('ALTER TABLE krathongs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('craft')) db.exec('ALTER TABLE krathongs ADD COLUMN craft INTEGER NOT NULL DEFAULT 0');
}
const Q = {
  insert: db.prepare('INSERT INTO krathongs (k, t, w, n, p, owner, at, craft) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  exists: db.prepare('SELECT 1 AS x FROM krathongs WHERE k = ?'),
  byKey: db.prepare('SELECT k, t, w, n, p, owner, at, b, hidden FROM krathongs WHERE k = ?'),
  del: db.prepare('DELETE FROM krathongs WHERE k = ?'),
  ownerRecent: db.prepare('SELECT k, hidden FROM krathongs WHERE owner = ? AND at >= ? ORDER BY at DESC, rowid DESC'),
  river: db.prepare(`
    SELECT k, t, w, n, p, owner, at, b, craft FROM krathongs
    WHERE at >= ? AND hidden = 0 ORDER BY at DESC, rowid DESC`),
  count: db.prepare('SELECT COUNT(*) AS c FROM krathongs WHERE at >= ? AND hidden = 0'),
  expire: db.prepare('DELETE FROM krathongs WHERE k IN (SELECT k FROM krathongs WHERE at < ? LIMIT 5000)'),
  pledgesOf: db.prepare('SELECT pid FROM pledges WHERE owner = ?'),
  pledgeAdd: db.prepare('INSERT OR IGNORE INTO pledges (owner, pid) VALUES (?, ?)'),
  pledgeDel: db.prepare('DELETE FROM pledges WHERE owner = ? AND pid = ?'),
  pledgeTotals: db.prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT owner) AS people FROM pledges'),
  blessAdd: db.prepare('INSERT OR IGNORE INTO blessings (k, owner, at) VALUES (?, ?, ?)'),
  blessInc: db.prepare('UPDATE krathongs SET b = b + 1 WHERE k = ?'),
  blessDelFor: db.prepare('DELETE FROM blessings WHERE k = ?'),
  blessExpire: db.prepare('DELETE FROM blessings WHERE at < ?'),
  reportAdd: db.prepare('INSERT OR IGNORE INTO reports (k, owner, iph, at) VALUES (?, ?, ?, ?)'),
  reportPeople: db.prepare('SELECT COUNT(DISTINCT iph) AS c FROM reports WHERE k = ?'),
  reportDelFor: db.prepare('DELETE FROM reports WHERE k = ?'),
  reportExpire: db.prepare('DELETE FROM reports WHERE at < ?'),
  hide: db.prepare('UPDATE krathongs SET hidden = 1 WHERE k = ?'),
};
function tx(fn){
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e){ db.exec('ROLLBACK'); throw e; }
}

/* ---------------- bounded in-memory state ---------------- */
const state = { river: [], count: 0, pledgeTotal: 0, pledgePeople: 0, momentAt: 0, online: null };
const since = () => Date.now() - CONFIG.windowHours * 3600e3;
const shortId = (owner) => owner.slice(0, 16);
const publicItem = (r) => ({ k: r.k, t: r.t, w: r.w, n: r.n, p: r.p, at: r.at, b: Number(r.b) || 0, o: shortId(r.owner), ...(r.craft ? {craft:1} : {}) });

function rebuildRiver(){
  const river = [], perOwner = new Map();
  if (CONFIG.riverSize && CONFIG.perPerson){
    for (const row of Q.river.iterate(since())){
      const used = perOwner.get(row.owner) || 0;
      if (used >= CONFIG.perPerson) continue;
      river.push(publicItem(row));
      perOwner.set(row.owner, used + 1);
      if (river.length === CONFIG.riverSize) break;
    }
  }
  state.river = river;
}
function refillRiver(){
  const size = state.river.length;
  rebuildRiver();
  // A delete can uncover an older row that viewers have never received.
  if (state.river.length > size) logEvent({ e: 'refill' });
}
function recount(){
  state.count = Number(Q.count.get(since()).c);
  const t = Q.pledgeTotals.get();
  state.pledgeTotal = Number(t.total); state.pledgePeople = Number(t.people);
}
function addToRiver(item){
  state.river.unshift(item);
  let mine = 0;
  for (let i = 0; i < state.river.length; i++){
    if (state.river[i].o !== item.o) continue;
    if (++mine > CONFIG.perPerson){ state.river.splice(i, 1); i--; }
  }
  if (state.river.length > CONFIG.riverSize) state.river.length = CONFIG.riverSize;
}
function removeFromRiver(k){
  const i = state.river.findIndex((x) => x.k === k);
  if (i === -1) return false;
  state.river.splice(i, 1); return true;
}

/* ---------------- event log ---------------- */
const EPOCH = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');   // new per start: browsers reload a checkpoint
fs.mkdirSync(CONFIG.logDir, { recursive: true });
for (const f of fs.readdirSync(CONFIG.logDir)){ if (/^(seg-|cp-|head\.json)/.test(f)){ try { fs.unlinkSync(path.join(CONFIG.logDir, f)); } catch (e) {} } }
const log = { seq: 0, cp: 0, segs: [], buffer: [], files: new Map(), head: null, headDirty: true,
  lastIncomplete: 0, repairThrough: 0, expiredThrough: 0 };
const markHead = () => { log.headDirty = true; };
function etagOf(buf){ return '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16) + '"'; }
// Publish immutable files before the head that names them; serialize renames of head.json.
let diskWrites = Promise.resolve();
function writeAtomic(name, buf){
  const file = path.join(CONFIG.logDir, name), tmp = file + '.tmp';
  diskWrites = diskWrites.then(async () => {
    if (name === 'head.json' && buf !== log.head.body) return;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  }).catch(err => console.error('[log] could not publish ' + name, err.message));
}
function putFile(name, obj){
  const body = Buffer.from(JSON.stringify(obj)), gz = zlib.gzipSync(body);
  const f = { body, gz, etag: etagOf(body) };
  log.files.set(name, f);
  // Also on disk, so nginx/CDN can serve /log/ as static files (plain + .gz for gzip_static)
  writeAtomic(name, body); writeAtomic(name + '.gz', gz);
  return f;
}
function dropFile(name){
  log.files.delete(name);
  fs.unlink(path.join(CONFIG.logDir, name), () => {}); fs.unlink(path.join(CONFIG.logDir, name + '.gz'), () => {});
}
const segName = (s) => 'seg-' + EPOCH + '-' + s + '.json';
const cpName = (s) => 'cp-' + EPOCH + '-' + s + '.json';
function logEvent(ev){ log.buffer.push(ev); }
function compact(events){
  // Keep segments small however busy it gets: drop krathongs removed within the same second, keep only
  // the newest SEG_MAX_NEW new krathongs (the rest are stored and appear in the next checkpoint),
  // and keep only the latest blessing count per krathong.
  const added = new Map(), removed = new Set(), bless = new Map();
  let refill = false;
  for (const event of events){
    const k = event.k;
    switch (event.e){
      case 'k': removed.delete(k); bless.delete(k); added.delete(k); added.set(k, event); break;
      case 'x': added.delete(k); bless.delete(k); removed.add(k); break;
      case 'b': bless.set(k, event); break;
      case 'refill': refill = true; break;
    }
  }
  const adds = Array.from(added.values()), skipped = Math.max(0, adds.length - CONFIG.segMaxNew);
  return {
    incomplete: skipped > 0 || refill,
    ev: adds.slice(skipped).concat(Array.from(removed, (k) => ({ e: 'x', k })), Array.from(bless.values())),
  };
}
function seal(){
  if (!log.buffer.length) return;
  log.seq++;
  const segment = compact(log.buffer);
  if (segment.incomplete) log.lastIncomplete = log.seq;
  putFile(segName(log.seq), { seq: log.seq, ...segment });
  log.buffer = []; log.segs.push(log.seq); markHead();
}
function checkpoint(){
  seal();
  if (log.cp === log.seq && log.files.has(cpName(log.seq))) return;
  const oldCp = log.cp, oldSegs = log.segs;
  putFile(cpName(log.seq), { seq: log.seq, items: state.river });
  log.cp = log.seq; log.repairThrough = log.lastIncomplete; log.segs = []; markHead();
  // Keep the previous checkpoint and its segments for 2 minutes so browsers mid-sync can finish
  if (oldCp !== log.cp) setTimeout(() => {
    dropFile(cpName(oldCp));
    for (const s of oldSegs) dropFile(segName(s));
    log.expiredThrough = Math.max(log.expiredThrough, oldSegs.at(-1) || 0);
    markHead();
  }, 120000).unref();
}
function head(){
  if (log.headDirty || !log.head){
    const body = Buffer.from(JSON.stringify({
      v: 1, epoch: EPOCH, seq: log.seq, cp: log.cp, segs: log.segs,
      repairThrough: log.repairThrough, replayAfter: Math.max(log.expiredThrough, log.seq - CONFIG.checkpointSegs),
      riverSize: CONFIG.riverSize, perPerson: CONFIG.perPerson,
      count: state.count, online: CONFIG.onlineCount ? state.online : null,
      pledges: { total: state.pledgeTotal, people: state.pledgePeople },
      moments: CONFIG.moments, momentAt: state.momentAt > Date.now() ? state.momentAt : 0, windowHours: CONFIG.windowHours,
    }));
    log.head = { body, gz: zlib.gzipSync(body), etag: etagOf(body) };
    writeAtomic('head.json', body);
    log.headDirty = false;
  }
  return log.head;
}
setInterval(() => {
  seal();
  if (log.segs.length >= CONFIG.checkpointSegs) checkpoint();
  if (log.headDirty) head();
}, CONFIG.sealMs);
setInterval(() => { if (log.segs.length || log.buffer.length){ checkpoint(); head(); } }, CONFIG.checkpointMs);

/* Online count: distinct pollers of head.json in the last 20 s (only meaningful while Node serves /log/) */
const pollers = new Map();
function trackPoller(req){
  if (!CONFIG.onlineCount) return;
  if (pollers.size > 100000) pollers.clear();
  pollers.set(ipHash(clientIp(req)) + (req.headers['user-agent'] || '').length, Date.now());
}
setInterval(() => {
  if (!CONFIG.onlineCount) return;
  const cut = Date.now() - 20000;
  for (const [k, t] of pollers) if (t < cut) pollers.delete(k);
  if (state.online !== pollers.size){ state.online = pollers.size; markHead(); }
}, 10000);

/* ---------------- rate limiting (token buckets, bounded) ---------------- */
const buckets = new Map();
function allow(key, burst, perSec){
  if (!CONFIG.rateLimit) return true;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b){
    if (buckets.size > 100000) buckets.clear();
    b = { tokens: burst, ts: now }; buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + (now - b.ts) / 1000 * perSec); b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}
setInterval(() => { const cut = Date.now() - 10 * 60e3; for (const [k, b] of buckets) if (b.ts < cut) buckets.delete(k); }, 60e3);

/* ---------------- helpers ---------------- */
function clientIp(req){
  if (CONFIG.trustProxy){ const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}
function ownerOf(req){
  const t = req.headers['x-client-token'];
  if (typeof t !== 'string' || !TOKEN_RE.test(t)) return null;
  return crypto.createHash('sha256').update(t).digest('hex');   // the raw token is never stored
}
function isAdmin(req){
  const a = req.headers['x-admin-token'];
  if (!CONFIG.adminToken || typeof a !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(CONFIG.adminToken);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
function cleanText(v, max){
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  let out = '', n = 0;
  for (const g of graphemes.segment(s)){ if (++n > max) break; out += g.segment; }
  return out;
}
/* Word filter: checks whole Thai words and adjacent word pairs, so ordinary words that merely
   contain a bad string (หีบ, สัดส่วน, แกงกะหรี่, ดอกทองอุไร) are not blocked. Same list as index.html. */
const wordSeg = new Intl.Segmenter('th', { granularity: 'word' });
const BAD_WORDS = new Set(['ควย', 'เหี้ย', 'สัส', 'สัด', 'เย็ด', 'หี', 'แตด', 'ร่าน', 'ระยำ', 'จัญไร', 'ส้นตีน', 'ฉิบหาย', 'ชิบหาย', 'เงี่ยน', 'อีตัว']);
const BAD_PAIRS = new Set(['อีดอก', 'ชาติหมา', 'ไอ้สัตว์', 'อีสัตว์', 'อีตัว', 'ไอ้ควาย', 'อีควาย', 'ลูกกะหรี่']);
const BAD_LATIN = /\b(f+u+c+k+\w*|fck\w*|sh[i1]t+\w*|b[i1]tch\w*|cunts?|assholes?|motherf\w*|puss(y|ies)|sluts?|whores?|nigg\w*|fagg?ots?)\b/i;
function hasBadWords(text){
  if (!text) return false;
  const t = String(text).toLowerCase().normalize('NFC').replace(/[​-‏⁠﻿]/g, '');
  const variants = [t, t.replace(/[\s.\-_*+~^|\\/,'"!?()[\]{}]+/g, '')];
  for (const v of variants){
    if (BAD_LATIN.test(v)) return true;
    const words = Array.from(wordSeg.segment(v.replace(/(.)\1{2,}/g, '$1')), (s) => s.segment.trim()).filter(Boolean);
    for (let i = 0; i < words.length; i++){
      if (BAD_WORDS.has(words[i])) return true;
      if (i + 1 < words.length && BAD_PAIRS.has(words[i] + words[i + 1])) return true;
    }
  }
  return false;
}
const IP_SALT = crypto.randomBytes(16);   // per process: lets us count different reporters without storing IPs
const ipHash = (ip) => crypto.createHmac('sha256', IP_SALT).update(ip).digest('hex').slice(0, 16);
function lanIp(){
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) all.push(a.address);
  const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  all.sort((a, b) => rank(a) - rank(b));
  return all[0] || null;
}
function joinUrl(req){
  if (CONFIG.publicUrl) return CONFIG.publicUrl;
  const host = String(req.headers.host || 'localhost:' + CONFIG.port);
  // Opened as localhost on the big screen: phones need the computer's address on the local network instead
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host)){ const ip = lanIp(); if (ip) return 'http://' + ip + ':' + req.socket.localPort + '/'; }
  const proto = CONFIG.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return proto + '://' + host + '/';
}
function httpError(status, code){ return Object.assign(new Error(code), { status, code }); }
function readJson(req, limit = 4096){
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return;                       // discard the rest; the socket closes after the 413 is sent
      size += c.length;
      if (size > limit){ tooBig = true; chunks.length = 0; reject(httpError(413, 'too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e){ reject(httpError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj, headers){
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  }, headers));
  res.end(body);
}
const limited = (res, sec) => send(res, 429, { error: 'rate_limited', retryAfter: sec }, { 'Retry-After': String(sec) });

/* ---------------- static files: page, assets/, music/ ---------------- */
let page = null;
function loadPage(){
  const raw = fs.readFileSync(CONFIG.pageFile, 'utf8');
  const cut = raw.indexOf('<div lang="th">');
  const headPart = cut > 0 ? raw.slice(0, cut) : '<meta charset="utf-8">';
  const body = cut > 0 ? raw.slice(cut) : raw;
  const html = Buffer.from('<!doctype html>\n<html lang="th">\n<head>\n' + headPart + '</head>\n<body>\n' + body + '\n</body>\n</html>\n');
  page = { body: html, gz: zlib.gzipSync(html, { level: 9 }), br: zlib.brotliCompressSync(html), etag: etagOf(html) };
}
fs.watchFile(CONFIG.pageFile, { interval: 2000 }, () => { try { loadPage(); console.log('[page] reloaded index.html'); } catch (e){ console.error('[page] reload failed', e.message); } });
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const ASSET_DIR = path.join(__dirname, 'assets');
const MUSIC_DIR = path.join(__dirname, 'music');
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
};
function assetPath(name){
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/.test(name) || !MIME[path.extname(name).toLowerCase()]) return null;
  return path.join(ASSET_DIR, name);
}
let musicCache = { at: 0, file: null };
function findMusic(){
  if (Date.now() - musicCache.at < 5000) return musicCache.file;
  let file = null;
  if (env.MUSIC_FILE){ const f = path.resolve(env.MUSIC_FILE); if (fs.existsSync(f)) file = f; }
  else {
    try {
      const f = fs.readdirSync(MUSIC_DIR).filter((n) => /\.(mp3|m4a|aac|ogg|oga|wav|flac)$/i.test(n)).sort()[0];
      if (f) file = path.join(MUSIC_DIR, f);
    } catch (e) {}
  }
  musicCache = { at: Date.now(), file };
  return file;
}
function serveFile(req, res, file, cacheSec){
  let st;
  try { st = fs.statSync(file); } catch (e){ return send(res, 404, { error: 'not_found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'not_found' });
  const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  if (req.headers['if-none-match'] === etag){ res.writeHead(304, { ETag: etag }); return res.end(); }
  const h = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', ETag: etag, 'Cache-Control': 'public, max-age=' + cacheSec, 'X-Content-Type-Options': 'nosniff',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  let start = 0, end = st.size - 1, status = 200;
  if (m && (m[1] || m[2])){
    if (m[1]){ start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
    else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size){ res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    status = 206; h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(status, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}
function sendCached(req, res, item, headers){
  if (req.headers['if-none-match'] === item.etag){ res.writeHead(304, Object.assign({ ETag: item.etag }, headers)); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = item.body, enc = null;
  if (item.br && /\bbr\b/.test(ae)){ body = item.br; enc = 'br'; }
  else if (item.gz && /\bgzip\b/.test(ae)){ body = item.gz; enc = 'gzip'; }
  const h = Object.assign({ ETag: item.etag, Vary: 'Accept-Encoding', 'Content-Length': body.length }, headers);
  if (enc) h['Content-Encoding'] = enc;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}
const JSON_TYPE = 'application/json; charset=utf-8';
function serveLog(req, res, name){
  if (name === 'head.json'){
    trackPoller(req);
    return sendCached(req, res, head(), { 'Content-Type': JSON_TYPE, 'Cache-Control': 'public, max-age=2' });
  }
  const f = /^(seg|cp)-[a-z0-9]+-\d+\.json$/.test(name) ? log.files.get(name) : null;
  if (!f) return send(res, 404, { error: 'gone' });   // the browser reloads the latest checkpoint
  sendCached(req, res, f, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'public, max-age=31536000, immutable' });
}

/* ---------------- writes ---------------- */
function getMe(req, res){
  const owner = ownerOf(req);
  send(res, 200, {
    me: owner ? shortId(owner) : null,
    pledges: owner ? Q.pledgesOf.all(owner).map((r) => r.pid) : [],
    admin: isAdmin(req),
  });
}

async function postKrathong(req, res){
  const owner = ownerOf(req);
  if (!owner) return send(res, 401, { error: 'missing_token' });
  if (!allow('post-ip:' + clientIp(req), 30, 1)) return limited(res, 5);   // a whole school behind one IP still fits
  if (!allow('post:' + owner, 3, 1 / 10)) return limited(res, 10);         // one person: 3 at once, then 1 per 10 s
  const b = await readJson(req, 16 * 1024);   // 140 graphemes can contain many UTF-8 bytes
  if (!TYPES.includes(b.t)) return send(res, 400, { error: 'bad_type' });
  const p = b.p === 1 ? 1 : 0;
  if (hasBadWords(p ? '' : b.w) || hasBadWords(b.n)) return send(res, 400, { error: 'blocked_words' });
  let k = typeof b.k === 'string' && KEY_RE.test(b.k) ? b.k : null;
  if (!k || Q.exists.get(k)) k = crypto.randomBytes(9).toString('base64url');
  const row = { k, t: b.t, w: p ? '' : cleanText(b.w, 140), n: cleanText(b.n, 24), p, owner, at: Date.now(), b: 0 };
  send(res, 201, { item:persistBoat(row) });
}

function persistBoat(row, saveDesign){
  const { owner,k } = row;
  // Keep at most MAX_PER_OWNER per person inside the window: the oldest of theirs drifts away
  const trimmed = tx(() => {
    const old = Q.ownerRecent.all(owner, since()).slice(CONFIG.maxPerOwner - 1);
    for (const { k } of old){ Q.del.run(k); Q.blessDelFor.run(k); Q.reportDelFor.run(k); }
    Q.insert.run(row.k, row.t, row.w, row.n, row.p, row.owner, row.at, row.craft || 0);
    if (saveDesign) saveDesign();
    return old;
  });
  state.count += 1 - trimmed.filter((row) => !row.hidden).length;
  const item = publicItem(row);
  let refill = false;
  for (const { k } of trimmed){ if (removeFromRiver(k)) refill = true; logEvent({ e: 'x', k }); }
  addToRiver(item);
  if (refill) refillRiver();
  logEvent(Object.assign({ e: 'k' }, item));
  return item;
}

function deleteKrathong(req, res, k){
  if (!KEY_RE.test(k)) return send(res, 400, { error: 'bad_key' });
  const owner = ownerOf(req), admin = isAdmin(req);
  if (!owner && !admin) return send(res, 401, { error: 'missing_token' });
  if (!allow('del:' + clientIp(req), 20, 1)) return limited(res, 2);
  const row = Q.byKey.get(k);
  if (!row) return send(res, 404, { error: 'not_found' });
  if (!admin && row.owner !== owner) return send(res, 403, { error: 'forbidden' });
  tx(() => { Q.del.run(k); Q.blessDelFor.run(k); Q.reportDelFor.run(k); });
  if (row.at >= since() && !row.hidden) state.count = Math.max(0, state.count - 1);
  if (removeFromRiver(k)) refillRiver();
  logEvent({ e: 'x', k });
  send(res, 200, { ok: true });
}

function blessKrathong(req, res, k){
  if (!KEY_RE.test(k)) return send(res, 400, { error: 'bad_key' });
  const owner = ownerOf(req);
  if (!owner) return send(res, 401, { error: 'missing_token' });
  if (!allow('bless-ip:' + clientIp(req), 120, 5) || !allow('bless:' + owner, 20, 1)) return limited(res, 3);
  const row = Q.byKey.get(k);
  if (!row || row.hidden || row.at < since()) return send(res, 404, { error: 'not_found' });
  if (row.owner === owner) return send(res, 400, { error: 'own_krathong' });
  const added = tx(() => { const r = Q.blessAdd.run(k, owner, Date.now()); if (Number(r.changes)) Q.blessInc.run(k); return Number(r.changes) > 0; });
  if (!added) return send(res, 200, { b: Number(row.b) || 0, already: true });
  const b = (Number(row.b) || 0) + 1;
  const it = state.river.find((x) => x.k === k); if (it) it.b = b;
  logEvent({ e: 'b', k, b });
  send(res, 200, { b });
}

function reportKrathong(req, res, k){
  if (!KEY_RE.test(k)) return send(res, 400, { error: 'bad_key' });
  const owner = ownerOf(req);
  if (!owner) return send(res, 401, { error: 'missing_token' });
  if (!allow('report:' + owner, 10, 0.2)) return limited(res, 10);
  const row = Q.byKey.get(k);
  if (!row) return send(res, 404, { error: 'not_found' });
  if (row.owner === owner) return send(res, 400, { error: 'own_krathong' });
  const r = Q.reportAdd.run(k, owner, ipHash(clientIp(req)), Date.now());
  let hidden = !!row.hidden;
  // Hide once enough *different* people (by network address) have reported it; the admin can still delete
  if (Number(r.changes) && !hidden && Number(Q.reportPeople.get(k).c) >= CONFIG.reportHide){
    Q.hide.run(k); hidden = true;
    if (row.at >= since()) state.count = Math.max(0, state.count - 1);
    if (removeFromRiver(k)) refillRiver();
    logEvent({ e: 'x', k });
    console.log('[report] hidden ' + k + ' after ' + CONFIG.reportHide + ' reports');
  }
  send(res, 200, { ok: true, hidden });
}

async function putPledges(req, res){
  const owner = ownerOf(req);
  if (!owner) return send(res, 401, { error: 'missing_token' });
  if (!allow('pledge:' + clientIp(req), 30, 2)) return limited(res, 2);
  const b = await readJson(req);
  if (!Array.isArray(b.pledges)) return send(res, 400, { error: 'bad_pledges' });
  const want = PLEDGES.filter((id) => b.pledges.includes(id));
  const have = Q.pledgesOf.all(owner).map((r) => r.pid);
  const add = want.filter((x) => !have.includes(x)), del = have.filter((x) => !want.includes(x));
  tx(() => { for (const x of add) Q.pledgeAdd.run(owner, x); for (const x of del) Q.pledgeDel.run(owner, x); });
  state.pledgeTotal += add.length - del.length;
  if (!have.length && want.length) state.pledgePeople++;
  if (have.length && !want.length) state.pledgePeople--;
  markHead();
  send(res, 200, { pledges: want });
}

async function postMoment(req, res){
  if (!isAdmin(req)) return send(res, 403, { error: 'forbidden' });
  const b = await readJson(req);
  const sec = Math.max(5, Math.min(120, Number(b.inSec) || 15));
  state.momentAt = Date.now() + sec * 1000;
  markHead(); head();   // publish at once: browsers see it on their next poll, seconds before it starts
  send(res, 200, { at: state.momentAt });
}

function getConfig(req, res){
  const music = findMusic();
  send(res, 200, {
    joinUrl: joinUrl(req), moments: CONFIG.moments, windowHours: CONFIG.windowHours,
    music: music ? { url: '/music', name: path.basename(music, path.extname(music)) } : null,
  });
}

function health(req, res){
  if (typeof global.gc === 'function' && new URL(req.url, 'http://local').searchParams.has('gc')) global.gc();   // only with node --expose-gc
  const m = process.memoryUsage(), cpu = process.cpuUsage();
  send(res, 200, {
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    krathongsInWindow: state.count,
    river: state.river.length,
    log: { seq: log.seq, checkpoint: log.cp, segmentsSinceCheckpoint: log.segs.length, filesInMemory: log.files.size },
    online: state.online,
    rssMB: Math.round(m.rss / 1e6),
    heapUsedMB: Math.round(m.heapUsed / 1e6),
    rateBuckets: buckets.size,
  });
}

/* ---------------- router ---------------- */
const workshop = setupWorkshop({db,send,readJson,httpError,ownerOf,clientIp,allow,limited,cleanText,hasBadWords,persistBoat});
const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://local').pathname;
    const m = req.method, read = m === 'GET' || m === 'HEAD';
    if (read && (p === '/' || p === '/index.html')) return sendCached(req, res, page, PAGE_HEADERS);
    if (read && (p === '/workshop.html' || p === '/workshop')) return serveFile(req,res,path.join(__dirname,'workshop.html'),0);
    if (p.startsWith('/api/workshop/')) return await workshop.route(req,res,p);
    if (read && p.startsWith('/log/')) return serveLog(req, res, p.slice('/log/'.length));
    if (read && p.startsWith('/assets/')){
      const f = assetPath(p.slice('/assets/'.length));
      return f ? serveFile(req, res, f, /\.(mjs|css|json)$/.test(f) ? 0 : 86400) : send(res, 404, { error: 'not_found' });
    }
    if (read && p === '/music'){
      const f = findMusic();
      return f ? serveFile(req, res, f, 0) : send(res, 404, { error: 'no_music' });
    }
    if (p === '/api/krathongs' && m === 'POST') return await postKrathong(req, res);
    if (p.startsWith('/api/krathongs/')){
      const parts = p.slice('/api/krathongs/'.length).split('/');
      if (parts.length === 1 && m === 'DELETE') return deleteKrathong(req, res, parts[0]);
      if (parts.length === 2 && parts[1] === 'bless' && m === 'POST') return blessKrathong(req, res, parts[0]);
      if (parts.length === 2 && parts[1] === 'report' && m === 'POST') return reportKrathong(req, res, parts[0]);
    }
    if (p === '/api/moment' && m === 'POST') return await postMoment(req, res);
    if (p === '/api/config' && m === 'GET') return getConfig(req, res);
    if (p === '/api/me' && m === 'GET') return getMe(req, res);
    if (p === '/api/pledges' && m === 'PUT') return await putPledges(req, res);
    if (p === '/healthz') return health(req, res);
    send(res, 404, { error: 'not_found' });
  } catch (e){
    if (!e.status) console.error('[error]', e);
    if (res.headersSent){ res.destroy(); return; }
    if (e.status === 413){
      send(res, 413, { error: 'too_large' }, { Connection: 'close' });
      res.on('finish', () => req.destroy());
      return;
    }
    send(res, e.status || 500, { error: e.status ? e.code : 'server_error' });
  }
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;

/* ---------------- housekeeping ---------------- */
let sweeps = 0;
function sweep(){
  workshop.sweep();
  const cut = since();
  let removed = 0, r;
  do { r = Q.expire.run(cut); removed += Number(r.changes); } while (Number(r.changes) === 5000);
  Q.blessExpire.run(cut); Q.reportExpire.run(cut);
  if (removed || ++sweeps % 10 === 0){
    for (const item of state.river) if (item.at < cut) logEvent({ e: 'x', k: item.k });
    rebuildRiver(); recount(); markHead();
    if (removed) console.log('[sweep] ' + removed + ' krathongs drifted away');
  }
}
setInterval(sweep, 60e3);

function shutdown(){
  console.log('\nshutting down…');
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------------- start ---------------- */
loadPage();
sweep(); rebuildRiver(); recount();
checkpoint(); head();
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('E-Kratong is running at http://localhost:' + server.address().port);
  console.log('  database: ' + CONFIG.dbFile);
  console.log('  event log: ' + CONFIG.logDir);
  console.log('  krathongs in the last ' + CONFIG.windowHours + ' h: ' + state.count);
  if (!CONFIG.rateLimit) console.log('  WARNING: RATE_LIMIT=off (use for load tests only)');
  if (!CONFIG.adminToken) console.log('  tip: set ADMIN_TOKEN to remove other people\'s krathongs');
});
