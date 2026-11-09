// GLOBAL ATLAS — long-arc archive, historical backfill, hard telemetry and signal checks.
// All sources are free and need no account: IMF PortWatch, GDACS, IODA, SANS ISC (DShield), Yahoo/Stooq.
import fs from 'node:fs/promises';

const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const std = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : null; };
const DATA = new URL('../data/', import.meta.url);
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(new URL(f, DATA))); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFile(new URL(f, DATA), JSON.stringify(o));

export const ARC_DAYS = 400, ARC_FROM = '2019-01';
export function monthsFrom(start, now) { const out = []; let [y, m] = start.split('-').map(Number); const e = iso(now).slice(0, 7);
  for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; out.push(k); if (k >= e) break; m++; if (m > 12) { m = 1; y++; } } return out; }

/* ---------- IMF PortWatch chokepoint transits (daily since 2019, AIS-derived, lags ~4-7 days) ---------- */
const PW = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/';
const PW_NAME = { 'Bab el-Mandeb Strait': 'Bab el-Mandeb', 'Malacca Strait': 'Strait of Malacca' };
async function portwatch(get, log, now) {
  const ports = await get(PW + 'PortWatch_chokepoints_database/FeatureServer/0/query?where=1%3D1&outFields=portid,portname,lat,lon&returnGeometry=false&f=json');
  if (!ports?.features) return null;
  const P = {}; for (const f of ports.features) { const a = f.attributes; P[a.portid] = { name: PW_NAME[a.portname] || a.portname, lat: a.lat, lon: a.lon, months: {}, days: {} }; }
  const stat = encodeURIComponent(JSON.stringify([{ statisticType: 'avg', onStatisticField: 'n_total', outStatisticFieldName: 'v' }]));
  for (let off = 0; off < 8000; off += 1000) {
    const j = await get(PW + `Daily_Chokepoints_Data/FeatureServer/0/query?where=1%3D1&groupByFieldsForStatistics=portid,year,month&outStatistics=${stat}&orderByFields=portid,year,month&resultOffset=${off}&f=json`);
    if (!j?.features) return null;
    for (const f of j.features) { const a = f.attributes; if (P[a.portid]) P[a.portid].months[`${a.year}-${String(a.month).padStart(2, '0')}`] = a.v; }
    if (!j.exceededTransferLimit) break;
  }
  const since = iso(+now - (ARC_DAYS + 10) * DAY);
  for (let off = 0; off < 20000; off += 2000) {
    const j = await get(PW + `Daily_Chokepoints_Data/FeatureServer/0/query?where=${encodeURIComponent(`date >= DATE '${since}'`)}&outFields=portid,date,n_total&orderByFields=ObjectId&resultOffset=${off}&resultRecordCount=2000&returnGeometry=false&f=json`);
    if (!j?.features) break;
    for (const f of j.features) { const a = f.attributes; if (P[a.portid]) P[a.portid].days[typeof a.date === 'number' ? iso(a.date) : String(a.date).slice(0, 10)] = a.n_total; }
    if (!j.exceededTransferLimit && j.features.length < 2000) break;
  }
  for (const p of Object.values(P)) { const b = Object.entries(p.months).filter(([k]) => k < '2023-01').map(([, v]) => v); p.base = mean(b); }
  log('  portwatch ports', Object.keys(P).length, 'days', Object.values(P)[0] && Object.keys(Object.values(P)[0].days).length);
  return P;
}

