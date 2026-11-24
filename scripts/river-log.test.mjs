import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RiverLog } from '../assets/river-log.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));

async function startServer(t){
  const dir = await mkdtemp(path.join(tmpdir(), 'e-kratong-test-'));
  // Only the server's publishing clock is stepped. Requests, SQLite and log files are real.
  const fixture = [
    "const { mock } = require('node:test');",
    "mock.timers.enable({ apis: ['Date','setInterval'], now: Date.now() });",
    "require('./server.js');",
    "process.on('message', ms => { mock.timers.tick(ms); process.send('ticked'); });",
  ].join('\n');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', fixture], {
    cwd:project, stdio:['ignore','pipe','inherit','ipc'], windowsHide:true,
    env:{ ...process.env, HOST:'127.0.0.1', PORT:'0', RATE_LIMIT:'off', DB_FILE:path.join(dir,'test.db'),
      LOG_DIR:path.join(dir,'log'), PAGE_FILE:path.join(project,'index.html'), ONLINE_COUNT:'off',
      SEAL_MS:'1000', CHECKPOINT_MS:'15000', CHECKPOINT_SEGS:'8', SEG_MAX_NEW:'25',
      RIVER_SIZE:'300', PER_PERSON:'3', MAX_PER_OWNER:'12', WINDOW_HOURS:'48' },
  });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode){
      const done = once(child, 'exit'); child.kill(); await done;
    }
    if (path.dirname(dir) === path.resolve(tmpdir()) && path.basename(dir).startsWith('e-kratong-test-'))
      await rm(dir, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
  });
  let base;
  for await (const line of createInterface({ input:child.stdout })){
    const match = /is running at http:\/\/localhost:(\d+)/.exec(line);
    if (match){ base = 'http://127.0.0.1:' + match[1]; break; }
  }
  assert.ok(base, 'server must start');
  const get = async url => {
    const r = await fetch(base + url);
    assert.equal(r.status, 200);
    return r.json();
  };
  return {
    head: () => get('/log/head.json'),
    read: name => get('/log/' + name),
    async tick(ms){ const done = once(child,'message'); child.send(ms); await done; },
    async launch(key, owner = key, text = {}){
      const r = await fetch(base + '/api/krathongs', { method:'POST',
        headers:{ 'Content-Type':'application/json', 'X-Client-Token':'test-krathong-owner-' + owner },
        body:JSON.stringify({ k:key, t:'suchada', w:'ขอให้แม่น้ำสะอาด', ...text }) });
      assert.equal(r.status, 201); return (await r.json()).item;
    },
    async remove(key, owner){
      const r = await fetch(base + '/api/krathongs/' + key, { method:'DELETE',
        headers:{ 'X-Client-Token':'test-krathong-owner-' + owner } });
      assert.equal(r.status, 200); await r.arrayBuffer();
    },
  };
}

function viewer(server){
  const keys = new Set(), reads = [];
  const reader = new RiverLog(name => { reads.push(name); return server.read(name); },
    items => { keys.clear(); for (const item of items) keys.add(item.k); },
    events => { for (const event of events){
      if (event.e === 'k') keys.add(event.k);
      if (event.e === 'x') keys.delete(event.k);
    } });
  return { keys, reads, sync:head => reader.sync(head) };
}

test('viewers repair a sampled burst at the same sequence and replay complete changes across checkpoints', async t => {
  const server = await startServer(t), live = viewer(server);
  await live.sync(await server.head());
  const wave = Array.from({ length:30 }, (_, i) => 'wave' + i);
  await Promise.all(wave.map(key => server.launch(key)));
  await server.tick(1000);
  const sampled = await server.head();
  assert.equal(sampled.count, 30);
  await live.sync(sampled);
  assert.equal(live.keys.size, 25);
  const segment = await server.read('seg-' + sampled.epoch + '-' + sampled.seq + '.json');
  assert.equal(segment.incomplete, true);

  await server.tick(14000);
  const repaired = await server.head();
  assert.equal(repaired.cp, sampled.seq);
  await live.sync(repaired);
  const newcomer = viewer(server);
  await newcomer.sync(repaired);
  assert.deepEqual(live.keys, new Set(wave));
  assert.deepEqual(newcomer.keys, live.keys);
  const readCount = live.reads.length;
  await live.sync(repaired);
  assert.equal(live.reads.length, readCount, 'a repaired checkpoint is applied only once');

  await server.launch('nextBoat');
  await server.tick(15000);
  const complete = await server.head();
  await live.sync(complete);
  assert.deepEqual(live.reads.slice(readCount), ['seg-' + complete.epoch + '-' + complete.seq + '.json']);
  assert.ok(live.keys.has('nextBoat'));
});

test('deleting a visible item restores the older boat, with Thai and joined emoji preserved', async t => {
  const server = await startServer(t);
  const wish = 'ก้'.repeat(139) + '👩‍👩‍👧‍👦', name = 'น้ำ'.repeat(24);
  for (const key of ['boat0','boat1','boat2','boat3']){
    const item = await server.launch(key,'same',{ w:wish + 'ข', n:name + 'ก' });
    assert.equal(item.w, wish); assert.equal(item.n, name);
  }
  await server.tick(15000);
  const live = viewer(server); await live.sync(await server.head());
  assert.deepEqual(live.keys, new Set(['boat1','boat2','boat3']));
  await server.remove('boat2','same'); await server.tick(1000);
  await live.sync(await server.head());
  await server.tick(14000);
  const head = await server.head();
  await live.sync(head);
  const fresh = viewer(server); await fresh.sync(head);
  assert.deepEqual(live.keys, new Set(['boat0','boat1','boat3']));
  assert.deepEqual(fresh.keys, live.keys);

  const family = '👩‍👩‍👧‍👦';
  const emoji = await server.launch('emoji','guest',{ w:family.repeat(140), n:family.repeat(24) });
  assert.equal(emoji.w, family.repeat(140));
  assert.equal(emoji.n, family.repeat(24));
});

test('a failed segment read recovers from a checkpoint, including after a server restart', async () => {
  const files = new Map([
    ['cp-first-0.json', { seq:0, items:[] }],
    ['seg-first-1.json', { seq:1, ev:[{ e:'k', k:'boatA' }] }],
    ['cp-first-2.json', { seq:2, items:[{ k:'boatA' }, { k:'boatB' }] }],
    ['cp-second-0.json', { seq:0, items:[{ k:'boatC' }] }],
  ]);
  const read = async name => {
    if (!files.has(name)) throw Object.assign(new Error('gone'), { status:404 });
    return files.get(name);
  };
  const client = viewer({ read });
  const head = { epoch:'first', seq:0, cp:0, repairThrough:0, replayAfter:0 };
  await client.sync(head);
  await assert.rejects(client.sync({ ...head, seq:2 }), { status:404 });
  await client.sync({ ...head, seq:2, cp:2 });
  assert.deepEqual(client.keys, new Set(['boatA','boatB']));
  await client.sync({ ...head, epoch:'second' });
  assert.deepEqual(client.keys, new Set(['boatC']));
});
