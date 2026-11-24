export const materialNames={base:'ฐานต้นกล้วย',leaf:'ใบตอง',fold:'กลีบพับ',lotus:'กลีบบัว',marigold:'ดาวเรือง',candle:'เทียน',sticker:'สติกเกอร์'};
export const pieceSizes={base:61,leaf:30,fold:25,lotus:23,marigold:18,candle:17,sticker:24};
const tau=2*Math.PI;
function oval(c,x,y,rx,ry){c.beginPath();c.ellipse(x,y,rx,ry,0,0,tau);c.fill();}
function grad(c,x1,y1,x2,y2,stops){
  const g=c.createLinearGradient(x1,y1,x2,y2);for(const [n,color] of stops)g.addColorStop(n,color);return g;
}
function leaf(c,fold,lotus){
  c.beginPath();c.moveTo(0,-.48);
  if(fold){c.lineTo(.32,.28);c.quadraticCurveTo(.24,.45,0,.47);c.lineTo(-.31,.31);c.closePath();}
  else{c.bezierCurveTo(.13,-.27,.45,.02,.26,.28);c.bezierCurveTo(.16,.43,.05,.46,0,.48);c.bezierCurveTo(-.18,.42,-.37,.28,-.30,.06);c.bezierCurveTo(-.23,-.16,-.10,-.34,0,-.48);c.closePath();}
  c.fillStyle=lotus?grad(c,-.30,.22,.23,-.30,[[0,'#b7657a'],[.40,'#f2b8b7'],[.66,'#ffe6d4'],[1,'#ce8198']]):grad(c,-.32,.2,.32,-.12,[[0,'#1e543c'],[.46,'#66a251'],[.51,'#a0bb63'],[.57,'#407c44'],[1,'#225f40']]);c.fill();
  c.save();c.clip();
  if(fold){
    c.beginPath();c.moveTo(0,-.48);c.lineTo(-.06,.18);c.lineTo(.32,.28);c.closePath();c.fillStyle='#184e3a9a';c.fill();
    c.strokeStyle='#c3d089';c.lineWidth=.012;c.beginPath();c.moveTo(0,-.48);c.lineTo(-.06,.18);c.lineTo(.32,.28);c.stroke();
  }else{
    for(let i=0;i<16;i++){
      const y=-.35+i*.052;c.lineWidth=.005;c.strokeStyle=lotus?'#ac637a66':'#d1e4926b';c.beginPath();
      c.moveTo(0,y+.12);c.quadraticCurveTo(-.09,y+.055,-.35,y-.11);c.moveTo(0,y+.12);c.quadraticCurveTo(.12,y+.042,.35,y-.11);c.stroke();
    }
    c.lineWidth=.012;c.strokeStyle=lotus?'#f9dfcf':'#c8d987';c.beginPath();c.moveTo(0,.48);c.quadraticCurveTo(-.018,.06,0,-.47);c.stroke();
  }c.restore();
}
function base(c){
  c.fillStyle=grad(c,-.4,-.48,.36,.47,[[0,'#9eb56a'],[.42,'#5e8251'],[1,'#3b643d']]);oval(c,0,.014,.475,.467);
  c.fillStyle=grad(c,-.36,-.37,.35,.37,[[0,'#e2d9aa'],[.52,'#c7c996'],[1,'#a1b17e']]);oval(c,0,-.012,.446,.428);
  for(let i=0;i<140;i++){
    const phi=i*2.39996, r=Math.sqrt((i+.3)/140)*.422, x=Math.cos(phi)*r,y=Math.sin(phi)*r*.97-.009;
    c.fillStyle=i%3?'#72875b50':'#f9f2bbab';oval(c,x,y,.0075,.012);
  }
  c.strokeStyle='#8fa777';c.lineWidth=.009;for(const r of [.38,.403,.437]){c.beginPath();c.ellipse(0,-.008,r,r*.969,0,0,tau);c.stroke();}
}
function marigold(c){
  for(let ring=0;ring<4;ring++){
    const count=18-ring*3, radius=.326-ring*.078;
    for(let j=0;j<count;j++){
      c.save();c.rotate(j*tau/count+.29*ring);c.translate(0,-radius);
      c.fillStyle=grad(c,0,-.15,0,.09,[[0,['#fbc94f','#ffdc60','#ffe179','#ffd34a'][ring]],[.56,'#ed9a26'],[1,'#b96a12']]);
      c.beginPath();c.moveTo(0,.1);c.bezierCurveTo(-.12,.02,-.11,-.091,-.069,-.114);c.quadraticCurveTo(-.048,-.146,-.023,-.116);c.quadraticCurveTo(.007,-.156,.03,-.12);c.quadraticCurveTo(.077,-.141,.083,-.086);c.quadraticCurveTo(.101,-.01,0,.10);c.fill();c.restore();
    }
  }
  c.fillStyle='#bc741a';oval(c,0,0,.078,.078);c.fillStyle='#ffdb69';for(let i=0;i<10;i++)oval(c,.055*Math.cos(i*2.4),.049*Math.sin(i*2.4),.016,.017);
}
function candle(c){
  c.fillStyle='#b69555';oval(c,0,.013,.31,.30);
  c.fillStyle=grad(c,-.26,-.24,.29,.21,[[0,'#ffebbd'],[.5,'#fff7d3'],[1,'#e1ba6b']]);oval(c,0,0,.28,.26);
  c.fillStyle='#564533';oval(c,0,-.015,.026,.038);
  c.fillStyle=grad(c,0,-.43,0,.08,[[0,'#e68026'],[.63,'#ffcc48'],[1,'#fff5c0']]);c.beginPath();c.moveTo(.06,-.46);c.bezierCurveTo(.027,-.27,.20,-.16,.082,-.035);c.bezierCurveTo(-.13,.074,-.12,-.16,-.03,-.26);c.quadraticCurveTo(.02,-.32,.06,-.46);c.fill();
}
export function applyPiece(c,p){
  c.translate(p.x,p.y);c.rotate(p.angle*Math.PI/180);c.scale(p.size,p.size);
}
export function paintMaterial(c,kind,img){
  if(kind==='base')base(c);
  else if(kind==='leaf'||kind==='fold'||kind==='lotus')leaf(c,kind==='fold',kind==='lotus');
  else if(kind==='marigold')marigold(c);
  else if(kind==='candle')candle(c);
  else if(img?.complete&&img.naturalWidth)c.drawImage(img,-.5,-.5,1,1);
}
export function trace(c,points){
  c.beginPath();for(let i=0;i<points.length;i++){const [x,y]=points[i];if(i)c.lineTo(x,y);else c.moveTo(x,y);}c.closePath();
}
export function paintBoard(c,pieces,images,selection,outline){
  const w=c.canvas.width;c.setTransform(w/100,0,0,w/100,0,0);c.clearRect(0,0,100,100);
  for(const p of pieces){
    c.save();applyPiece(c,p);if(p.cut){trace(c,p.cut);c.clip();}
    paintMaterial(c,p.kind,p.asset?images.get(p.asset):null);c.restore();
  }
  if(selection){
    c.save();applyPiece(c,selection);c.lineWidth=1.4*100/(w*selection.size);c.setLineDash([.045,.035]);c.strokeStyle='#fff6d7';c.shadowColor='#173a2b';c.shadowBlur=2;c.strokeRect(-.5,-.5,1,1);c.setLineDash([]);
    if(outline?.length){trace(c,outline);c.fillStyle='#e6f2a83d';c.fill();c.strokeStyle='#284e33';c.lineWidth*=2;c.stroke();}
    c.restore();
  }
}
export function toLocal(p,x,y){
  const a=-p.angle*Math.PI/180,dx=x-p.x,dy=y-p.y;
  return [(dx*Math.cos(a)-dy*Math.sin(a))/p.size,(dx*Math.sin(a)+dy*Math.cos(a))/p.size];
}
export function hit(p,x,y){
  const [u,v]=toLocal(p,x,y);
  if(Math.abs(u)>.5||Math.abs(v)>.5)return false;
  if(p.cut){
    let inside=false;
    for(let i=0,j=p.cut.length-1;i<p.cut.length;j=i++){
      const [a,b]=p.cut[i],[c,d]=p.cut[j];if((b>v)!==(d>v)&&u<(c-a)*(v-b)/(d-b)+a)inside=!inside;
    }
    if(!inside)return false;
  }
  if(p.kind==='base'||p.kind==='marigold')return u*u+v*v<.245;
  if(p.kind==='leaf'||p.kind==='fold'||p.kind==='lotus')return Math.abs(u)<.33;
  return true;
}