/* ---------- GDACS archive: Orange/Red droughts, floods and tropical cyclones since 2019 ---------- */
async function gdacsArchive(get, now) {
  const out = [];
  for (const T of ['DR', 'FL', 'TC']) for (let pg = 1; pg <= 8; pg++) {
    const j = await get(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=${T}&fromDate=2019-01-01&toDate=${iso(now)}&alertlevel=Orange;Red&pagenumber=${pg}`);
    const f = j?.features || []; if (!f.length) break;
    for (const e of f) { const p = e.properties, c = e.geometry?.coordinates || [];
      const cs = String(p.country || '').split(',').map(s => s.trim()).filter(Boolean);
      out.push({ type: T, name: T === 'TC' ? (p.eventname ? 'Cyclone ' + p.eventname : 'Tropical cyclone') : cs.length === 1 ? cs[0] : (p.eventname || (T === 'FL' ? 'Flood' : 'Drought')), lat: c[1], lon: c[0], from: Date.parse(p.fromdate), to: Date.parse(p.todate), level: p.alertlevel }); }
    if (f.length < 100) break;
  }
  return out.filter(e => isFinite(e.lat) && isFinite(e.from));
}

/* ---------- IODA yearly outage counts per country ---------- */
async function iodaYears(get, now, prev) {
  const out = { ...(prev || {}) }, Y = new Date(now).getUTCFullYear();
  for (let y = 2019; y <= Y; y++) {
    if (out[y] && y < Y) continue; // past years are final
    // half-year windows keep each query under the API's response time
    const acc = {}; let ok = true;
    for (const [m0, m1] of [[0, 6], [6, 12]]) {
      const from = Math.floor(Date.UTC(y, m0, 1) / 1000), until = Math.floor(Math.min(Date.UTC(y, m1, 1), +now - 36e5) / 1000);
      if (until <= from) continue;
      const url = (a, b) => `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?from=${a}&until=${b}&entityType=country&limit=300`;
      let j = await get(url(from, until), { tries: 1, timeout: 90000 }), parts = j?.data ? [j] : [];
      if (!j?.data) { const mid = Math.floor((from + until) / 2); // fall back to quarters
        for (const [a, b] of [[from, mid], [mid, until]]) { const q = await get(url(a, b), { tries: 2, timeout: 90000 }); if (q?.data) parts.push(q); else { ok = false; break; } } }
      if (!ok) break;
      for (const q of parts) for (const d of q.data) acc[d.entity.name] = (acc[d.entity.name] || 0) + d.event_cnt;
    }
    if (ok) out[y] = acc;
  }
  return out;
}

/* ---------- SANS ISC / DShield: scanning of industrial-control ports ---------- */
export const ICS_PORTS = [[502, 'Modbus'], [102, 'S7comm'], [20000, 'DNP3'], [44818, 'EtherNet/IP'], [47808, 'BACnet']];
async function dshield(get, now) {
  const start = '2019-01-01', to = iso(+now - DAY), ports = {}, n = Math.round((Date.parse(to) - Date.parse(start)) / DAY) + 1;
  for (const [port] of ICS_PORTS) {
    const j = await get(`https://isc.sans.edu/api/porthistory/${port}/${start}/${to}?json`, { wait: 1500, timeout: 60000 });
    if (!j) continue; const arr = new Array(n).fill(0);
    for (const r of Object.values(j)) if (r && r.date) { const i = Math.round((Date.parse(r.date) - Date.parse(start)) / DAY); if (i >= 0 && i < n) arr[i] = +r.sources || 0; }
    ports[port] = arr;
  }
  return Object.keys(ports).length ? { start, ports } : null;
}

/* ---------- backfill cache: heavy historical pulls refreshed daily/weekly ---------- */
export async function backfill(get, log, now) {
  const B = await readJSON('backfill.json', {}), age = k => B[k + '_at'] ? (+now - Date.parse(B[k + '_at'])) / 36e5 : 1e9;
  if (age('portwatch') > 20) { const v = await portwatch(get, log, now); if (v) { B.portwatch = v; B.portwatch_at = now.toISOString(); } }
  if (age('dshield') > 11 || !B.dshield2) { const v = await dshield(get, now); if (v) { B.dshield2 = v; delete B.dshield; B.dshield_at = now.toISOString(); } }
  if (age('gdacs') > 70 || !(B.gdacs || []).some(e => e.type === 'TC')) { const v = await gdacsArchive(get, now); if (v.length) { B.gdacs = v; B.gdacs_at = now.toISOString(); } }
  if (age('ioda') > 70) { B.ioda = await iodaYears(get, now, B.ioda); const Y = new Date(now).getUTCFullYear(); if ([...Array(Y - 2018).keys()].every(i => B.ioda[2019 + i])) B.ioda_at = now.toISOString(); }
  await writeJSON('backfill.json', B);
  return B;
}

/* ---------- daily archive: one compact snapshot per UTC day, kept forever ---------- */
export async function archiveDay(now, hotspots, layers, composite) {
  await fs.mkdir(new URL('daily/', DATA), { recursive: true });
  const f = `daily/${iso(now)}.json`, D = await readJSON(f, { date: iso(now), spots: {} });
  for (const h of hotspots) { if (h.global) continue; const k = h.name + '|' + h.layer, lv = Math.max(1, Math.ceil(h.intensity * 9));
    const o = D.spots[k]; if (!o || lv > o[2]) D.spots[k] = [+h.lat.toFixed(2), +h.lon.toFixed(2), lv, h.n]; }
  D.idx = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.index])); D.composite = composite; D.updated = now.toISOString();
  await writeJSON(f, D);
}

