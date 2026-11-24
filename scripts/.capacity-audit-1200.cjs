'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { RiverLog } = require('../assets/river-log.mjs');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-kratong-capacity-'));
const dbFile = path.join(tmp, 'fixture.db'), logDir = path.join(tmp, 'log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0,ms)));
const users = 1200, musicFile = '/assets/Riverbound_Lights.mp3';
const compareIdle = process.argv.includes('--check-idle');
const idleStats = { standard:{ok:0}, short:{ok:0} };
const musicBytes = fs.statSync(path.join(root, musicFile.slice(1))).size;
const controls = new http.Agent({keepAlive:true,maxSockets:8});
const clients = [], timers = new Set();
const types = ['suchada','pratheep','naga','saphao','lantern'];
const wishes = ['ขอให้คนที่บ้านแข็งแรงและได้กลับมากินข้าวด้วยกัน','ให้ปีนี้มีโอกาสเดินทางไปเจอเพื่อนเก่า','ขอบคุณสายน้ำที่หล่อเลี้ยงบ้านของเรา','หวังว่าเราจะได้ดูพระจันทร์ด้วยกันอีกหลายปี','ขอให้เรื่องหนักใจค่อย ๆ ผ่านไป','ขอให้ทุกคนที่ทำงานคืนนี้เดินทางกลับถึงบ้านอย่างปลอดภัย','ขอให้แม่น้ำและชุมชนของเราสะอาดขึ้นทุกวัน','วันนี้พาครอบครัวมาลอยกระทงด้วยกันเป็นครั้งแรก'];
const nicknames = ['พิม','มะปราง','เอ','นุ่น','อาร์ต','ข้าว','เก้า','ฝ้าย','ดาว','ไม้'];
const token = Array.from({length:users},()=>crypto.randomBytes(18).toString('base64url'));
const owners = token.map(t=>crypto.createHash('sha256').update(t).digest('hex'));
const recent = [];
let port=0, child, lastPhase, stopping=false, floatCount=0, blessCount=0, pollProblems=0;
const report={host:{cpu:os.cpus()[0].model.trim(),ramGB:os.totalmem()/1e9,node:process.version}, users, musicBytes, phases:[]};

function log(tag, value){ console.log(tag+' '+JSON.stringify(value)); }
async function launch(){
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','-e',
    "process.on('message',m=>{if(m==='stop')process.emit('SIGTERM')});require('./server.js');"],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
    env:{...process.env,HOST:'127.0.0.1',PORT:'0',PAGE_FILE:path.join(root,'index.html'),DB_FILE:dbFile,LOG_DIR:logDir,
      TRUST_PROXY:'0',RATE_LIMIT:'on',ONLINE_COUNT:'on',MUSIC_FILE:'',PUBLIC_URL:'http://127.0.0.1/',
      RIVER_SIZE:'300',PER_PERSON:'3',MAX_PER_OWNER:'12',WINDOW_HOURS:'48',SEAL_MS:'1000',CHECKPOINT_MS:'15000',CHECKPOINT_SEGS:'8',SEG_MAX_NEW:'25'}});
  child.stderr.on('data',b=>process.stderr.write(b));
  for await (const line of createInterface({input:child.stdout})){
    const m=/running at http:\/\/localhost:(\d+)/.exec(line);
    if(m){port=Number(m[1]);return;}
  }
  throw Error('Server did not start');
}
async function stopChild(){
  if(!child||child.exitCode!==null||child.signalCode)return;
  const done=once(child,'exit');
  if(child.connected)child.send('stop');
  const t=setTimeout(()=>child.kill(),4500);
  try{await done;}finally{clearTimeout(t);}
}
function seed(){
  const db=new DatabaseSync(dbFile);
  const add=db.prepare('INSERT INTO krathongs (k,t,w,n,p,owner,at,b,hidden) VALUES(?,?,?,?,?,?,?,1,0)');
  const bless=db.prepare('INSERT INTO blessings VALUES(?,?,?)');
  const pledge=db.prepare('INSERT INTO pledges VALUES(?,?)');
  const sizes=[],start=Date.now()-12*3600e3;
  for(let h=0;h<12;h++){
    db.exec('BEGIN');
    for(let i=0;i<users;i++){
      const k=crypto.randomBytes(9).toString('base64url'), at=start+(h*users+i)*3000;
      const hiddenWish=(h+i)%10===0;
      add.run(k,types[(i+h)%types.length], hiddenWish?'':wishes[(i+h)%wishes.length], nicknames[(i+3*h)%nicknames.length]+(i%19),+hiddenWish,owners[i],at);
      bless.run(k,owners[(i+1)%users],at+100);
      if(!h)pledge.run(owners[i],'water');
      if(h===11)recent.push({k,owner:i});
    }
    db.exec('COMMIT');
    if([0,5,11].includes(h)){
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      sizes.push({hours:h+1,boats:(h+1)*users,blessings:(h+1)*users,pledges:users,dbBytes:fs.statSync(dbFile).size});
    }
  }
  db.close();return sizes;
}
function byteSize(file){try{return fs.statSync(file).size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}}
function disk(){
  const logBytes=fs.readdirSync(logDir).reduce((s,f)=>s+byteSize(path.join(logDir,f)),0);
  const db=byteSize(dbFile),wal=byteSize(dbFile+'-wal'),shm=byteSize(dbFile+'-shm');
  return {db,wal,shm,log:logBytes,total:db+wal+shm+logBytes};
}
function metric(){return {n:0,body:0,inBytes:0,outBytes:0,lat:[],codes:{},errors:0};}
function phaseData(){return Object.fromEntries(['head','checkpoint','segment','static','api','float','bless','song'].map(k=>[k,metric()]));}
function read(route, kind, agent=controls, options={}){
  const method=options.body?'POST':'GET', data=options.body?Buffer.from(JSON.stringify(options.body)):null;
  const headers={'Accept-Encoding':'br, gzip','User-Agent':'E-Kratong capacity viewer',...options.headers};
  if(data){headers['Content-Type']='application/json';headers['Content-Length']=data.length;}
  const time=performance.now(), wantJson=options.json!==false, chunks=[];
  const p=new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:route,method,agent,headers},res=>{
      let length=0;
      res.on('data',b=>{length+=b.length;if(wantJson)chunks.push(b);});
      res.on('error',reject);res.once('aborted',()=>reject(Error('response aborted')));
      res.on('end',()=>{
        try{
          const status=res.statusCode, rh=res.rawHeaders;
          if(compareIdle && kind==='head') idleStats[agent.options.timeout ? 'short' : 'standard'].ok++;
          let responseHeader=Buffer.byteLength('HTTP/'+res.httpVersion+' '+status+' '+res.statusMessage+'\r\n\r\n');
          for(let n=0;n<rh.length;n+=2)responseHeader+=Buffer.byteLength(rh[n]+': '+rh[n+1]+'\r\n');
          if(kind&&lastPhase){
            const m=lastPhase[kind];m.n++;m.body+=length;m.outBytes+=responseHeader+length;
            m.inBytes+=Buffer.byteLength(req._header)+(data?.length||0);
            m.lat.push(performance.now()-time);m.codes[status]=(m.codes[status]||0)+1;
          }
          let json=null;
          if(wantJson&&length){let b=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')b=zlib.gunzipSync(b);json=JSON.parse(b.toString());}
          resolve({status,length,json,headers:res.headers});
        } catch(e){reject(e);}
      });
    });
    req.setTimeout(20000,()=>req.destroy(Error('request timeout')));
    req.on('error',e=>{
      if(compareIdle && kind==='head'){
        const group=idleStats[agent.options.timeout ? 'short' : 'standard'];
        const reason=e.code+'-'+(req.reusedSocket?'reused':'fresh');
        group[reason]=(group[reason]||0)+1;
      }
      reject(e);
    });req.end(data);
  });
  return p.catch(e=>{if(kind&&lastPhase)lastPhase[kind].errors++;throw e;});
}
const health=async()=> (await read('/healthz',null)).json;
function expect(r,code){if(r.status!==code)throw Error('unexpected status '+r.status+' expected '+code);return r;}
function schedule(fn,ms){
  const t=setTimeout(()=>{timers.delete(t);if(!stopping)fn();},ms);timers.add(t);
}
async function viewer(i){
  const agent=new http.Agent({keepAlive:true,maxSockets:2,maxFreeSockets:2,timeout:compareIdle && i%2 ? 3500 : 0});
  const v={agent,etag:null,delay:2500};clients[i]=v;
  const reader=new RiverLog(async name=>expect(await read('/log/'+name,name.startsWith('cp-')?'checkpoint':'segment',agent),200).json,()=>{},()=>{});
  async function tick(initial){
    const r=await read('/log/head.json','head',agent,{headers:v.etag?{'If-None-Match':v.etag}:{}});
    if(r.status===200){
      await reader.sync(r.json);v.etag=r.headers.etag;v.delay=2500;
    }else{expect(r,304);v.delay=Math.min(v.delay+500,6000);}
    if(!stopping)schedule(()=>poll(),v.delay);
  }
  async function poll(){try{await tick(false);}catch(e){pollProblems++;v.etag=null;if(!stopping)schedule(()=>poll(),6000);}}
  await Promise.all([read('/','static',agent,{json:false}),read('/assets/moon.jpg','static',agent,{json:false})]);
  await read('/assets/river-log.mjs','static',agent,{json:false});
  await read('/api/config','api',agent);await read('/api/me','api',agent,{headers:{'X-Client-Token':token[i]}});
  await tick(true);
}
async function floatOne(){
  const n=floatCount++,i=n%users;
  const r=await read('/api/krathongs','float',controls,{headers:{'X-Client-Token':token[i]},body:{t:types[n%5],w:wishes[n%wishes.length],n:nicknames[n%nicknames.length]+(i%19),p:0}});
  if(r.status===201)recent[i]={k:r.json.item.k,owner:i};
}
async function blessOne(){
  const n=blessCount++,target=recent[(n*37)%users],from=(target.owner+9+Math.floor(n/users))%users;
  await read('/api/krathongs/'+target.k+'/bless','bless',controls,{headers:{'X-Client-Token':token[from]},body:{}});
}
async function music(i){
  const r=await read(musicFile,'song',clients[i].agent,{headers:{Range:'bytes=0-'},json:false});
  if(r.status!==206||r.length!==musicBytes)throw Error('incomplete music');
}
async function paced(count,spacingMs,fn,offset=0){
  const start=performance.now(),tasks=[];
  for(let i=0;i<count;i++){
    await sleep(start+offset+i*spacingMs-performance.now());
    tasks.push(fn(i));
  }
  await Promise.all(tasks);
}
function quantile(a,q){return a.length?+a[Math.ceil(q*a.length)-1].toFixed(2):0;}
async function phase(label,work){
  const before=await health(),samples=[before],volumes=[disk()], data=phaseData(), previous=pollProblems;
  const start=performance.now();lastPhase=data;
  let pending=Promise.resolve(),busy=false;
  const id=setInterval(()=>{if(!busy){busy=true;pending=health().then(h=>{samples.push(h);volumes.push(disk());}).finally(()=>{busy=false;});}},1000);
  try{await work();}finally{clearInterval(id);}
  const end=performance.now();lastPhase=null;await pending;
  const after=await health();samples.push(after);volumes.push(disk());
  const seconds=(end-start)/1000;const cats={};
  for(const [key,m] of Object.entries(data)){
    m.lat.sort((a,b)=>a-b);
    cats[key]={n:m.n,codes:m.codes,errors:m.errors,body:m.body,down:m.outBytes,up:m.inBytes,p95:quantile(m.lat,.95),p99:quantile(m.lat,.99)};
  }
  const vals=samples.map(s=>s.rssMB).sort((a,b)=>a-b);
  const result={label,seconds:+seconds.toFixed(3),cpuPct:+((after.cpuMs-before.cpuMs)/seconds/10).toFixed(2),
    rssStart:before.rssMB,rssEnd:after.rssMB,rssMedian:quantile(vals,.5),rssMax:vals.at(-1),heapMax:Math.max(...samples.map(s=>s.heapUsedMB)),
    diskMax:Math.max(...volumes.map(v=>v.total)),diskLast:volumes.at(-1),boats:after.krathongsInWindow,logFiles:after.log.filesInMemory,viewerErrors:pollProblems-previous,cats};
  report.phases.push(result);log('PHASE',result);
}
async function mix(seconds,every){
  const count=Math.floor(seconds*1000/every);
  await Promise.all([sleep(seconds*1000),paced(count,every,floatOne),paced(count,every,blessOne,every/2)]);
}
async function main(){
  await launch();await stopChild();report.dbFixture=seed();log('FIXTURE',report.dbFixture);
  await launch();report.idle=await health();
  await phase('join',()=>paced(users,12,viewer));
  if(compareIdle){await phase('connectionCheck',()=>sleep(80000));log('IDLE_CONNECTIONS',idleStats);return;}
  await phase('quietWarmup',()=>sleep(32000));
  await phase('quiet',()=>sleep(45000));
  await phase('activityWarmup',()=>mix(12,3000));
  await phase('activity',()=>mix(90,3000));
  await phase('musicWithActivity',()=>Promise.all([mix(60,3000),paced(users,50,music)]));
  await phase('busy',()=>mix(65,1000));
  report.finalDisk=disk();
  const totalErrors=report.phases.reduce((s,p)=>s+p.viewerErrors+Object.values(p.cats).reduce((a,m)=>a+m.errors+Object.entries(m.codes).filter(([c])=>Number(c)>=400).reduce((a,[,n])=>a+n,0),0),0);
  log('SUMMARY',{phases:report.phases.map(p=>p.label),errors:totalErrors,initial:report.idle,disk:report.finalDisk});
  if(totalErrors)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  stopping=true;for(const t of timers)clearTimeout(t);
  for(const v of clients)if(v)v.agent.destroy();controls.destroy();await stopChild();
  if(path.dirname(tmp)===path.resolve(os.tmpdir())&&path.basename(tmp).startsWith('e-kratong-capacity-'))
    fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:150});
});
