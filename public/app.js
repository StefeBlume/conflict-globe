import * as THREE from './vendor/three.module.js';

const R = 100;                       // Globusradius
const FOV = 42;
const TIER_COLOR = { war: 0xff3b4e, high: 0xff8a3d, medium: 0xffd23f, low: 0x5ec8f0 };
const TIER_LABEL = { war: 'Krieg', high: 'Hoch', medium: 'Mittel', low: 'Gering' };

const el = (id) => document.getElementById(id);
const canvas = el('globe');

let state = null;
let conflicts = [];
let activeId = null;
let filterTier = 'all';
let searchTerm = '';
let regionFilter = null;      // gewählte Region im Länder-Modus
let shownItems = 12;          // wie viele Meldungen im Panel sichtbar sind

/* ============================ Geometrie ============================ */

function latLonToVec3(lat, lon, r = R) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function vec3ToLatLon(v) {
  const r = v.length();
  const lat = 90 - (Math.acos(v.y / r) * 180) / Math.PI;
  let lon = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return { lat, lon };
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInFeature(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!poly.length) continue;
    if (pointInRing(lon, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) inHole = true;
      if (!inHole) return true;
    }
  }
  return false;
}

/**
 * Mittelpunkt und Ausdehnung einer Geometrie im Bildschirmrahmen.
 * Breite und Hoehe werden getrennt gemessen: ein breites, flaches Land wie die
 * Ukraine braucht einen anderen Abstand als ein hohes, schmales wie Chile.
 */
function geoExtent(geoms) {
  const pts = [];
  for (const g of geoms) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) for (const p of poly[0]) pts.push(p);
  }
  if (!pts.length) return null;

  // Mittelwert ueber 3D-Richtungsvektoren - vermeidet Probleme an der Datumsgrenze.
  const c = new THREE.Vector3();
  for (const [lon, lat] of pts) c.add(latLonToVec3(lat, lon, 1));
  if (c.lengthSq() < 1e-9) return null;
  c.normalize();
  const center = vec3ToLatLon(c);

  // In den Rahmen drehen, in dem der Mittelpunkt zur Kamera (+Z) zeigt.
  const q = new THREE.Quaternion().setFromUnitVectors(c, new THREE.Vector3(0, 0, 1));
  let halfW = 0;
  let halfH = 0;
  let minZ = R;
  const v = new THREE.Vector3();
  for (const [lon, lat] of pts) {
    v.copy(latLonToVec3(lat, lon, R)).applyQuaternion(q);
    if (v.z < 0) continue;                     // Rueckseite ignorieren
    halfW = Math.max(halfW, Math.abs(v.x));
    halfH = Math.max(halfH, Math.abs(v.y));
    minZ = Math.min(minZ, v.z);
  }
  return { lat: center.lat, lon: center.lon, halfW, halfH, depth: minZ };
}

/** Kameraabstand, bei dem das Land den Bildschirm zu `fill` ausfuellt. */
function distanceForExtent(ext, fill = 0.82) {
  const t = Math.tan((FOV * Math.PI) / 360);
  const aspect = Math.max(0.5, camera.aspect || 1.6);
  const needH = Math.max(ext.halfH, 1) / (fill * t);
  const needW = Math.max(ext.halfW, 1) / (fill * t * aspect);
  const d = ext.depth + Math.max(needH, needW);
  return Math.max(116, Math.min(700, d));
}

/* ============================ Szene ============================ */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x05070d, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 5000);

const globeGroup = new THREE.Group();
scene.add(globeGroup);

// Vendor-Dateien werden lange gecacht. Die Version im Query-String erzwingt beim
// Austausch der Textur einen Neuabruf, ohne das Caching aufzugeben.
const ASSET_VERSION = 'ne2-2';

const loader = new THREE.TextureLoader();
const earthTex = loader.load(`./vendor/earth.jpg?v=${ASSET_VERSION}`, () => {
  earthTex.colorSpace = THREE.SRGBColorSpace;
  earthTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  globeMat.needsUpdate = true;
});

const globeMat = new THREE.MeshPhongMaterial({
  map: earthTex,
  specular: new THREE.Color(0x1c3a55),
  shininess: 10,
});

// Die Reliefkarte ist bewusst blass gehalten. Fuer das dunkle Dashboard heben wir
// Sättigung und Kontrast an und dunkeln leicht ab, damit die hellen Grenzlinien tragen.
globeMat.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
     vec3 gc = gl_FragColor.rgb;
     float lum = dot(gc, vec3(0.2126, 0.7152, 0.0722));
     gc = mix(vec3(lum), gc, 1.45);
     gc = (gc - 0.5) * 1.16 + 0.5;
     gc *= 0.88;
     gl_FragColor.rgb = clamp(gc, 0.0, 1.0);`,
  );
};
const globeMesh = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 128), globeMat);
globeGroup.add(globeMesh);

// Atmosphaerensaum wie auf dem Referenzbild
const glowMat = new THREE.ShaderMaterial({
  transparent: true,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  uniforms: { uColor: { value: new THREE.Color(0x5aa9ff) } },
  vertexShader: `
    varying vec3 vN; varying vec3 vP;
    void main(){ vN = normalize(normalMatrix * normal);
      vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz;
      gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `
    uniform vec3 uColor; varying vec3 vN; varying vec3 vP;
    void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 3.0);
      gl_FragColor = vec4(uColor, f * 0.9); }`,
});
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * 1.025, 64, 64), glowMat);
globeGroup.add(atmosphere);

