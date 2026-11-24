'use strict';
/*
 * Load test for the E-Kratong server (no dependencies).
 *
 *   1) start the server with rate limits off:   RATE_LIMIT=off npm start
 *   2) run:  node scripts/load-test.js --viewers 2000 --posts 5000 --concurrency 50 --seconds 20
 *
 * Polls /log/head.json every 2.5 s and follows the same checkpoint/segment rules as the page.
 * Reports the server's CPU time and memory, and how much traffic the viewers caused.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { RiverLog } = require('../assets/river-log.mjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const BASE = new URL(args.url || 'http://localhost:3000');
const VIEWERS = Number(args.viewers || 1000);
const POSTS = Number(args.posts || 3000);
const CONC = Number(args.concurrency || 40);
const SECONDS = Number(args.seconds || 20);
const POLL_MS = 2500;
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });       // viewers
const postAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });    // floating, kept separate so viewers don't queue it
const TYPES = ['suchada', 'pratheep', 'naga', 'saphao', 'lantern'];

function request(method, path, { body, headers = {} } = {}){
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: BASE.hostname, port: BASE.port, path, method, agent: method === 'POST' ? postAgent : agent,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, { 'Accept-Encoding': 'gzip' }, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse((res.headers['content-encoding'] === 'gzip' ? require('node:zlib').gunzipSync(buf) : buf).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json, bytes: buf.length, etag: res.headers.etag });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const health = async () => (await request('GET', '/healthz')).json;

/* Count compressed response bodies, including every checkpoint repair. */
const traffic = { head200: 0, head304: 0, segs: 0, cps: 0, bytes: 0, errors: 0 };
function startViewer(stopAt){
  let etag = null;
  const reader = new RiverLog(async name => {
    const r = await request('GET', '/log/' + name);
    traffic.bytes += r.bytes;
    if (r.status !== 200 || !r.json) throw Object.assign(new Error('log read failed'), { status:r.status });
    if (name.startsWith('cp-')) traffic.cps++; else traffic.segs++;
    return r.json;
  }, () => {}, () => {});
  const tick = async () => {
    if (Date.now() > stopAt) return;
    try {
      const h = await request('GET', '/log/head.json', { headers: etag ? { 'If-None-Match': etag } : {} });
      traffic.bytes += h.bytes;
      if (h.status === 304) traffic.head304++;
      else if (h.status === 200 && h.json){
        traffic.head200++;
        await reader.sync(h.json);
        etag = h.etag;
      } else traffic.errors++;
    } catch (e){ etag = null; traffic.errors++; }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, Math.random() * POLL_MS);   // spread viewers out like real people
}

async function main(){
  console.log('target   ' + BASE.origin + ' · ' + VIEWERS + ' viewers polling every ' + POLL_MS / 1000 + ' s for ' + SECONDS + ' s · ' + POSTS + ' krathongs floated');
  const before = await health();
  const t0 = Date.now(), stopAt = t0 + SECONDS * 1000;
  for (let i = 0; i < VIEWERS; i++) startViewer(stopAt);

  const owners = Array.from({ length: Math.max(50, Math.ceil(POSTS / 6)) }, () => crypto.randomBytes(18).toString('base64url'));
  const lat = [], codes = {};
  let next = 0;
  async function poster(){
    while (next < POSTS){
      const i = next++, t = Date.now();
      try {
        const r = await request('POST', '/api/krathongs', {
          body: { t: TYPES[i % 5], w: 'ทดสอบโหลด ' + i + ' ขอให้ระบบลื่นไหล', n: 'load' + (i % 100), p: 0 },
          headers: { 'X-Client-Token': owners[i % owners.length] },
        });
        codes[r.status] = (codes[r.status] || 0) + 1;
      } catch (e){ codes.err = (codes.err || 0) + 1; }
      lat.push(Date.now() - t);
    }
  }
  await Promise.all(Array.from({ length: CONC }, poster));
  const postSecs = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, Math.max(0, stopAt - Date.now()) + POLL_MS + 500));
  const after = await health();
  agent.destroy(); postAgent.destroy();

  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  const wall = (Date.now() - t0) / 1000, cpu = after.cpuMs - before.cpuMs, reqs = traffic.head200 + traffic.head304 + traffic.segs + traffic.cps;
  console.log('posts    ' + POSTS + ' in ' + postSecs.toFixed(1) + ' s = ' + Math.round(POSTS / postSecs) + '/s, status ' + JSON.stringify(codes) + ', p50 ' + pct(0.5) + ' ms, p99 ' + pct(0.99) + ' ms');
  console.log('viewers  ' + reqs + ' reads in ' + wall.toFixed(0) + ' s (' + Math.round(reqs / wall) + '/s): head 304 ' + traffic.head304 + ', head 200 ' + traffic.head200 + ', segments ' + traffic.segs + ', checkpoints ' + traffic.cps + ', errors ' + traffic.errors);
  console.log('traffic  ' + (traffic.bytes / 1e6).toFixed(1) + ' MB to all viewers = ' + Math.round(traffic.bytes / VIEWERS / 1024) + ' KB per viewer');
  console.log('server   CPU ' + cpu + ' ms over ' + wall.toFixed(0) + ' s (' + (cpu / wall / 10).toFixed(1) + '% of one core) · rss ' + before.rssMB + ' → ' + after.rssMB + ' MB · heap ' + after.heapUsedMB + ' MB');
  console.log('log      seq ' + after.log.seq + ', checkpoint ' + after.log.checkpoint + ', files in memory ' + after.log.filesInMemory + ' · krathongs in window ' + after.krathongsInWindow);
}
main().catch((e) => { console.error(e); process.exit(1); });
