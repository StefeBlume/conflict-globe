#!/usr/bin/env node
// Baut public/vendor/admin1.geo.json: Verwaltungsgrenzen (Bundesländer, Provinzen,
// Oblaste) fuer alle Konfliktlaender - inklusive Namensvarianten fuer die
// Regionserkennung in Meldungen und einem Ankerpunkt je Region.
//
//   node scripts/build-admin1.mjs [pfad/zu/ne_10m_admin_1_states_provinces.geojson]
//
// Quelle (40 MB, Public Domain):
// https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
const OUT = path.join(ROOT, 'public', 'vendor', 'admin1.geo.json');

if (!SRC || !fs.existsSync(SRC)) {
  console.error('Quelldatei fehlt. Aufruf: node scripts/build-admin1.mjs <ne_10m_admin_1_states_provinces.geojson>');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'conflicts.json'), 'utf8'));
const wanted = new Set(cfg.conflicts.map((c) => (c.iso3 || '').toUpperCase()).filter(Boolean));
// Nachbarn, die in Konflikten mitspielen (Russland fuer die Ukraine, Israel fuer Gaza).
for (const extra of ['RUS', 'ISR', 'IND', 'PAK', 'CHN', 'KHM', 'THA', 'AZE', 'ARM', 'SRB', 'GUY']) wanted.add(extra);

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
// 3 Nachkommastellen ~ 100 m Genauigkeit. Zwei Stellen sparen zwar Platz, erzeugen
// aber eine Treppenstruktur entlang der Grenzen, die eine kraeftig gezeichnete
// Staatsgrenze als Zackenband sichtbar macht.
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const roundCoords = (c) => (Array.isArray(c[0]) ? c.map(roundCoords) : [round(c[0]), round(c[1])]);

/** Aufeinanderfolgende identische Punkte entfernen, die durch das Runden entstehen. */
function dedupeRing(ring) {
  const out = [];
  for (const pt of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
  }
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push(out[0]);
  }
  return out;
}

/** Winzige Inseln weglassen - sie kosten Platz und sind beim Zoom unsichtbar. */
function simplify(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const kept = [];
  for (const poly of polys) {
    const rings = poly.map(dedupeRing).filter((r) => r.length >= 4);
    if (!rings.length) continue;
    const r = rings[0];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if ((maxX - minX) * (maxY - minY) < 0.002) continue;
    kept.push(rings);
  }
  if (!kept.length) return null;
  return kept.length === 1
    ? { type: 'Polygon', coordinates: kept[0] }
    : { type: 'MultiPolygon', coordinates: kept };
}

/** Flaechenschwerpunkt des groessten Rings - Ankerpunkt fuer Marker. */
function anchor(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f;
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-12) continue;
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = [round(cx / (6 * a), 3), round(cy / (6 * a), 3)];
    }
  }
  return best;
}

/** Alle brauchbaren Schreibweisen einer Region - Grundlage der Meldungszuordnung. */
function aliases(p) {
  const raw = [
    p.name, p.name_en, p.name_de, p.name_local, p.woe_name, p.gn_name,
    p.name_ru, p.name_uk, p.name_ar, p.name_fr, p.name_es, p.name_tr, p.name_fa,
    ...String(p.name_alt || '').split('|'),
  ];
  const out = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'string') continue;
    const s = r.trim();
    if (s.length < 3) continue;
    out.add(s);
    // Apostrophe und diakritische Zeichen sind in Nachrichtentexten selten:
    // "Donets'k" -> "Donetsk", "Zaporizhzhya" bleibt zusaetzlich erhalten.
    const plain = s.replace(/['’`]/g, '');
    if (plain !== s) out.add(plain);
  }
  return [...out];
}

const features = [];
for (const f of src.features) {
  const p = f.properties || {};
  if (!wanted.has(String(p.adm0_a3 || '').toUpperCase())) continue;
  const rounded = { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) };
  const geometry = simplify(rounded);
  if (!geometry) continue;
  const a = anchor(geometry);
  if (!a) continue;
  features.push({
    type: 'Feature',
    geometry,
    properties: {
      id: p.adm1_code,
      country: p.adm0_a3,
      name: p.name_en || p.name,
      nameDe: p.name_de || null,
      type: p.type_en || p.type || null,
      code: p.iso_3166_2 || null,
      anchor: a,
      aliases: aliases(p),
    },
  });
}

const out = { type: 'FeatureCollection', features };
fs.writeFileSync(OUT, JSON.stringify(out));

const byCountry = {};
for (const f of features) byCountry[f.properties.country] = (byCountry[f.properties.country] || 0) + 1;
console.log(`${features.length} Regionen aus ${Object.keys(byCountry).length} Ländern`);
console.log(`Datei: ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
console.log('Regionen je Land:', Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' '));