// Gleichmaessige Ausleuchtung - die Textur bringt ihre eigene Beleuchtung mit.
scene.add(new THREE.AmbientLight(0xffffff, 1.55));
const key = new THREE.DirectionalLight(0xffffff, 0.35);
key.position.set(-0.4, 0.5, 1);
scene.add(key);

(function stars() {
  const n = 3000;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 1400 + Math.random() * 1800;
    const t = Math.acos(2 * Math.random() - 1);
    const p = Math.random() * Math.PI * 2;
    pos[i * 3] = r * Math.sin(t) * Math.cos(p);
    pos[i * 3 + 1] = r * Math.cos(t);
    pos[i * 3 + 2] = r * Math.sin(t) * Math.sin(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdce6f5, size: 1.9, sizeAttenuation: false, transparent: true, opacity: 0.8 })));
})();

/* ============================ Ländergrenzen ============================ */

let countryFeatures = [];
const borderGroup = new THREE.Group();
const highlightGroup = new THREE.Group();
globeGroup.add(borderGroup, highlightGroup);

function ringsToPositions(geom, radius) {
  const pts = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = latLonToVec3(ring[i][1], ring[i][0], radius);
        const b = latLonToVec3(ring[i + 1][1], ring[i + 1][0], radius);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }
  return pts;
}

/** Alle Kantenzuege einer Geometrie als [lon,lat]-Paare. */
function geomSegments(geom) {
  const segs = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) segs.push([ring[i], ring[i + 1]]);
    }
  }
  return segs;
}

/**
 * Aussenrand einer Ländergruppe.
 *
 * Die Verwaltungsregionen kacheln das Land lückenlos: eine Kante zwischen zwei
 * Regionen taucht zweimal auf, eine Kante an der Staatsgrenze nur einmal. Genau
 * diese einfachen Kanten bilden die Landesgrenze - deckungsgleich mit den
 * Regionsgrenzen, anders als eine separate Länderdatei es je wäre.
 */
function outerBoundary(features) {
  const count = new Map();
  const store = new Map();
  for (const f of features) {
    for (const [a, b] of geomSegments(f.geometry)) {
      // Richtungsunabhängiger Schlüssel
      const ka = `${a[0]},${a[1]}`;
      const kb = `${b[0]},${b[1]}`;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      count.set(key, (count.get(key) || 0) + 1);
      if (!store.has(key)) store.set(key, [a, b]);
    }
  }
  const outer = [];
  for (const [key, n] of count) if (n === 1) outer.push(store.get(key));
  return outer;
}

/**
 * Linien mit echter Breite. WebGL ignoriert `linewidth` auf nahezu allen
 * Plattformen, deshalb bauen wir je Segment ein Rechteck aus zwei Dreiecken,
 * seitlich versetzt entlang der Kugeloberfläche.
 */
function ribbonGeometry(segments, radius, halfWidth) {
  const pos = [];
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (const [p, q] of segments) {
    const a = latLonToVec3(p[1], p[0], radius);
    const b = latLonToVec3(q[1], q[0], radius);
    dir.subVectors(b, a);
    if (dir.lengthSq() < 1e-9) continue;
    dir.normalize();
    normal.copy(a).normalize();
    side.crossVectors(normal, dir).normalize().multiplyScalar(halfWidth);

    const a1 = a.clone().add(side);
    const a2 = a.clone().sub(side);
    const b1 = b.clone().add(side);
    const b2 = b.clone().sub(side);
    pos.push(a1.x, a1.y, a1.z, a2.x, a2.y, a2.z, b1.x, b1.y, b1.z);
    pos.push(a2.x, a2.y, a2.z, b2.x, b2.y, b2.z, b1.x, b1.y, b1.z);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function buildBorders(geo) {
  countryFeatures = geo.features;
  const base = [];
  for (const f of geo.features) base.push(...ringsToPositions(f.geometry, R * 1.0015));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  borderGroup.add(
    new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0b2136, transparent: true, opacity: 0.78 })),
  );
}

function highlightCountries() {
  highlightGroup.clear();
  for (const c of conflicts) {
    for (const cname of c.countries) {
      const f = countryFeatures.find((x) => x.properties.name === cname);
      if (!f) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(ringsToPositions(f.geometry, R * 1.004), 3));
      highlightGroup.add(
        new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: TIER_COLOR[c.tier], transparent: true, opacity: 0.9 })),
      );
    }
  }
}

/* ============================ Sprites ============================ */

const texCache = new Map();

function glowTexture() {
  if (texCache.has('__glow')) return texCache.get('__glow');
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv);
  texCache.set('__glow', t);
  return t;
}

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/**
 * Tatsächliche Bildfläche einer Glyphe ("ink box").
 *
 * `textBaseline: 'middle'` zentriert die Schriftlinie der Schriftart, nicht das
 * gezeichnete Zeichen. Emoji sitzen darin unterschiedlich hoch, weshalb ein
 * Flugzeug sichtbar aus der Kreismitte rutscht. Deshalb messen wir die echten
 * Ausmaße und rechnen den Versatz heraus.
 */