/* ---------- arc.json: per zone, activity level 0-9 per day (last 400d) and per month (since 2019) ---------- */
export async function buildArc(now, B, CENT, log) {
  const months = monthsFrom(ARC_FROM, now), mi = Object.fromEntries(months.map((m, i) => [m, i]));
  const d0 = +new Date(iso(+now - (ARC_DAYS - 1) * DAY)), di = t => Math.floor((t - d0) / DAY);
  const Z = {};
  const zone = (name, layer, lat, lon, src) => { const k = name + '|' + layer; return Z[k] = Z[k] || { name, layer, lat, lon, src: new Set(), d: new Uint8Array(ARC_DAYS), m: new Uint8Array(months.length) }; };
  const mark = (z, t, lv) => { const i = di(t); if (i >= 0 && i < ARC_DAYS) z.d[i] = Math.max(z.d[i], lv); const m = mi[iso(t).slice(0, 7)]; if (m != null) z.m[m] = Math.max(z.m[m], lv); };
  // 1) our own daily archive (news-geolocated + structured hotspots)
  let files = []; try { files = (await fs.readdir(new URL('daily/', DATA))).filter(f => f.endsWith('.json')).sort(); } catch {}
  const first = files[0]?.slice(0, 10) || iso(now);
  for (const f of files) { const D = await readJSON('daily/' + f, null); if (!D) continue; const t = Date.parse(D.date);
    for (const [k, [lat, lon, lv]] of Object.entries(D.spots)) { const [name, layer] = k.split('|'); const z = zone(name, layer, lat, lon); z.src.add('archive'); mark(z, t, lv); } }
  // 2) PortWatch: chokepoints whose traffic deviates >=20% from their 2019-22 normal (closures and reroute surges)
  const info = {};
  if (B.portwatch) for (const p of Object.values(B.portwatch)) {
    if (!p.base || p.base < 3) continue;
    const lvOf = r => { const d = Math.abs(r - 1); return d < .2 ? 0 : clamp(Math.ceil(d / .6 * 9), 1, 9); };
    const z = zone(p.name, 'maritime', p.lat, p.lon);
    for (const [m, v] of Object.entries(p.months)) { const lv = lvOf(v / p.base); if (lv && mi[m] != null) { z.m[mi[m]] = Math.max(z.m[mi[m]], lv); z.src.add('portwatch'); } }
    const ds = Object.keys(p.days).sort(), win = [];
    for (const d of ds) { win.push(p.days[d]); if (win.length > 7) win.shift(); const lv = lvOf(mean(win) / p.base); if (lv) { mark(z, Date.parse(d), lv); z.src.add('portwatch'); } }
    const last7 = ds.slice(-7).map(d => p.days[d]);
    if (last7.length) info[p.name + '|maritime'] = { transits7: +mean(last7).toFixed(1), normal: +p.base.toFixed(1), pct: Math.round((mean(last7) / p.base - 1) * 100), through: ds[ds.length - 1], src: 'IMF PortWatch' };
  }
  // 3) GDACS droughts (Orange/Red), spanning their whole duration
  for (const e of B.gdacs || []) { const z = zone(e.name, e.type === 'TC' ? 'power' : 'water', e.lat, e.lon), lv = e.level === 'Red' ? 9 : 6; z.src.add('gdacs');
    for (let t = Math.max(e.from, Date.parse(ARC_FROM + '-01')); t <= Math.min(e.to || +now, +now); t += DAY) mark(z, t, lv); }
  // 4) IODA yearly outage counts → months of that year
  if (B.ioda) { const all = Object.values(B.ioda).flatMap(y => Object.values(y)).sort((a, b) => a - b), p90 = all[Math.floor(all.length * .9)] || 50, p75 = all[Math.floor(all.length * .75)] || 10;
    for (const [y, cs] of Object.entries(B.ioda)) for (const [name, n] of Object.entries(cs)) { if (n < Math.max(10, p75) || !CENT[name]) continue;
      const lv = clamp(Math.ceil(n / p90 * 9), 1, 9), z = zone(name, 'telecom', CENT[name][0], CENT[name][1]); z.src.add('ioda');
      months.forEach((m, i) => { if (m.startsWith(y + '-')) z.m[i] = Math.max(z.m[i], lv); }); } }
  // 5) UCDP: organized-violence deaths per country per month (final GED + preliminary candidate months)
  if (B.ucdp) { const U = B.ucdp, thru = mi[U.through];
    for (const u of U.zones) { const k = u.name + '|military', z = Z[k] || zone(u.name, 'military', u.lat, u.lon); let hit = false;
      for (const [m, lv] of Object.entries(u.lv)) if (mi[m] != null) { z.m[mi[m]] = Math.max(z.m[mi[m]], lv); hit = true; }
      if (!hit) continue; z.src.add('ucdp');
      info[k] = { kind: 'ucdp', deaths: u.m[U.through] ?? 0, month: U.through, top: u.top, prelim: (U.preliminary_months || []).includes(U.through), thru }; } }
  const enc = a => Array.from(a, v => v).join('');
  const zones = Object.entries(Z).filter(([, z]) => z.m.some(v => v)).map(([k, z]) => ({ name: z.name, layer: z.layer, lat: +(+z.lat).toFixed(2), lon: +(+z.lon).toFixed(2), src: [...z.src], d: enc(z.d), m: enc(z.m), info: info[k] }));
  const cover = { archive: first, portwatch: B.portwatch ? ARC_FROM : null, gdacs: B.gdacs ? ARC_FROM : null, ioda: B.ioda ? ARC_FROM : null, ucdp: B.ucdp ? ARC_FROM : null, ucdp_through: B.ucdp?.through || null };
  log('  arc zones', zones.length);
  return { updated: now.toISOString(), dayStart: iso(d0), days: ARC_DAYS, months, cover, zones };
}

