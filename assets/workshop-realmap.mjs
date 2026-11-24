// Real map for the workshop: MapLibre GL + OpenFreeMap "dark" tiles (OpenStreetMap data, no API key).
// Loaded only when it can start; otherwise workshop.mjs keeps the schematic SVG map.
import { Map as MLMap, Marker, NavigationControl, AttributionControl } from './maplibre-gl.mjs';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const THAILAND = [[97.2, 5.5], [105.8, 20.6]];
const hashOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

function div(cls, text){ const e = document.createElement('div'); e.className = cls; if (text) e.textContent = text; return e; }

export function createRealMap({ container, outline, places, onPickPoint, onPickPlace, onFloat, thumbUrl, placeLabel }){
  return new Promise((resolve, reject) => {
    let loaded = false, floatMarkers = [], pin = null;
    const map = new MLMap({
      container, style: STYLE, bounds: THAILAND, fitBoundsOptions: { padding: 12 },
      minZoom: 4, maxZoom: 17, maxPitch: 65, attributionControl: false, renderWorldCopies: false,
    });
    const timer = setTimeout(() => { if (!loaded){ map.remove(); reject(new Error('map style timeout')); } }, 12000);
    map.on('error', (e) => { if (!loaded){ clearTimeout(timer); try { map.remove(); } catch (x) {} reject(e.error || new Error('map error')); } });

    map.addControl(new AttributionControl({ compact: true }));
    map.addControl(new NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');

    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'rm-reset'; reset.textContent = 'ดูทั้งประเทศ';
    reset.addEventListener('click', () => map.fitBounds(THAILAND, { padding: 12, pitch: 0, bearing: 0, duration: 1400 }));
    container.appendChild(reset);

    map.on('load', () => {
      loaded = true; clearTimeout(timer);
      // Thailand's border as a soft glowing line
      const lines = outline.map((ring) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring.concat([ring[0]]) } }));
      map.addSource('th', { type: 'geojson', data: { type: 'FeatureCollection', features: lines } });
      map.addLayer({ id: 'th-glow', type: 'line', source: 'th', paint: { 'line-color': '#ffd88a', 'line-width': 7, 'line-blur': 5, 'line-opacity': .22 } });
      map.addLayer({ id: 'th-line', type: 'line', source: 'th', paint: { 'line-color': '#ffd88a', 'line-width': 1.2, 'line-opacity': .65 } });
      map.addSource('rest', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'rest', type: 'circle', source: 'rest', paint: { 'circle-radius': 3.2, 'circle-color': '#ffcc6a', 'circle-stroke-width': 1, 'circle-stroke-color': '#102f31', 'circle-opacity': .9 } });
      map.on('click', 'rest', (e) => { const f = e.features && e.features[0]; if (f && f.properties.k){ clickedFeature = true; onFloat(f.properties.k); } });
      map.on('mouseenter', 'rest', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'rest', () => { map.getCanvas().style.cursor = ''; });

      // named rivers/lakes as labelled dots (HTML markers use the page's own Thai font)
      for (const p of places){
        const b = document.createElement('button'); b.type = 'button'; b.className = 'rm-place'; b.setAttribute('aria-label', 'เลือกจุดลอย ' + p.name);
        b.append(div('rm-dot'), div('rm-label', p.name.split(' · ')[1] || p.name));
        b.addEventListener('click', (e) => { e.stopPropagation(); onPickPlace(p.id); });
        new Marker({ element: b, anchor: 'left' }).setLngLat([p.lon, p.lat]).addTo(map);
      }
      resolve(api);
    });

    let clickedFeature = false;
    map.on('click', (e) => {
      if (clickedFeature){ clickedFeature = false; return; }
      onPickPoint(e.lngLat.lng, e.lngLat.lat);
    });

    const api = {
      setLoc(lon, lat){
        if (!pin){ const el = div('rm-pin'); el.append(div('rm-ring'), div('rm-core')); pin = new Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map); }
        else pin.setLngLat([lon, lat]);
      },
      flyTo(lon, lat){ map.flyTo({ center: [lon, lat], zoom: 12.2, pitch: 55, bearing: -18, duration: 2400, essential: false }); },
      setFloats(list){
        for (const m of floatMarkers) m.remove(); floatMarkers = [];
        const rest = [];
        list.forEach((f, i) => {
          const h = hashOf(f.k), a = (h % 360) * Math.PI / 180, r = f.place === 'pin' ? 0 : 0.004 + (h % 9) * 0.0016;
          const lon = f.lon + Math.cos(a) * r, lat = f.lat + Math.sin(a) * r * .9;
          if (i < 40){
            const img = document.createElement('img'); img.className = 'rm-float'; img.src = thumbUrl(f.k); img.width = img.height = 44; img.alt = '';
            const b = document.createElement('button'); b.type = 'button'; b.className = 'rm-floatbtn';
            b.setAttribute('aria-label', 'กระทงของ ' + (f.n || 'ผู้ร่วมทำ') + ' ที่ ' + placeLabel(f.place)); b.title = (f.n || 'ผู้ร่วมทำ') + ' · ' + placeLabel(f.place);
            b.style.animationDelay = (-(h % 30) / 10) + 's'; b.appendChild(img);
            b.addEventListener('click', (e) => { e.stopPropagation(); onFloat(f.k); });
            floatMarkers.push(new Marker({ element: b, anchor: 'center' }).setLngLat([lon, lat]).addTo(map));
          } else rest.push({ type: 'Feature', properties: { k: f.k }, geometry: { type: 'Point', coordinates: [lon, lat] } });
        });
        const src = map.getSource('rest'); if (src) src.setData({ type: 'FeatureCollection', features: rest });
      },
      view(){ return { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }; },
      resize(){ map.resize(); },
      remove(){ map.remove(); },
    };
  });
}