function inkBox(ctx, text) {
  const m = ctx.measureText(text);
  const left = m.actualBoundingBoxLeft ?? 0;
  const right = m.actualBoundingBoxRight ?? m.width;
  const ascent = m.actualBoundingBoxAscent ?? 0;
  const descent = m.actualBoundingBoxDescent ?? 0;
  return {
    width: left + right,
    height: ascent + descent,
    // Verschiebung, die die Bildfläche exakt auf den Zeichenpunkt zentriert
    dx: (left - right) / 2,
    dy: (ascent - descent) / 2,
  };
}

/** Tatsächlich gezeichnete Pixelgrenzen auf transparentem Grund. */
function pixelBounds(ctx, s) {
  const d = ctx.getImageData(0, 0, s, s).data;
  let minX = s;
  let maxX = -1;
  let minY = s;
  let maxY = -1;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (d[(y * s + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    minX, maxX, minY, maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    cx: (minX + maxX + 1) / 2,
    cy: (minY + maxY + 1) / 2,
  };
}

/**
 * Emoji als Textur - Grundlage der Ereignis-Symbole in der Länderansicht.
 *
 * Zwei Durchgänge: erst probeweise auf transparentem Grund zeichnen und die
 * echten Pixelgrenzen ausmessen, dann mit dem gemessenen Restversatz endgültig
 * setzen. Die Schriftmetriken allein reichen bei Farb-Emoji nicht - sie liegen
 * je nach Zeichen bis zu vier Pixel daneben, was den Kreis sichtbar verrutschen
 * lässt. Nach dem zweiten Durchgang sitzt jede Glyphe pixelgenau mittig.
 */
function emojiTexture(emoji) {
  const key = `e:${emoji}`;
  if (texCache.has(key)) return texCache.get(key);

  const s = 128;
  const cx = s / 2;
  const cy = s / 2;
  const target = s * 0.56;

  const probeCv = document.createElement('canvas');
  probeCv.width = probeCv.height = s;
  const p = probeCv.getContext('2d', { willReadFrequently: true });
  p.textAlign = 'center';
  p.textBaseline = 'alphabetic';

  // Schriftgrad aus den Metriken vorschätzen
  const base = 64;
  p.font = `${base}px ${EMOJI_FONT}`;
  const m0 = inkBox(p, emoji);
  const longest0 = Math.max(m0.width, m0.height) || base;
  let size = Math.max(12, Math.min(96, Math.round((base * target) / longest0)));

  // Durchgang 1: zeichnen und tatsächliche Ausmaße messen
  p.font = `${size}px ${EMOJI_FONT}`;
  const m1 = inkBox(p, emoji);
  p.clearRect(0, 0, s, s);
  p.fillText(emoji, cx + m1.dx, cy + m1.dy);
  const b = pixelBounds(p, s);

  let drawX = cx + m1.dx;
  let drawY = cy + m1.dy;
  if (b) {
    // Größe an der gemessenen Fläche nachziehen ...
    const longest1 = Math.max(b.width, b.height);
    if (longest1 > 0) {
      const scaled = Math.max(12, Math.min(96, Math.round((size * target) / longest1)));
      if (scaled !== size) {
        size = scaled;
        p.font = `${size}px ${EMOJI_FONT}`;
        const m2 = inkBox(p, emoji);
        p.clearRect(0, 0, s, s);
        p.fillText(emoji, cx + m2.dx, cy + m2.dy);
        drawX = cx + m2.dx;
        drawY = cy + m2.dy;
        const b2 = pixelBounds(p, s);
        if (b2) {
          drawX += cx - b2.cx;
          drawY += cy - b2.cy;
        }
      } else {
        // ... und den Restversatz herausrechnen
        drawX += cx - b.cx;
        drawY += cy - b.cy;
      }
    }
  }

  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.beginPath();
  ctx.arc(cx, cy, cx - 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8,14,26,0.9)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.78)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${size}px ${EMOJI_FONT}`;
  ctx.fillText(emoji, drawX, drawY);

  const t = new THREE.CanvasTexture(cv);
  texCache.set(key, t);
  return t;
}

/** Beschriftung als Textur (Ländernamen, Regionsnamen). */
function labelTexture(text) {
  const key = `l:${text}`;
  if (texCache.has(key)) return texCache.get(key);
  const pad = 10;
  const font = '600 34px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const w = Math.ceil(m.measureText(text).width) + pad * 2;
  const h = 52;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(cv);
  t.userData = { w, h };
  texCache.set(key, t);
  return t;
}

/* ============================ Konfliktmarker ============================ */

const markerGroup = new THREE.Group();
const labelGroup = new THREE.Group();
globeGroup.add(markerGroup, labelGroup);
const markers = [];

function buildMarkers() {
  markerGroup.clear();
  labelGroup.clear();
  markers.length = 0;

  for (const c of conflicts) {
    const pos = latLonToVec3(c.lat, c.lon, R * 1.012);
    const color = TIER_COLOR[c.tier];
    const scale = 8 + (c.severity / 100) * 15;

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity: 0.92, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    sprite.position.copy(pos);
    sprite.scale.setScalar(scale);
    sprite.userData.conflictId = c.id;

    const core = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 12), new THREE.MeshBasicMaterial({ color }));
    core.position.copy(pos);
    core.userData.conflictId = c.id;

    markerGroup.add(sprite, core);

    const tex = labelTexture(c.name);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
    label.position.copy(latLonToVec3(c.lat, c.lon, R * 1.05));
    label.userData.aspect = tex.userData.w / tex.userData.h;
    labelGroup.add(label);

    markers.push({ sprite, core, label, conflict: c, baseScale: scale, phase: Math.random() * Math.PI * 2 });
  }
}

/* ============================ Länderansicht ============================ */

const adminGroup = new THREE.Group();
const eventGroup = new THREE.Group();
globeGroup.add(adminGroup, eventGroup);

let admin1 = null;            // erst beim ersten Länder-Zoom geladen
let admin1Loading = null;
let countryMode = null;       // aktive Konflikt-ID in der Länderansicht
const eventMarkers = [];

async function ensureAdmin1() {
  if (admin1) return admin1;
  if (!admin1Loading) {
    admin1Loading = fetch(`./vendor/admin1.geo.json?v=${ASSET_VERSION}`)
      .then((r) => r.json())
      .then((d) => {
        admin1 = d;
        return d;
      })
      .catch(() => {
        admin1 = { features: [] };
        return admin1;
      });
  }
  return admin1Loading;
}

function clearCountryView() {
  disposeGroup(adminGroup);
  disposeGroup(eventGroup);
  eventMarkers.length = 0;
  countryMode = null;
  regionFilter = null;
  highlightGroup.visible = true;
  markerGroup.visible = true;
  el('back-btn').hidden = true;
  const box = el('region-legend');
  box.hidden = true;
  box.innerHTML = '';
}

/** Geometrien und Materialien freigeben - sonst waechst der GPU-Speicher bei jedem Wechsel. */
function disposeGroup(group) {
  for (const child of group.children) {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
    else child.material?.dispose();
  }
  group.clear();
}

async function enterCountryView(c) {
  const data = await ensureAdmin1();
  const codes = new Set([c.iso3, ...(c.extraCountries || [])].filter(Boolean));
  const regions = data.features.filter((f) => codes.has(f.properties.country));
  if (!regions.length) return false;

  disposeGroup(adminGroup);
  disposeGroup(eventGroup);
  eventMarkers.length = 0;
  countryMode = c.id;

  const byCountry = new Map();
  for (const f of regions) {
    const code = f.properties.country;
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(f);
  }

  // Regionsgrenzen des Hauptlands als schmales Band. Eine 1-px-Linie verschwindet
  // auf der hellen Reliefkarte, sobald sie skaliert wird - ein Band mit fester
  // Breite hält die Abstufung zur Staatsgrenze unter jeder Auflösung.
  const mainRegions = byCountry.get(c.iso3) || [];
  const innerSegs = [];
  for (const f of mainRegions) innerSegs.push(...geomSegments(f.geometry));
  if (innerSegs.length) {
    adminGroup.add(
      new THREE.Mesh(
        ribbonGeometry(innerSegs, R * 1.003, 0.021),
        new THREE.MeshBasicMaterial({
          color: 0x243c52,
          transparent: true,
          opacity: 0.8,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      ),
    );
  }

  // Nachbarländer bleiben dünne Linien - sie sind Kontext, nicht Gegenstand.
  const neighbourPts = [];
  for (const [code, feats] of byCountry) {
    if (code === c.iso3) continue;
    for (const f of feats) neighbourPts.push(...ringsToPositions(f.geometry, R * 1.003));
  }
  if (neighbourPts.length) {
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(neighbourPts, 3));
    adminGroup.add(
      new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: 0x33465c, transparent: true, opacity: 0.4 })),
    );
  }
  for (const [code, feats] of byCountry) {
    const outer = outerBoundary(feats);
    if (!outer.length) continue;
    // Das Hauptland kräftiger als die mitgezeichneten Nachbarn.
    // Ein Weltmaß entspricht bei Länderzoom rund 27 Bildpunkten - 0.055 ergibt
    // also eine gut 3 px starke Linie gegenüber 1 px für die Regionsgrenzen.
    const main = code === c.iso3;
    adminGroup.add(
      new THREE.Mesh(
        ribbonGeometry(outer, R * 1.0055, main ? 0.055 : 0.032),
        new THREE.MeshBasicMaterial({
          color: main ? 0x08172a : 0x1b3247,
          transparent: true,
          opacity: main ? 0.95 : 0.72,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      ),
    );
  }

  // Ereignis-Symbole an den Regionen mit Meldungen
  for (const r of c.regions || []) {
    if (!r.anchor) continue;
    const [lon, lat] = r.anchor;
    const pos = latLonToVec3(lat, lon, R * 1.02);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: TIER_COLOR[c.tier], transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.position.copy(pos);
    halo.scale.setScalar(9);
    halo.userData.regionId = r.id;

    const icon = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: emojiTexture(r.event.icon), transparent: true, depthWrite: false }),
    );
    icon.position.copy(latLonToVec3(lat, lon, R * 1.026));
    icon.scale.setScalar(5.2);
    icon.userData.regionId = r.id;

    const name = r.nameDe || r.name;
    const tex = labelTexture(`${name} · ${r.count}`);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95 }));
    label.position.copy(latLonToVec3(lat - 1.4, lon, R * 1.026));
    label.userData.aspect = tex.userData.w / tex.userData.h;

    eventGroup.add(halo, icon, label);
    eventMarkers.push({ halo, icon, label, region: r, phase: Math.random() * Math.PI * 2 });
  }

  // Beim Hineinzoomen stoeren die Übersichtsmarker
  highlightGroup.visible = false;
  markerGroup.visible = false;
  el('back-btn').hidden = false;
  renderRegionLegend(c);

  // Der Bildausschnitt richtet sich nur nach dem Hauptland. Nachbarstaaten werden
  // mitgezeichnet, duerfen den Zoom aber nicht aufreissen (Russland neben der Ukraine).
  const framing = regions.filter((f) => f.properties.country === c.iso3);
  const extent = geoExtent((framing.length ? framing : regions).map((f) => f.geometry));
  if (extent) flyTo(extent.lat, extent.lon, distanceForExtent(extent));
  return true;
}

function renderRegionLegend(c) {
  const box = el('region-legend');

  // Die Leiste gehört ausschliesslich zur Länderansicht. Ohne diese Sperre
  // blendet ein Klick auf einen Regions-Chip im Detailpanel sie auch dann wieder
  // ein, wenn längst wieder die Weltansicht zu sehen ist.
  if (!countryMode || !c || countryMode !== c.id) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  const rs = c.regions || [];
  if (!rs.length) {
    box.innerHTML = '<div class="rl-title">Keine regional zuordenbaren Meldungen</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML =
    `<div class="rl-title">Regionen mit Meldungen</div>` +
    rs
      .map(
        (r) => `<button class="rl-item ${regionFilter === r.id ? 'active' : ''}" data-region="${r.id}">
          <span class="rl-icon">${r.event.icon}</span>
          <span class="rl-name">${escapeHtml(r.nameDe || r.name)}</span>
          <span class="rl-ev">${escapeHtml(r.event.label)}</span>
          <span class="rl-count">${r.count}</span>
        </button>`,
      )
      .join('');
  box.hidden = false;
  for (const b of box.querySelectorAll('.rl-item')) {
    b.addEventListener('click', () => {
      regionFilter = regionFilter === b.dataset.region ? null : b.dataset.region;
      const conf = conflicts.find((x) => x.id === activeId);
      if (conf) {
        renderDetail(conf);
        renderRegionLegend(conf);
      }
    });
  }
}

/* ============================ Steuerung ============================ */

const ctrl = { rotX: 0.22, rotY: -0.6, dist: 340, autoRotate: true, dragging: false };
let lastPointer = { x: 0, y: 0 };
let movedDistance = 0;

canvas.addEventListener('pointerdown', (e) => {
  ctrl.dragging = true;
  movedDistance = 0;
  lastPointer = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* synthetische Events ohne echte Pointer-ID */
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (ctrl.dragging) {
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    movedDistance += Math.abs(dx) + Math.abs(dy);
    // Drehgeschwindigkeit skaliert mit dem Abstand: nah am Boden bewegt ein
    // Pixel weniger Winkel, sonst rutscht die Ansicht beim Zoom davon.
    const s = 0.0019 * Math.min(1, ctrl.dist / 340);
    ctrl.rotY += dx * s;
    ctrl.rotX = Math.max(-1.45, Math.min(1.45, ctrl.rotX + dy * s));
    lastPointer = { x: e.clientX, y: e.clientY };
    ctrl.autoRotate = false;
  } else {
    hover(e);
  }
});

canvas.addEventListener('pointerup', (e) => {
  ctrl.dragging = false;
  canvas.classList.remove('dragging');
  if (movedDistance < 6) pick(e);
});

canvas.addEventListener('pointerleave', () => {
  ctrl.dragging = false;
  canvas.classList.remove('dragging');
  el('tooltip').hidden = true;
});

// Multiplikativer Zoom: gleiche Radbewegung wirkt nah wie fern gleich stark.
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0038);
    ctrl.dist = Math.max(112, Math.min(760, ctrl.dist * factor));
    ctrl.autoRotate = false;
    if (countryMode && ctrl.dist > 430) exitCountryView();
  },
  { passive: false },
);

/* ============================ Picking ============================ */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function toNdc(e) {
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

function regionAt(e) {
  if (!countryMode) return null;
  toNdc(e);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(eventGroup.children, false);
  for (const h of hits) {
    const id = h.object.userData.regionId;
    if (id) {
      const c = conflicts.find((x) => x.id === activeId);
      return (c?.regions || []).find((r) => r.id === id) || null;
    }
  }
  return null;
}

function conflictAt(e) {
  toNdc(e);
  raycaster.setFromCamera(ndc, camera);

  if (markerGroup.visible) {
    const hits = raycaster.intersectObjects(markerGroup.children, false);
    if (hits.length) {
      const id = hits[0].object.userData.conflictId;
      const c = conflicts.find((x) => x.id === id);
      if (c) return c;
    }
  }

  const sphereHit = raycaster.intersectObject(globeMesh, false);
  if (!sphereHit.length) return null;
  const local = globeGroup.worldToLocal(sphereHit[0].point.clone());
  const { lat, lon } = vec3ToLatLon(local);

  for (const c of conflicts) {
    for (const cname of c.countries) {
      const f = countryFeatures.find((x) => x.properties.name === cname);
      if (f && pointInFeature(lon, lat, f.geometry)) return c;
    }
  }
  return null;
}

function hover(e) {
  const tip = el('tooltip');
  const region = regionAt(e);
  if (region) {
    canvas.style.cursor = 'pointer';
    tip.hidden = false;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
    tip.innerHTML = `<b>${region.event.icon} ${escapeHtml(region.nameDe || region.name)}</b><span>${escapeHtml(region.event.label)} · ${region.count} Meldungen</span>`;
    return;
  }

  const c = conflictAt(e);
  if (!c) {
    tip.hidden = true;
    canvas.style.cursor = ctrl.dragging ? 'grabbing' : 'grab';
    return;
  }
  canvas.style.cursor = 'pointer';
  tip.hidden = false;
  tip.style.left = `${e.clientX}px`;
  tip.style.top = `${e.clientY}px`;
  tip.innerHTML = `<b>${escapeHtml(c.name)}</b><span>${TIER_LABEL[c.tier]} · ${c.itemCount} Meldungen${c.newCount ? ` · ${c.newCount} neu` : ''}</span>`;
}

function pick(e) {
  const region = regionAt(e);
  if (region) {
    regionFilter = regionFilter === region.id ? null : region.id;
    const c = conflicts.find((x) => x.id === activeId);
    if (c) {
      renderDetail(c);
      renderRegionLegend(c);
    }
    return;
  }
  const c = conflictAt(e);
  if (c) selectConflict(c.id, true);
}

/* ============================ Rendering ============================ */

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let tick = 0;
function animate() {
  requestAnimationFrame(animate);
  tick += 0.016;

  if (ctrl.autoRotate) ctrl.rotY += 0.0009;
  globeGroup.rotation.y = ctrl.rotY;
  globeGroup.rotation.x = ctrl.rotX;

  camera.position.set(0, 0, ctrl.dist);
  camera.lookAt(0, 0, 0);

  // Sprites in Weltgroesse wachsen beim Zoom ins Riesenhafte. Umrechnung auf
  // konstante Bildschirmgroesse: Welthoehe = Anteil * Abstand * 2*tan(fov/2).
  // Massgeblich ist der Abstand Kamera->Oberflaeche, nicht zum Erdmittelpunkt.
  const surfaceDist = Math.max(12, ctrl.dist - R);
  const perScreen = surfaceDist * 2 * Math.tan((FOV * Math.PI) / 360);
  const labelH = 0.021 * perScreen;
  const regionLabelH = 0.019 * perScreen;
  const iconH = 0.036 * perScreen;

  // Konfliktnamen nur in der Weltansicht und erst aus mittlerer Nähe
  const labelOpacity = !countryMode && ctrl.dist < 320 ? Math.min(1, (320 - ctrl.dist) / 70) : 0;

  for (const m of markers) {
    const speed = 1.1 + (m.conflict.activity / 100) * 2.4;
    const amp = 0.1 + (m.conflict.activity / 100) * 0.28;
    const s = m.baseScale * (1 + Math.sin(tick * speed + m.phase) * amp);
    m.sprite.scale.setScalar(m.conflict.id === activeId ? s * 1.35 : s);
    m.label.material.opacity = labelOpacity;
    if (labelOpacity > 0) m.label.scale.set(m.label.userData.aspect * labelH, labelH, 1);
  }

  for (const em of eventMarkers) {
    const active = regionFilter === em.region.id;
    const pulse = 1 + Math.sin(tick * 2.2 + em.phase) * 0.18;
    const halo = iconH * 1.9 * pulse * (active ? 1.35 : 1);
    em.halo.scale.setScalar(halo);
    const ic = iconH * (active ? 1.25 : 1);
    em.icon.scale.setScalar(ic);
    em.label.scale.set(em.label.userData.aspect * regionLabelH, regionLabelH, 1);
  }

  renderer.render(scene, camera);
}

/** Globus drehen (und optional zoomen), bis der Punkt zur Kamera zeigt. */
function flyTo(lat, lon, targetDist = null) {
  const theta = ((lon + 180) * Math.PI) / 180;
  const targetY = Math.PI / 2 - theta;
  const targetX = (lat * Math.PI) / 180;
  ctrl.autoRotate = false;

  const fromY = ctrl.rotY;
  const fromX = ctrl.rotX;
  const fromD = ctrl.dist;
  const toD = targetDist ?? ctrl.dist;
  const dy = ((((targetY - fromY) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const dx = targetX - fromX;

  const t0 = performance.now();
  const dur = 900;
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    ctrl.rotY = fromY + dy * e;
    ctrl.rotX = fromX + dx * e;
    ctrl.dist = fromD + (toD - fromD) * e;
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

function exitCountryView() {
  clearCountryView();
  const c = conflicts.find((x) => x.id === activeId);
  if (c) {
    renderDetail(c);
    flyTo(c.lat, c.lon, 340);
  } else {
    flyTo(0, 20, 340);
  }
}

/* ============================ UI ============================ */

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function timeAgo(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
}

function renderList() {
  const q = searchTerm.toLowerCase();
  const items = conflicts.filter((c) => {
    if (filterTier !== 'all' && c.tier !== filterTier) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.nameEn || '').toLowerCase().includes(q) ||
      c.region.toLowerCase().includes(q) ||
      c.countries.some((x) => x.toLowerCase().includes(q)) ||
      (c.hotspots || []).some((x) => x.toLowerCase().includes(q))
    );
  });

  el('conflict-list').innerHTML = items
    .map(
      (c) => `
      <li data-id="${c.id}" class="${c.id === activeId ? 'active' : ''}">
        <span class="bar" style="background:#${TIER_COLOR[c.tier].toString(16).padStart(6, '0')}"></span>
        <span>
          <span class="ci-name">${escapeHtml(c.name)}</span>
          <span class="ci-region">${escapeHtml(c.region)}</span>
        </span>
        <span class="ci-right">
          <span class="ci-count">${c.itemCount}</span>
          ${c.newCount ? `<br><span class="ci-new">+${c.newCount}</span>` : ''}
        </span>
      </li>`,
    )
    .join('');

  for (const li of el('conflict-list').querySelectorAll('li')) {
    li.addEventListener('click', () => selectConflict(li.dataset.id, true));
  }
}

function renderDetail(c) {
  const sigChips = (c.signals || [])
    .map((s) => `<span class="chip sig-${s.dir}">${escapeHtml(s.label)} · ${s.count}</span>`)
    .join('');

  const briefingHtml = c.briefing
    ? `<div class="d-sec"><h3>Aktuelle Lageeinschätzung</h3>
         <div class="briefing">
           ${(c.briefing.text || '').split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
           <div class="stamp">Analyse-Update ${timeAgo(c.briefing.updatedAt)}</div>
         </div></div>`
    : '';

  const acledHtml =
    c.acled && !c.acled.error
      ? `<div class="d-sec"><h3>ACLED – Ereignisse (${c.acled.days} Tage)</h3>
           <div class="chips">
             <span class="chip">${c.acled.events} Ereignisse</span>
             <span class="chip">${c.acled.fatalities} Todesopfer</span>
           </div></div>`
      : '';

  const regionChips = (c.regions || []).length
    ? `<div class="d-sec"><h3>Betroffene Regionen</h3><div class="chips">
         ${c.regions.map((r) => `<span class="chip region-chip ${regionFilter === r.id ? 'active' : ''}" data-region="${r.id}">${r.event.icon} ${escapeHtml(r.nameDe || r.name)} · ${r.count}</span>`).join('')}
       </div></div>`
    : '';

  let list = c.items || [];
  let filterNote = '';
  if (regionFilter) {
    const r = (c.regions || []).find((x) => x.id === regionFilter);
    list = list.filter((i) => i.region && i.region.id === regionFilter);
    filterNote = `<div class="filter-note">Gefiltert: ${escapeHtml(r ? r.nameDe || r.name : '')} <button id="clear-region">alle zeigen</button></div>`;
  }

  const visible = list.slice(0, shownItems);
  const news = visible.length
    ? `<ul class="news">${visible
        .map(
          (i) => `<li>
            <a href="${escapeHtml(i.url)}" target="_blank" rel="noopener noreferrer">
              <span class="n-ev" title="${escapeHtml(i.event?.label || '')}">${i.event?.icon || '📄'}</span>${escapeHtml(i.title)}
            </a>
            <div class="n-meta">
              ${i.isNew ? '<span class="n-badge">NEU</span>' : ''}
              <span class="n-src">${escapeHtml(i.source)}</span>
              <span>·</span><span>${timeAgo(i.date)}</span>
              ${i.region ? `<span class="n-region">${escapeHtml(i.region.nameDe || i.region.name)}</span>` : ''}
              ${i.sourceType !== 'news' ? `<span class="n-type ${escapeHtml(i.sourceType)}">${i.sourceType === 'analysis' ? 'Analyse' : 'Humanitär'}</span>` : ''}
            </div>
          </li>`,
        )
        .join('')}</ul>
       ${list.length > visible.length ? `<button id="more-btn" class="more-btn">${list.length - visible.length} weitere Meldungen anzeigen</button>` : ''}`
    : '<p class="empty">Für diese Auswahl liegen aktuell keine Meldungen vor.</p>';

  el('detail-body').innerHTML = `
    <span class="d-tier ${c.tier}">${TIER_LABEL[c.tier]}</span>
    <h2>${escapeHtml(c.name)}</h2>
    <div class="d-sub">${escapeHtml(c.region)} · seit ${escapeHtml(c.since)}</div>

    <div class="d-metrics">
      <div class="d-metric"><b>${c.severity}</b><span>Intensität</span></div>
      <div class="d-metric"><b>${c.activity}</b><span>Aktivität</span></div>
      <div class="d-metric"><b>${c.newCount}</b><span>neue Meldungen</span></div>
    </div>

    ${briefingHtml}
    ${sigChips ? `<div class="d-sec"><h3>Signale im aktuellen Nachrichtenfenster</h3><div class="chips">${sigChips}</div></div>` : ''}
    ${regionChips}
    <div class="d-sec"><h3>Hintergrund</h3><p>${escapeHtml(c.background)}</p></div>
    <div class="d-sec"><h3>Konfliktparteien</h3><div class="chips">${(c.parties || []).map((p) => `<span class="chip">${escapeHtml(p)}</span>`).join('')}</div></div>
    <div class="d-sec"><h3>Brennpunkte</h3><div class="chips">${(c.hotspots || []).map((p) => `<span class="chip">${escapeHtml(p)}</span>`).join('')}</div></div>
    ${acledHtml}
    <div class="d-sec"><h3>Meldungen (${list.length})</h3>${filterNote}${news}</div>
  `;

  el('more-btn')?.addEventListener('click', () => {
    shownItems += 20;
    renderDetail(c);
  });
  el('clear-region')?.addEventListener('click', () => {
    regionFilter = null;
    renderDetail(c);
    renderRegionLegend(c);
  });
  for (const chip of el('detail-body').querySelectorAll('.region-chip')) {
    chip.addEventListener('click', () => {
      regionFilter = regionFilter === chip.dataset.region ? null : chip.dataset.region;
      renderDetail(c);
      renderRegionLegend(c);
    });
  }
}

async function selectConflict(id, zoom = false) {
  const c = conflicts.find((x) => x.id === id);
  if (!c) return;
  const changed = activeId !== id;
  activeId = id;
  if (changed) {
    shownItems = 12;
    regionFilter = null;
  }

  renderDetail(c);
  el('detail').classList.remove('hidden');
  renderList();
  el('conflict-list').querySelector(`li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  if (zoom) {
    const ok = await enterCountryView(c);
    if (!ok) flyTo(c.lat, c.lon, 260);
    else renderDetail(c);
  }
}

el('close-detail').addEventListener('click', () => {
  el('detail').classList.add('hidden');
  activeId = null;
  clearCountryView();
  renderList();
});
el('back-btn').addEventListener('click', exitCountryView);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && countryMode) exitCountryView();
});
el('search').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderList();
});
for (const b of el('filters').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    el('filters').querySelector('.active')?.classList.remove('active');
    b.classList.add('active');
    filterTier = b.dataset.tier;
    renderList();
  });
}