/* ---------- markets: 1y daily closes → 1d/5d change and 5d move in sigma ---------- */
export const MKT = [
  // name, yahoo, stooq, stress direction (+1 up = stress, 0 = either way)
  ['WTI Oil', 'CL=F', 'cl.f', 1], ['Brent', 'BZ=F', 'cb.f', 1], ['Gold', 'GC=F', 'gc.f', 1], ['VIX', '^VIX', 'vi.f', 1], ['Dollar', 'DX-Y.NYB', 'dx.f', 1],
  ['Wheat', 'ZW=F', 'zw.f', 1], ['Shipping (BDRY)', 'BDRY', 'bdry.us', 1, 1], ['EU Gas (TTF)', 'TTF=F', null, 1], ['US Nat Gas', 'NG=F', 'ng.f', 1], ['Rare Earths (REMX)', 'REMX', 'remx.us', 0, 1],
  // sector ETFs: price either way, and unusual volume (positioning ahead of news)
  ['Defense (ITA)', 'ITA', 'ita.us', 0, 1], ['Cyber (CIBR)', 'CIBR', 'cibr.us', 0, 1], ['Semis (SOXX)', 'SOXX', 'soxx.us', 0, 1], ['Utilities (XLU)', 'XLU', 'xlu.us', 0, 1]];
export async function markets(get) {
  const out = [];
  for (const [name, y, s, dir, hasVol] of MKT) {
    let c = null, vz = null;
    const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=1y&interval=1d`, { tries: 1 });
    const q = j?.chart?.result?.[0]?.indicators?.quote?.[0];
    c = q?.close?.filter(v => v != null);
    if (hasVol && q?.volume) { const v = q.volume.filter(x => x != null && x > 0); if (v.length > 70) { const base = v.slice(-66, -3), sd = std(base); if (sd) vz = +((mean(v.slice(-3)) - mean(base)) / sd).toFixed(2); } }
    if ((!c || c.length < 30) && s) { const csv = await get(`https://stooq.com/q/d/l/?s=${s}&i=d`, { type: 'text', tries: 1 });
      c = (csv || '').trim().split('\n').slice(1).map(r => +r.split(',')[4]).filter(v => isFinite(v) && v > 0).slice(-260); }
    if (!c || c.length < 2) { out.push({ name, last: null, chg: null }); continue; }
    const last = c[c.length - 1], prev = c[c.length - 2], r5 = [];
    for (let i = 5; i < c.length; i++) r5.push((c[i] / c[i - 5] - 1) * 100);
    const chg5 = r5[r5.length - 1], sd = std(r5.slice(0, -1)), z5 = sd ? chg5 / sd : null;
    out.push({ name, last, chg: (last - prev) / prev * 100, chg5: +chg5.toFixed(2), z5: z5 != null ? +z5.toFixed(2) : null, vz, dir, etf: !!hasVol, spark: c.slice(-60).map(v => +v.toPrecision(5)) });
  }
  return out;
}

