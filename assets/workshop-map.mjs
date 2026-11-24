// Longitudes and latitudes are used both by the editor and by the publishing API.
export const places = [
  { id:'ping', name:'แม่น้ำปิง · เชียงใหม่', lon:99.005, lat:18.788 },
  { id:'yom', name:'แม่น้ำยม · สุโขทัย', lon:99.821, lat:17.008 },
  { id:'bueng', name:'บึงแก่นนคร · ขอนแก่น', lon:102.836, lat:16.415 },
  { id:'mun', name:'แม่น้ำมูล · อุบลราชธานี', lon:104.859, lat:15.225 },
  { id:'ayutthaya', name:'แม่น้ำป่าสัก · อยุธยา', lon:100.583, lat:14.355 },
  { id:'chao', name:'แม่น้ำเจ้าพระยา · กรุงเทพฯ', lon:100.490, lat:13.743 },
  { id:'tapi', name:'แม่น้ำตาปี · สุราษฎร์ธานี', lon:99.327, lat:9.145 },
  { id:'songkhla', name:'ทะเลสาบสงขลา · สงขลา', lon:100.42, lat:7.50 }
];

export function insideThailand(lon, lat, outline){
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  return outline.some(ring => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++){
      const [x,y] = ring[i], [px,py] = ring[j];
      if ((y > lat) !== (py > lat) && lon < (px-x)*(lat-y)/(py-y)+x) inside = !inside;
    }
    return inside;
  });
}