function renderHeader() {
  el('stat-conflicts').textContent = state.totals.conflicts;
  el('stat-articles').textContent = state.totals.articles;
  el('stat-new').textContent = state.totals.newArticles;
  el('updated').textContent = `Aktualisiert ${timeAgo(state.generatedAt)}`;

  const feeds = state.sources?.feeds || [];
  const ok = feeds.filter((f) => f.ok).length;
  el('info-updated').textContent =
    `Letzter Datenabruf ${timeAgo(state.generatedAt)} · ${ok} von ${feeds.length} Quellen erreichbar · ` +
    `${state.totals.articles} Meldungen aus ${state.totals.conflicts} Konflikten.`;
}

el('info-btn').addEventListener('click', () => {
  const p = el('info-panel');
  p.hidden = !p.hidden;
});
el('info-close').addEventListener('click', () => {
  el('info-panel').hidden = true;
});

/* ============================ Start ============================ */

/**
 * Datenstand holen. Lokal liefert der Node-Server /api/state und mischt die
 * Lageeinschätzungen live ein; auf statischem Hosting (GitHub Pages) gibt es
 * keinen Server, dort liegt derselbe Datensatz als Datei.
 */
async function loadState(opts = {}) {
  try {
    const res = await fetch('./api/state', opts);
    if (res.ok) return await res.json();
  } catch {
    /* kein Server - statische Auslieferung */
  }
  const res = await fetch('./data/state.json', opts);
  if (!res.ok) throw new Error(`Datenstand nicht erreichbar (HTTP ${res.status})`);
  return res.json();
}