/* ---------- legislation & official action: US Federal Register (rules, proposed rules, presidential documents) ---------- */
const LAW_Q = {
  military: [['foreign-assets-control-office', 'state-department', 'defense-department']],
  maritime: [['federal-maritime-commission', 'maritime-administration']],
  cyber: [['industry-and-security-bureau'], null, 'cybersecurity'],
  power: [['federal-energy-regulatory-commission', 'energy-department']],
  strain: [['agriculture-department']],
  water: [['engineers-corps', 'reclamation-bureau']],
  telecom: [['federal-communications-commission', 'national-telecommunications-and-information-administration']],
};
export async function law(get, now) {
  const since = iso(+now - 98 * DAY), out = {};
  const q = (ag, term) => `https://www.federalregister.gov/api/v1/documents.json?per_page=1000&order=newest&conditions[publication_date][gte]=${since}` +
    (ag ? ag.map(a => `&conditions[agencies][]=${a}`).join('') : '') + (term ? `&conditions[term]=${encodeURIComponent(term)}` : '') +
    '&conditions[type][]=RULE&conditions[type][]=PRORULE&conditions[type][]=PRESDOCU&fields[]=title&fields[]=publication_date&fields[]=html_url&fields[]=type';
  for (const [id, [ag, , term]] of Object.entries(LAW_Q)) {
    const docs = {};
    for (const u of [q(ag), term ? q(null, term) : null].filter(Boolean)) { const j = await get(u, { wait: 400 }); for (const d of j?.results || []) docs[d.html_url] = d; }
    const all = Object.values(docs); if (!all.length && !Object.keys(docs).length) { out[id] = { n7: 0, base: 0, dir: 0, latest: [] }; continue; }
    const t = d => Date.parse(d.publication_date), n7 = all.filter(d => +now - t(d) < 7 * DAY).length, base = all.filter(d => +now - t(d) >= 7 * DAY).length / 13;
    out[id] = { n7, base: +base.toFixed(1), dir: n7 >= Math.max(2, base * 1.8) ? 1 : 0,
      latest: all.sort((a, b) => t(b) - t(a)).slice(0, 3).map(d => ({ title: d.title, url: d.html_url, t: d.publication_date, type: d.type })) };
  }
  return out;
}

/* ---------- signal chain: MONEY → LAW → NEWS → DATA ----------
   Insiders act first, money moves, then policy, then the narrative, then the measured data.
   Headlines are weighted least: they can be pushed. Money, law and measured data are treated as hard. */
const LAYER_MKT = { military: ['Gold', 'VIX', 'Brent', 'Defense (ITA)'], maritime: ['Shipping (BDRY)', 'Brent'], cyber: ['Cyber (CIBR)', 'Semis (SOXX)', 'Rare Earths (REMX)'],
  power: ['EU Gas (TTF)', 'US Nat Gas', 'Utilities (XLU)'], strain: ['Wheat', 'WTI Oil'], water: ['Wheat'] };
