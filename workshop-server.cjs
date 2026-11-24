'use strict';

const crypto = require('node:crypto');
const { insideThailand, places } = require('./assets/workshop-map.mjs');
const outline = require('./assets/thailand-outline.json');
const materials = new Set(['base','leaf','fold','lotus','marigold','candle','sticker']);
const roomKey = /^[A-Za-z0-9_-]{24}$/;
const pieceKey = /^[A-Za-z0-9_-]{8,40}$/;
const imageKey = /^[a-f0-9]{64}$/;
const hours48 = 48 * 3600e3;

function setupWorkshop({db, send, readJson, httpError, ownerOf, clientIp, allow, limited, cleanText, hasBadWords, persistBoat}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS craft_rooms (
      id TEXT PRIMARY KEY, rev INTEGER NOT NULL, pieces TEXT NOT NULL, recent_ops TEXT NOT NULL,
      touched INTEGER NOT NULL, floated TEXT, lon REAL NOT NULL DEFAULT 100.490, lat REAL NOT NULL DEFAULT 13.743
    );
    CREATE INDEX IF NOT EXISTS craft_room_expiry ON craft_rooms(touched);
    CREATE TABLE IF NOT EXISTS craft_stickers (
      room TEXT NOT NULL, hash TEXT NOT NULL, png BLOB NOT NULL, PRIMARY KEY(room,hash)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS craft_floats (
      k TEXT PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL, place TEXT NOT NULL, png BLOB NOT NULL, thumb BLOB NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS craft_float_time ON craft_floats(at DESC);
    CREATE TRIGGER IF NOT EXISTS craft_drop_stickers AFTER DELETE ON craft_rooms
      BEGIN DELETE FROM craft_stickers WHERE room=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS craft_drop_float AFTER DELETE ON krathongs
      BEGIN DELETE FROM craft_floats WHERE k=OLD.k; END;
  `);
  const q = {};
  for (const [name, sql] of Object.entries({
    room:'SELECT * FROM craft_rooms WHERE id=? AND touched>=?',
    create:'INSERT INTO craft_rooms(id,rev,pieces,recent_ops,touched,lon,lat) VALUES(?,1,?,\'[]\',?,?,?)',
    save:'UPDATE craft_rooms SET rev=?, pieces=?, recent_ops=?, touched=? WHERE id=?',
    finish:'UPDATE craft_rooms SET floated=?,rev=rev+1,touched=? WHERE id=?',
    expire:'DELETE FROM craft_rooms WHERE touched<?',
    sticker:'SELECT png FROM craft_stickers WHERE room=? AND hash=?',
    hasSticker:'SELECT 1 FROM craft_stickers WHERE room=? AND hash=?',
    storage:'SELECT count(*) AS n, coalesce(sum(length(png)),0) AS bytes FROM craft_stickers WHERE room=?',
    insertSticker:'INSERT INTO craft_stickers VALUES(?,?,?)',
    float:'INSERT INTO craft_floats(k,lon,lat,place,png,thumb,at) VALUES(?,?,?,?,?,?,?)',
    detail:'SELECT c.k,c.lon,c.lat,c.place,c.at,b.n,b.w FROM craft_floats c JOIN krathongs b ON b.k=c.k WHERE c.k=? AND b.hidden=0 AND b.at>=?',
    publicThumb:'SELECT c.thumb AS png FROM craft_floats c JOIN krathongs b ON b.k=c.k WHERE c.k=? AND b.hidden=0 AND b.at>=?',
    publicImage:'SELECT c.png FROM craft_floats c JOIN krathongs b ON b.k=c.k WHERE c.k=? AND b.hidden=0 AND b.at>=?',
    map:'SELECT c.k,c.lon,c.lat,c.place,c.at,b.n FROM craft_floats c JOIN krathongs b ON b.k=c.k WHERE c.at>=? AND b.hidden=0 ORDER BY c.at DESC LIMIT 300'
  })) q[name]=db.prepare(sql);
  const streams = new Map();
  const fail = (status,code) => { throw httpError(status,code); };
  function room(id){
    const row=q.room.get(id, Date.now()-hours48);
    if (!row) fail(404,'room_gone');
    return row;
  }
  function state(row){
    return {rev:row.rev, pieces:JSON.parse(row.pieces), floated:row.floated, lon:row.lon, lat:row.lat};
  }
  function sendState(res,row){ return send(res,200,state(row)); }
  function writeEvent(res,event){
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength>128*1024){res.destroy();return;}
    res.write(event);
  }
  function announce(id,row){
    const group=streams.get(id);
    if (!group) return;
    const event='data: '+JSON.stringify(state(row))+'\n\n';
    for (const res of group) writeEvent(res,event);
  }
  const keepAlive=setInterval(()=>{
    for (const group of streams.values()) for (const res of group) writeEvent(res,': ping\n\n');
  },25000);
  keepAlive.unref();
  function subscribe(res,id,row){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
    let group=streams.get(id);
    if (!group){group=new Set();streams.set(id,group);}
    group.add(res);
    res.on('close',()=>{group.delete(res);if(!group.size)streams.delete(id);});
    writeEvent(res,'retry: 3000\ndata: '+JSON.stringify(state(row))+'\n\n');
  }
  function numeric(v,min,max){
    if (typeof v!=='number' || !Number.isFinite(v) || v<min || v>max) fail(400,'bad_shape');
    return Math.round(v*1000)/1000;
  }
  function cutPath(cut){
    if (cut===null) return null;
    if (!Array.isArray(cut) || cut.length<3 || cut.length>48) fail(400,'bad_cut');
    return cut.map(p=>{
      if (!Array.isArray(p) || p.length!==2) fail(400,'bad_cut');
      return [numeric(p[0],-.5,.5),numeric(p[1],-.5,.5)];
    });
  }
  function png(data,maxSide,maxBytes){
    if (typeof data!=='string' || !data.startsWith('data:image/png;base64,')) fail(400,'bad_png');
    const bytes=Buffer.from(data.slice(22),'base64');
    if (bytes.length>maxBytes) fail(413,'image_too_large');
    if (bytes.length<45 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        bytes.readUInt32BE(8)!==13 || bytes.toString('ascii',12,16)!=='IHDR' ||
        bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND') fail(400,'bad_png');
    const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
    if (!w || !h || w>maxSide || h>maxSide) fail(400,'bad_png_size');
    return bytes;
  }
  function sendImage(req,res,bytes,cache){
    if (!bytes) fail(404,'image_gone');
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':cache});
    res.end(req.method==='HEAD'?undefined:bytes);
  }
  function edit(id,row,op,res){
    if (!op || !pieceKey.test(op.opId) || !pieceKey.test(op.id)) fail(400,'bad_op');
    const seen=JSON.parse(row.recent_ops);
    if (seen.includes(op.opId)) return sendState(res,row);
    if (row.floated) return send(res,409,{error:'already_floated',state:state(row)});
    const pieces=JSON.parse(row.pieces),index=pieces.findIndex(p=>p.id===op.id),rev=row.rev+1;
    if (op.type==='add'){
      if (index>=0) fail(409,'duplicate_piece');
      if (pieces.length>=64) fail(409,'piece_limit');
      if (!materials.has(op.kind)) fail(400,'bad_material');
      const item={id:op.id,kind:op.kind,x:numeric(op.x,0,100),y:numeric(op.y,0,100),size:numeric(op.size,6,82),angle:0,rev};
      if (op.kind==='sticker'){
        if (!imageKey.test(op.asset) || !q.hasSticker.get(id,op.asset)) fail(400,'unknown_sticker');
        item.asset=op.asset;
      }
      pieces.push(item);
    } else {
      const piece=pieces[index];
      if (!piece || piece.rev!==op.expected) return send(res,409,{error:'piece_changed',state:state(row)});
      if (op.type==='remove') pieces.splice(index,1);
      else if (op.type==='front' || op.type==='back'){
        pieces.splice(index,1);if (op.type==='front') pieces.push(piece);else pieces.unshift(piece);piece.rev=rev;
      } else if (op.type==='change'){
        for (const [field,min,max] of [['x',0,100],['y',0,100],['size',6,82],['angle',-180,180]]){
          if (Object.hasOwn(op,field)) piece[field]=numeric(op[field],min,max);
        }
        if (Object.hasOwn(op,'cut')) piece.cut=cutPath(op.cut);
        piece.rev=rev;
      } else fail(400,'bad_op');
    }
    q.save.run(rev,JSON.stringify(pieces),JSON.stringify(seen.slice(-63).concat(op.opId)),Date.now(),id);
    const updated=room(id);announce(id,updated);return sendState(res,updated);
  }
  let mapCache=null;
  function map(req,res){
    if (!mapCache || Date.now()>mapCache.until){
      const body=Buffer.from(JSON.stringify({floats:q.map.all(Date.now()-hours48)}));
      mapCache={body,etag:'"'+crypto.createHash('sha1').update(body).digest('base64url')+'"',until:Date.now()+3000};
    }
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3',ETag:mapCache.etag};
    if (req.headers['if-none-match']===mapCache.etag){res.writeHead(304,headers);return res.end();}
    res.writeHead(200,{...headers,'Content-Length':mapCache.body.length});res.end(req.method==='HEAD'?undefined:mapCache.body);
  }
  async function route(req,res,path){
    const parts=path.slice('/api/workshop/'.length).split('/'),[section,id,action,asset]=parts;
    const read=req.method==='GET'||req.method==='HEAD';
    if(section==='map'&&parts.length===1&&read)return map(req,res);
    if(section==='floats'&&/^[A-Za-z0-9_-]{4,24}$/.test(id)&&read){
      if(parts.length===2){const detail=q.detail.get(id,Date.now()-hours48);if(!detail)fail(404,'float_gone');return send(res,200,detail);}
      if(parts.length===3&&(action==='image.png'||action==='thumb.png')){
        const query=action==='thumb.png'?q.publicThumb:q.publicImage;
        return sendImage(req,res,query.get(id,Date.now()-hours48)?.png,'public, max-age=60');
      }
    }
    if(section!=='rooms')fail(404,'not_found');
    const owner=ownerOf(req);
    if(parts.length===1&&req.method==='POST'){
      if(!owner)fail(401,'missing_token');
      if(!allow('craft-create:'+clientIp(req),60,1)||!allow('craft-room:'+owner,5,1/30))return limited(res,10);
      const location=await readJson(req);
      const lon=location?.lon??100.49,lat=location?.lat??13.743;
      if(!insideThailand(lon,lat,outline))fail(400,'outside_thailand');
      const key=crypto.randomBytes(18).toString('base64url');
      q.create.run(key,JSON.stringify([{id:'banana-base',kind:'base',x:50,y:51,size:66,angle:0,rev:1}]),Date.now(),lon,lat);
      return send(res,201,{id:key,...state(room(key))});
    }
    if(!roomKey.test(id||''))fail(404,'room_gone');
    let row=room(id);
    if(parts.length===2&&req.method==='GET')return sendState(res,row);
    if(parts.length===3&&action==='events'&&req.method==='GET')return subscribe(res,id,row);
    if(parts.length===4&&action==='stickers'&&imageKey.test(asset)&&read)
      return sendImage(req,res,q.sticker.get(id,asset)?.png,'private, max-age=86400');
    if(req.method!=='POST'||parts.length!==3)fail(404,'not_found');
    if(!owner)fail(401,'missing_token');
    if(!allow('craft-edit:'+owner,48,8))return limited(res,2);
    if(action==='ops'){
      const op=await readJson(req,8192);
      return edit(id,room(id),op,res);
    }
    if(action==='stickers'){
      const body=await readJson(req,224*1024);row=room(id);
      if(row.floated)fail(409,'already_floated');
      const bytes=png(body?.image,192,164*1024),hash=crypto.createHash('sha256').update(bytes).digest('hex');
      if(!q.hasSticker.get(id,hash)){
        const space=q.storage.get(id);
        if(space.n>=20 || space.bytes+bytes.length>2*1024*1024)fail(409,'sticker_limit');
        q.insertSticker.run(id,hash,bytes);
      }
      return send(res,200,{asset:hash});
    }
    if(action==='float'){
      const body=await readJson(req,400*1024);row=room(id);
      if(row.floated)return send(res,200,{k:row.floated});
      if(!body||body.rev!==row.rev)return send(res,409,{error:'room_changed',state:state(row)});
      if(!JSON.parse(row.pieces).length)fail(400,'empty_craft');
      if(!allow('post-ip:'+clientIp(req),30,1)||!allow('post:'+owner,3,1/10))return limited(res,5);
      const lon=numeric(body.lon,97,106),lat=numeric(body.lat,5,21);
      if(!insideThailand(lon,lat,outline))fail(400,'outside_thailand');
      const place=places.find(p=>Math.abs(p.lon-lon)<.002&&Math.abs(p.lat-lat)<.002)?.id||'pin';
      const name=cleanText(body.n,24),wish=cleanText(body.w,140);
      if(hasBadWords(name)||hasBadWords(wish))fail(400,'blocked_words');
      const image=png(body.image,256,280*1024),thumb=png(body.thumb,80,28*1024);
      const boat={k:crypto.randomBytes(9).toString('base64url'),t:'suchada',p:0,w:wish,n:name,at:Date.now(),b:0,owner,craft:1};
      persistBoat(boat,()=>{
        q.float.run(boat.k,lon,lat,place,image,thumb,boat.at);q.finish.run(boat.k,boat.at,id);
      });
      mapCache=null;announce(id,room(id));return send(res,201,{k:boat.k});
    }
    fail(404,'not_found');
  }
  return {route,sweep:()=>{q.expire.run(Date.now()-hours48);for(const [id,group] of streams)if(!q.room.get(id,Date.now()-hours48))for(const res of group)res.end();}};
}
module.exports={setupWorkshop};