async function boot() {
  const [geo, st] = await Promise.all([
    fetch('./vendor/countries.geo.json').then((r) => r.json()),
    loadState(),
  ]);

  state = st;
  conflicts = st.conflicts;

  buildBorders(geo);
  highlightCountries();
  buildMarkers();
  renderList();
  renderHeader();
  animate();

  el('loading').classList.add('done');
  setTimeout(() => (el('loading').style.display = 'none'), 450);

  setInterval(renderHeader, 60000);
  setInterval(refresh, 120000);
}

async function refresh() {
  try {
    const st = await loadState({ cache: 'no-store' });
    if (st.generatedAt === state.generatedAt) return;
    state = st;
    conflicts = st.conflicts;
    highlightCountries();
    buildMarkers();
    renderList();
    renderHeader();
    if (activeId) {
      const c = conflicts.find((x) => x.id === activeId);
      if (c) renderDetail(c);
    }
  } catch {
    /* Server nicht erreichbar - beim naechsten Intervall erneut versuchen */
  }
}

// Debug-Hook für Diagnose in der Browser-Konsole.
window.__cg = {
  ctrl,
  adminGroup,
  eventGroup,
  globeGroup,
  get conflicts() {
    return conflicts;
  },
  get countryMode() {
    return countryMode;
  },
  conflictAt,
  enterCountryView,
  latLonAt(clientX, clientY) {
    toNdc({ clientX, clientY });
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(globeMesh, false);
    if (!hit.length) return null;
    return vec3ToLatLon(globeGroup.worldToLocal(hit[0].point.clone()));
  },
};

boot().catch((err) => {
  el('loading').innerHTML = `<p style="color:#ff8a3d">Fehler beim Laden: ${escapeHtml(err.message)}</p>`;
  console.error(err);
});