export const WEIGHTS = { money: .35, data: .30, law: .15, news: .20 };
export function moneySignal(id, mkts) {
  const M = Object.fromEntries(mkts.map(m => [m.name, m])), c = [];
  for (const n of LAYER_MKT[id] || []) { const m = M[n]; if (!m) continue;
    if (m.z5 != null) c.push({ z: m.dir ? m.z5 * m.dir : Math.abs(m.z5), txt: `${n} ${m.chg5 >= 0 ? '+' : ''}${m.chg5.toFixed(1)}% over 5d (${m.z5 >= 0 ? '+' : ''}${m.z5.toFixed(1)}σ)` });
    if (m.vz != null && m.vz > 0) c.push({ z: m.vz * .8, txt: `${n} volume ${m.vz.toFixed(1)}σ above its 3-month norm` }); }
  if (!c.length) return null; const top = c.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
  return { z: +top.z.toFixed(2), dir: top.z >= 1.5 ? 1 : top.z <= -1.5 ? -1 : 0, txt: top.txt, v01: clamp(.5 + top.z / 4, 0, 1) };
}
export function scoreLayer(parts) { let s = 0, w = 0; for (const [k, v] of Object.entries(parts)) if (v != null && WEIGHTS[k]) { s += WEIGHTS[k] * v; w += WEIGHTS[k]; } return Math.round(100 * s / (w || 1)); }
export function hardSignals(B, now, cur) {
  const H = {};
  if (B.portwatch) { const majors = Object.values(B.portwatch).filter(p => p.base >= 15), off = (p, endIdx) => { const ds = Object.keys(p.days).sort(), w = ds.slice(Math.max(0, ds.length - 7 - endIdx), ds.length - endIdx).map(d => p.days[d]); return w.length ? Math.abs(mean(w) / p.base - 1) >= .25 : false; };
    const a = majors.filter(p => off(p, 0)).length, b = majors.filter(p => off(p, 28)).length, last = Object.keys(majors[0]?.days || {}).sort().pop();
    H.maritime = { v: a, ref: b, dir: a > b ? 1 : a < b ? -1 : 0, v01: clamp(a / Math.max(1, majors.length) * 2.5, 0, 1), txt: `${a} of ${majors.length} major chokepoints running 25%+ off normal (4 wks ago: ${b}) · AIS through ${last}`, src: 'IMF PortWatch' }; }
  if (B.dshield2) { const v = []; for (const arr of Object.values(B.dshield2.ports)) arr.forEach((x, i) => v[i] = (v[i] || 0) + x); if (v.length > 60) { const r7 = mean(v.slice(-7)), base = v.slice(-97, -7), z = (r7 - mean(base)) / (std(base) || 1);
      H.cyber = { v: Math.round(r7), z: +z.toFixed(2), dir: z >= 1.5 ? 1 : z <= -1.5 ? -1 : 0, v01: clamp(.5 + z / 4, 0, 1), txt: `ICS-port scanners (Modbus, S7, DNP3, EtherNet/IP, BACnet): ${Math.round(r7).toLocaleString()}/day, ${z >= 0 ? '+' : ''}${z.toFixed(1)}σ vs 90d`, src: "SANS ISC DShield", spark: v.slice(-90).map(Math.round) }; } }
  if (cur.outageEvents != null && B.ioda) { const Y = new Date(now).getUTCFullYear(), ly = B.ioda[Y - 1]; if (ly) { const base = Object.values(ly).reduce((a, b) => a + b, 0) / 365, r = cur.outageEvents / (base || 1);
    const s = { v: cur.outageEvents, ref: +base.toFixed(1), dir: r >= 1.4 ? 1 : r <= .6 ? -1 : 0, v01: clamp(r / 2, 0, 1), txt: `${cur.outageEvents} internet outage events (24h) vs ${base.toFixed(0)}/day normal (${Y - 1})`, src: 'IODA' }; H.telecom = s; H.power = { ...s }; } }
  if (B.gdacs) { const active = t => B.gdacs.filter(e => /DR|FL/.test(e.type || 'DR') && e.from <= t && (e.to || +now) >= t - 10 * DAY).length, nowN = active(+now), yr = []; for (let i = 7; i < 365; i += 7) yr.push(active(+now - i * DAY));
    const m = mean(yr); H.water = { v: nowN, ref: +m.toFixed(1), dir: nowN >= m * 1.3 + .5 ? 1 : nowN <= m * .7 - .5 ? -1 : 0, v01: clamp(nowN / Math.max(1, m * 2), 0, 1), txt: `${nowN} Orange/Red drought & flood alerts active vs ${m.toFixed(1)} avg over the past year`, src: 'GDACS' }; }
  return H;
}
/* UCDP measured-data signal for the military layer: latest 3 months of state-based battle deaths
   vs the same 3 months a year earlier (direction) and vs every 3-month window since 1989 (level) */
export function ucdpHard(U) {
  if (!U || !U.sb_deaths || U.sb_deaths.length < 27) return null;
  const s = U.sb_deaths, n = s.length, q = i => s[i - 2] + s[i - 1] + s[i];
  const cur = q(n - 1), prev = q(n - 13), all = []; for (let i = 2; i < n; i++) all.push(q(i));
  const p = all.filter(v => v <= cur).length / all.length, r = cur / Math.max(1, prev);
  const mon = i => { const [y, m] = U.months_from.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + i, 1)); return d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) + (i === n - 1 ? ' ' + d.getUTCFullYear() : ''); };
  const A = U.annual[U.annual.length - 1], rec = U.annual.every(a => a[1] <= A[1]), Y = U.ytd;
  const pre = (U.preliminary_months || []).includes(U.through);
  const txt = `Battle deaths ${mon(n - 3)}–${mon(n - 1)}: ${cur.toLocaleString()} vs ${prev.toLocaleString()} a year earlier (${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%) · higher than ${Math.round(p * 100)}% of quarters since 1989`
    + ` · ${A[1]} armed conflicts in ${A[0]}${rec ? ' (most since 1946)' : ''}`
    + (Y ? ` · ${Y.year} so far: ${Y.conflicts}${Y.unassigned ? '–' + (Y.conflicts + Y.unassigned) : ''} (${Y.prev.conflicts} by this point in ${Y.prev.year})` : '')
    + (pre ? ' · preliminary' : '');
  return { v: cur, ref: prev, dir: r >= 1.25 ? 1 : r <= .8 ? -1 : 0, v01: +p.toFixed(3), txt, src: 'UCDP', spark: s.slice(-36), through: U.through };
}
export function narrativeHard(history, spread) {
  if (spread == null) return null; const sp = history.map(h => h.spread).filter(v => v != null), v01 = clamp(spread / 2.5, 0, 1);
  if (sp.length < 6) return { v: spread, dir: 0, v01, txt: `Media-bloc tone spread ${spread} (baseline building)`, src: 'Google News blocs' };
  const m = mean(sp), z = (spread - m) / (std(sp) || .1);
  return { v: spread, dir: z >= 1.5 ? 1 : z <= -1.5 ? -1 : 0, v01, txt: `Media-bloc tone spread ${spread} vs ${m.toFixed(2)} recent avg`, src: 'Google News blocs' };
}
export function signalCheck(layers, money, LAW, H) {
  const out = {};
  for (const [id, L] of Object.entries(layers)) {
    const news = L.surgePct != null ? (L.surgePct >= 25 || (L.delta ?? 0) >= 5 ? 1 : L.surgePct <= -25 && (L.delta ?? 0) <= -3 ? -1 : 0) : 0;
    const mo = money[id] ? money[id].dir : null, lw = LAW[id] ? LAW[id].dir : null, da = H[id] ? H[id].dir : null;
    const read = mo === 1 && news !== 1 ? 'MONEY MOVING FIRST'
      : news === 1 && (mo === 1 || da === 1) ? 'CONFIRMED'
      : news === 1 && da === -1 ? 'CONTRADICTED'
      : news === 1 ? 'NARRATIVE ONLY'
      : lw === 1 ? 'POLICY MOVING'
      : da === 1 ? 'DATA MOVING'
      : [mo, da, news].filter(v => v != null).every(v => v === -1) ? 'EASING' : 'STEADY';
    const lt = LAW[id]?.latest?.[0];
    out[id] = { money: mo, law: lw, news, data: da, read,
      mtxt: money[id]?.txt || '', ltxt: LAW[id] ? `${LAW[id].n7} US rules/orders this week vs ${LAW[id].base}/wk${lt ? ` · latest: ${lt.title}` : ''}` : '', lurl: lt?.url || '',
      dtxt: H[id]?.txt || '', dsrc: H[id]?.src || '' };
  }
  return out;
}
export function fearGauge(mkts) {
  const M = Object.fromEntries(mkts.map(m => [m.name, m])), zs = ['VIX', 'Gold', 'Dollar'].map(n => M[n]?.z5).filter(v => v != null);
  if (!zs.length) return null; const z = mean(zs); return { value: Math.round(clamp(50 + 18 * z, 0, 100)), z: +z.toFixed(2) };
}
export function tier(v) { return v >= 75 ? 'CRITICAL' : v >= 55 ? 'HIGH' : v >= 35 ? 'ELEVATED' : 'WATCH'; }
