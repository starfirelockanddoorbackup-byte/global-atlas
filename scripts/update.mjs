// GLOBAL ATLAS — telemetry pull. Runs every 4 hours in GitHub Actions (Node 20, no dependencies).
// Pulls open-source signals, scores 8 stress layers, finds regions where layers stack up,
// and writes data/latest.json + data/history.json for the static site.
import fs from 'node:fs/promises';
import { marketHistory, liveMarkets, lawWeekly, rawSeries, calibrate, tierBy, pct } from './calib.mjs';
import { backfill, archiveDay, buildArc, law, hardSignals, narrativeHard, moneySignal, scoreLayer, signalCheck, fearGauge, tier } from './extra.mjs';

const UA = 'GlobalAtlas/1.0 (+https://github.com/starfirelockanddoorbackup-byte/global-atlas)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = new Date();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sources = {};

async function get(url, { type = 'json', tries = 2, wait = 0, backoff = 6000, timeout = 25000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (wait) await sleep(wait);
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      return type === 'json' ? JSON.parse(t) : t;
    } catch (e) { log('  fail', url.slice(0, 80), e.message); if (i < tries - 1) await sleep(backoff * (i + 1)); }
  }
  return null;
}

/* ---------------- layers ---------------- */
const GN = {
  military: '"airstrike" OR "missile strike" OR "drone strike" OR shelling OR "troop buildup" OR "military drills" OR "naval drills"',
  maritime: 'tanker OR "container ship" OR "shipping lane" OR "shipping disruption" OR "freight rates" OR "port closure" OR chokepoint',
  cyber: 'cyberattack OR ransomware OR SCADA OR "industrial control" OR hackers OR "critical infrastructure" cyber',
  narrative: 'disinformation OR propaganda OR "state media" OR censorship OR "information warfare" OR deepfake',
  power: '"power outage" OR blackout OR "load shedding" OR "grid failure" OR "power cuts" OR substation',
  strain: '"food prices" OR famine OR "food insecurity" OR hunger OR "fuel shortage" OR hyperinflation',
  water: 'drought OR "water shortage" OR aquifer OR "water crisis" OR "water rationing" OR desalination',
  telecom: '"internet outage" OR "undersea cable" OR "subsea cable" OR "GPS jamming" OR "internet shutdown" OR "cable cut"'
};
const LAYERS = [
  { id: 'military',  q: '("airstrike" OR "missile strike" OR "drone strike" OR "shelling" OR "troop buildup" OR "military exercise" OR "naval drills" OR "artillery")' },
  { id: 'maritime',  q: '("shipping lane" OR "tanker" OR "container ship" OR "cargo ship" OR "port closure" OR "shipping disruption" OR "freight rates" OR "chokepoint")' },
  { id: 'cyber',     q: '("cyberattack" OR "ransomware" OR "SCADA" OR "industrial control system" OR "hackers" OR "critical infrastructure attack" OR "data breach")' },
  { id: 'narrative', q: '("disinformation" OR "propaganda" OR "state media" OR "censorship" OR "information warfare" OR "deepfake")' },
  { id: 'power',     q: '("power outage" OR "blackout" OR "load shedding" OR "grid failure" OR "substation" OR "power cuts")' },
  { id: 'strain',    q: '("food prices" OR "famine" OR "food insecurity" OR "hunger" OR "fuel shortage" OR "hyperinflation" OR "cost of living")' },
  { id: 'water',     q: '("drought" OR "water shortage" OR "aquifer" OR "water crisis" OR "dam failure" OR "desalination" OR "water rationing")' },
  { id: 'telecom',   q: '("internet outage" OR "undersea cable" OR "subsea cable" OR "GPS jamming" OR "internet shutdown" OR "communications blackout" OR "cable cut")' },
];

/* ---------------- gazetteer: headline → region ---------------- */
const CENT = JSON.parse(await fs.readFile(new URL('./centroids.json', import.meta.url)));
const PLACES = [
  // chokepoints & seas first (more specific)
  ['Taiwan Strait', 24.2, 119.6, ['taiwan strait']], ['South China Sea', 12, 114, ['south china sea', 'spratly', 'scarborough', 'paracel']],
  ['Strait of Hormuz', 26.6, 56.3, ['hormuz']], ['Bab el-Mandeb', 12.6, 43.3, ['bab el-mandeb', 'bab al-mandab']], ['Red Sea', 20, 38.5, ['red sea', 'houthi']],
  ['Suez Canal', 30.6, 32.3, ['suez']], ['Panama Canal', 9.1, -79.7, ['panama canal']], ['Strait of Malacca', 2.5, 101.5, ['malacca']],
  ['Baltic Sea', 58.5, 20, ['baltic']], ['Black Sea', 43.4, 34, ['black sea', 'crimea', 'odesa', 'odessa', 'sevastopol']], ['North Sea', 56, 3, ['north sea']],
  ['Arctic', 75, 40, ['arctic', 'svalbard']], ['Persian Gulf', 27, 51, ['persian gulf', 'gulf of oman']], ['East China Sea', 29, 125, ['east china sea', 'senkaku']],
  ['Korean Peninsula', 38.3, 127.5, ['north korea', 'pyongyang', 'dprk', 'korean peninsula']], ['Kashmir', 34, 75.5, ['kashmir']],
  ['Gaza', 31.4, 34.4, ['gaza', 'rafah']], ['West Bank', 31.9, 35.25, ['west bank']], ['Sahel', 15, 0, ['sahel', 'burkina faso', 'mali', 'niger ']],
  ['Horn of Africa', 8, 46, ['somalia', 'horn of africa', 'ethiopia', 'eritrea']], ['Texas', 31, -99, ['texas', 'ercot']], ['California', 37, -120, ['california']],
  ['Puerto Rico', 18.2, -66.5, ['puerto rico']], ['Kyiv', 50.45, 30.5, ['kyiv', 'kiev']], ['Donbas', 48.2, 38, ['donbas', 'donetsk', 'luhansk', 'bakhmut', 'pokrovsk', 'zaporizhzhia', 'kharkiv', 'kherson']],
  ['Moscow', 55.75, 37.6, ['moscow', 'kremlin']], ['Beijing', 39.9, 116.4, ['beijing']], ['Washington', 38.9, -77, ['pentagon', 'white house', 'washington']],
  // countries
  ['Ukraine', 49, 31.5, ['ukraine', 'ukrainian']], ['Russia', 58, 45, ['russia', 'russian']], ['Taiwan', 23.7, 121, ['taiwan']], ['China', 35, 104, ['china', 'chinese']],
  ['Israel', 31.4, 35, ['israel', 'israeli', 'idf']], ['Lebanon', 33.9, 35.9, ['lebanon', 'hezbollah', 'beirut']], ['Syria', 35, 38.5, ['syria']], ['Iran', 32.5, 53.7, ['iran', 'iranian', 'tehran']],
  ['Iraq', 33, 43.7, ['iraq', 'baghdad']], ['Yemen', 15.5, 47.5, ['yemen']], ['Saudi Arabia', 24, 45, ['saudi']], ['Turkey', 39, 35, ['turkey', 'türkiye', 'ankara']],
  ['Sudan', 15.5, 30, ['sudan', 'khartoum', 'darfur']], ['Egypt', 26.8, 30.8, ['egypt', 'cairo']], ['Libya', 27, 17, ['libya']], ['Nigeria', 9.1, 8.7, ['nigeria']],
  ['South Africa', -29, 25, ['south africa', 'eskom']], ['DR Congo', -2.9, 23.6, ['congo', 'goma', 'kinshasa']], ['Kenya', 0.2, 37.9, ['kenya', 'nairobi']],
  ['India', 22, 79, ['india', 'indian', 'delhi', 'mumbai']], ['Pakistan', 30, 70, ['pakistan', 'karachi', 'islamabad']], ['Afghanistan', 33.9, 67.7, ['afghanistan', 'taliban', 'kabul']],
  ['Bangladesh', 23.7, 90.3, ['bangladesh', 'dhaka']], ['Myanmar', 21.9, 95.9, ['myanmar', 'burma']], ['Japan', 36.2, 138.2, ['japan', 'tokyo']], ['Philippines', 12.9, 121.8, ['philippines', 'manila']],
  ['Indonesia', -2.5, 118, ['indonesia', 'jakarta']], ['Vietnam', 14, 108, ['vietnam']], ['Australia', -25, 134, ['australia']], ['Kazakhstan', 48, 67, ['kazakhstan']],
  ['Poland', 52, 19.4, ['poland', 'polish', 'warsaw']], ['Finland', 64, 26, ['finland', 'finnish']], ['Sweden', 62, 15, ['sweden', 'swedish']], ['Norway', 62, 10, ['norway']],
  ['Estonia', 58.6, 25, ['estonia']], ['Latvia', 56.9, 24.6, ['latvia']], ['Lithuania', 55.2, 23.9, ['lithuania']], ['Germany', 51.2, 10.4, ['germany', 'german', 'berlin']],
  ['France', 46.6, 2.2, ['france', 'french', 'paris']], ['United Kingdom', 54, -2, ['britain', 'british', ' uk ', 'london', 'england']], ['Spain', 40.4, -3.7, ['spain', 'spanish', 'madrid']],
  ['Italy', 42.8, 12.5, ['italy', 'italian', 'rome']], ['Greece', 39, 22, ['greece']], ['Serbia', 44, 20.9, ['serbia', 'kosovo', 'balkan']], ['Georgia', 42.3, 43.4, ['tbilisi']],
  ['Armenia', 40.1, 45, ['armenia', 'azerbaijan', 'karabakh']], ['Venezuela', 7, -66, ['venezuela', 'caracas']], ['Colombia', 4.6, -74, ['colombia']], ['Mexico', 23.6, -102.5, ['mexico', 'mexican']],
  ['Haiti', 19, -72.3, ['haiti']], ['Cuba', 21.5, -79.5, ['cuba', 'havana']], ['Brazil', -14, -51.9, ['brazil']], ['Argentina', -38.4, -63.6, ['argentina']], ['Chile', -35.7, -71.5, ['chile']],
  ['Peru', -9.2, -75, ['peru']], ['Canada', 56, -106, ['canada', 'canadian']], ['United States', 39.8, -98.6, ['united states', ' u.s.', ' us ', 'american']],
];
function locate(text) {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9.\- ]/g, ' ') + ' ';
  for (const [name, lat, lon, keys] of PLACES) if (keys.some(k => t.includes(k))) return { name, lat, lon };
  return null;
}

/* ---------------- GDELT (news event signals) ---------------- */
const GD = 'https://api.gdeltproject.org/api/v2/doc/doc?format=json&query=';
const parseTL = j => (j && j.timeline && j.timeline[0] && j.timeline[0].data || []).map(p => ({ t: Date.parse(p.date.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z')), v: +p.value }));
function split24(pts) {
  const cut = now - 864e5, a = pts.filter(p => p.t >= cut), b = pts.filter(p => p.t < cut && p.t >= now - 8 * 864e5);
  return { a, b };
}
const NEG = /\b(kill|killed|dead|deaths|attack|attacks|strike|strikes|war|crisis|collapse|shortage|famine|outage|blackout|threat|warn|warning|surge|soar|explosion|missile|drone|hack|hacked|breach|sanction|emergency|severe|fear|clash|clashes|disrupt|disruption|cut|seized|jamming|shutdown|riot|protest|flee|starv)/gi;
const POS = /\b(restor|resum|ease|eases|eased|recover|ceasefire|deal|agreement|reopen|reopens|calm|aid|relief|repair|repaired|stabil)/gi;
const lexTone = arr => { if (!arr.length) return null; let n = 0, p = 0; for (const a of arr) { n += ((a.title || '').match(NEG) || []).length; p += ((a.title || '').match(POS) || []).length; } return +(-((n - p) / arr.length) * 3).toFixed(2); };
async function googleNews(q, ed = 'US', extra = '') {
  const lang = { US: 'en-US', GB: 'en-GB', IN: 'en-IN', AU: 'en-AU', SG: 'en-SG', ZA: 'en-ZA' }[ed] || 'en-US';
  const x = await get(`https://news.google.com/rss/search?q=${encodeURIComponent('(' + q + ')' + (extra ? ' (' + extra + ')' : '') + ' when:7d')}&hl=${lang}&gl=${ed}&ceid=${ed}:en`, { type: 'text', tries: 2, wait: 1200 });
  if (!x) return null;
  return rssItems(x).map(s => { const t = tag(s, 'title'), src = tag(s, 'source'); return { title: src && t.endsWith(' - ' + src) ? t.slice(0, -(src.length + 3)) : t, url: tag(s, 'link'), domain: src, t: Date.parse(tag(s, 'pubDate')) }; })
    .filter(a => a.t && now - a.t < (extra ? 7 : 1) * 864e5);
}
let gdeltDown = 0; // circuit breaker: GDELT rate-limits GitHub runners most of the time
async function gdeltVol(L) {
  if (gdeltDown >= 2) return null;
  const q = encodeURIComponent(L.q + ' sourcelang:english');
  const vol = parseTL(await get(GD + q + '&mode=timelinevolraw&timespan=8d', { wait: 9000, tries: 3, backoff: 20000 }));
  const V = split24(vol); if (!V.a.length || !V.b.length) { gdeltDown++; return null; }
  gdeltDown = 0;
  const sum = a => a.reduce((s, p) => s + p.v, 0), days = Math.max(1, (V.b[V.b.length - 1].t - V.b[0].t) / 864e5);
  return { vol24: sum(V.a), volBase: sum(V.b) / days };
}
async function gdeltLayer(L) {
  const arts = (await googleNews(GN[L.id])) || [];
  const g = await gdeltVol(L);
  return { vol24: g ? g.vol24 : null, volBase: g ? g.volBase : null, tone24: lexTone(arts), arts, ok: arts.length > 0, gdelt: !!g, n24: arts.length };
}
/* ---------------- structured feeds ---------------- */
const rssItems = xml => [...(xml || '').matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(m => m[0]);
const tag = (s, n) => { const m = s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };

async function cisaICS() {
  const x = await get('https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml', { type: 'text' });
  if (!x) return null;
  const items = rssItems(x).map(s => ({ title: tag(s, 'title'), url: tag(s, 'link'), t: Date.parse(tag(s, 'pubDate')) })).filter(i => i.t);
  const d1 = items.filter(i => now - i.t < 864e5).length, d7 = items.filter(i => now - i.t < 7 * 864e5).length;
  return { d1, d7, latest: items.slice(0, 5) };
}
async function cisaKEV() {
  const j = await get('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
  if (!j || !j.vulnerabilities) return null;
  const d = j.vulnerabilities.map(v => ({ ...v, t: Date.parse(v.dateAdded) }));
  return { d1: d.filter(v => now - v.t < 2 * 864e5).length, d7: d.filter(v => now - v.t < 7 * 864e5).length, latest: d.sort((a, b) => b.t - a.t).slice(0, 3).map(v => ({ title: `${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`, t: v.t })) };
}
async function ioda() {
  const until = Math.floor(now / 1000), from = until - 86400;
  const j = await get(`https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?from=${from}&until=${until}&entityType=country&format=codf&limit=200`)
        || await get(`https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=${from}&until=${until}&entityType=country&limit=500`);
  const arr = j && (Array.isArray(j.data) ? j.data : (j.data && j.data.events) || []);
  if (!arr) return null;
  const byC = {};
  for (const e of arr) { const ent = e.entity || e.location || {}; const name = ent.name || e.location_name; if (!name) continue; byC[name] = (byC[name] || 0) + 1; }
  return { events: arr.length, countries: Object.entries(byC).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n) };
}
async function gdacs() {
  const x = await get('https://www.gdacs.org/xml/rss.xml', { type: 'text' });
  if (!x) return null;
  return rssItems(x).map(s => ({ title: tag(s, 'title'), url: tag(s, 'link'), type: tag(s, 'gdacs:eventtype'), level: tag(s, 'gdacs:alertlevel'),
    lat: parseFloat(tag(s, 'geo:lat')), lon: parseFloat(tag(s, 'geo:long')), t: Date.parse(tag(s, 'pubDate')), country: tag(s, 'gdacs:country') }))
    .filter(e => isFinite(e.lat) && isFinite(e.lon));
}
/* ---------------- run ---------------- */
log('GLOBAL ATLAS telemetry pull');
const [ics, kev, outages, disasters, MH] = [await cisaICS(), await cisaKEV(), await ioda(), await gdacs(), await marketHistory(get)];
const mkts = liveMarkets(MH);
sources.cisa_ics = !!ics; sources.cisa_kev = !!kev; sources.ioda = !!outages; sources.gdacs = !!disasters; sources.markets = mkts.some(m => m.last != null);
log('structured', JSON.stringify(sources));

const histPath = new URL('../data/history.json', import.meta.url);
let history = []; try { history = JSON.parse(await fs.readFile(histPath)); } catch {}
log('backfill + law');
const B = await backfill(get, log, now);
sources.portwatch = !!B.portwatch; sources.dshield = !!B.dshield2; sources.gdacs_archive = !!B.gdacs; sources.ioda_history = !!B.ioda;
const LAW = await law(get, now); sources.federal_register = Object.values(LAW).some(l => l.latest.length);
const H = hardSignals(B, now, { outageEvents: outages ? outages.events : null });
const money = {}; for (const L of LAYERS) money[L.id] = moneySignal(L.id, mkts);
// calibration: every hard component as a percentile of its own ~3-year history; tiers from a replay of the past year
log('calibrate');
const LW = await lawWeekly(get); sources.law_history = Object.keys(LW).length > 0;
const RS = rawSeries(now, MH, LW, B), TODAY = {};
for (const L of LAYERS) { const c = RS.S[L.id] || {}, t = {};
  for (const k of Object.keys(c)) t[k] = c[k][c[k].length - 1];
  if (LAW[L.id]) t.law = (LAW[L.id].n7 + 1) / (LAW[L.id].base + 1);
  TODAY[L.id] = t; }
const CAL = calibrate(now, RS, TODAY);
const mAsOf = mkts.map(m => m.asOf).filter(Boolean).sort().pop(), mStale = mAsOf ? (+now - Date.parse(mAsOf + 'T21:00:00Z')) > 30 * 36e5 : false;
if (mStale) for (const id of Object.keys(money)) if (money[id]) money[id].txt += ` (as of ${new Date(mAsOf + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} close)`;
const lawV = id => CAL.parts[id]?.law ?? (LAW[id] ? clamp(.5 + (LAW[id].n7 / Math.max(1, LAW[id].base) - 1) / 3, 0, 1) : null);
log('  thresholds', JSON.stringify(CAL.thr), 'composite', JSON.stringify(CAL.thrComp));
const layers = {}, hotspots = [], counts = {};
for (const L of LAYERS) {
  log('layer', L.id);
  const g = await gdeltLayer(L);
  sources['news_' + L.id] = g.ok; if (g.gdelt) sources.gdelt = true; else sources.gdelt = sources.gdelt || false;
  // stress index 0–100: coverage surge vs 7-day baseline + negativity of tone + structured signal
  const pastN = history.slice(-42).map(h => h.n && h.n[L.id]).filter(v => v != null);
  const baseN = pastN.length ? pastN.reduce((a, b) => a + b, 0) / pastN.length : null;
  const ratio = g.volBase ? g.vol24 / g.volBase : baseN ? g.n24 / Math.max(1, baseN) : 1;
  counts[L.id] = g.n24;
  const surge = clamp((ratio - .6) / 1.4, 0, 1);
  const neg = g.tone24 != null ? clamp((-g.tone24) / 4, 0, 1) : .5;
  let struct = 0, note = '';
  if (L.id === 'cyber' && (ics || kev)) { struct = clamp(((ics?.d7 || 0) + 2 * (kev?.d7 || 0)) / 40, 0, 1); note = `${ics?.d7 ?? '—'} ICS advisories · ${kev?.d7 ?? '—'} exploited CVEs added (7d)`; }
  if ((L.id === 'telecom' || L.id === 'power') && outages) { struct = clamp(outages.countries.length / 25, 0, 1); note = `${outages.countries.length} countries with internet outage signals (24h)`; }
  if (L.id === 'water' && disasters) { const dr = disasters.filter(d => /DR|FL/.test(d.type)); struct = clamp(dr.length / 12, 0, 1); note = `${dr.length} active drought/flood alerts`; }
  if (L.id === 'cyber' && H.cyber) struct = Math.max(struct, H.cyber.v01);
  if (L.id === 'maritime' && H.maritime) { struct = H.maritime.v01; note = H.maritime.txt; }
  if (L.id === 'strain' && money.strain) note = money.strain.txt;
  if (L.id === 'water' && H.water) note = H.water.txt;
  const hasData = ['cyber', 'telecom', 'power', 'water', 'maritime'].includes(L.id) && (struct || H[L.id]);
  // data: percentile of history where we have it (maritime, cyber, water, power-cyclones); live ratios otherwise
  let data = hasData ? struct : null; const cd = CAL.parts[L.id]?.data;
  if (cd != null) data = L.id === 'power' ? Math.max(cd, H.power?.v01 ?? 0) : cd;
  // news: percentile of this layer's own headline pressure across past pulls (neutral until ~2 days of history)
  const newsRaw = .55 * surge + .45 * neg, pastNews = history.map(h => h.nv?.[L.id]).filter(v => v != null);
  const news01 = pastNews.length >= 12 ? pct(newsRaw, pastNews) : .5;
  const parts = { news: news01, money: CAL.parts[L.id]?.money ?? money[L.id]?.v01 ?? null, law: lawV(L.id), data };
  const index = scoreLayer(parts);
  // hotspots from geolocated headlines
  const byPlace = {};
  for (const a of g.arts) {
    const p = locate(a.title || ''); if (!p) continue;
    const k = p.name; byPlace[k] = byPlace[k] || { ...p, layer: L.id, n: 0, items: [] };
    byPlace[k].n++; const at = a.t || Date.parse(a.seendate) || 0; byPlace[k].last = Math.max(byPlace[k].last || 0, at); if (byPlace[k].items.length < 4) byPlace[k].items.push({ title: a.title, url: a.url, src: a.domain, t: at || undefined });
  }
  const spots = Object.values(byPlace).sort((a, b) => b.n - a.n).slice(0, 14);
  const top = spots[0]?.n || 1;
  spots.forEach(s => { s.intensity = +(s.n / top).toFixed(2); hotspots.push(s); });
  layers[L.id] = { index, newsRaw: +newsRaw.toFixed(3), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v == null ? null : +v.toFixed(2)])), volume24: g.vol24 ?? g.n24, volumeBase: g.volBase ? Math.round(g.volBase) : baseN ? Math.round(baseN) : null, surgePct: (g.volBase || baseN) ? Math.round((ratio - 1) * 100) : null,
    tone24: g.tone24 != null ? +g.tone24.toFixed(2) : null, toneBase: g.toneBase != null ? +g.toneBase.toFixed(2) : null, note, articles: g.arts.length };
}
// structured hotspots
if (outages) outages.countries.slice(0, 15).forEach(c => { const ll = CENT[c.name]; if (ll) hotspots.push({ name: c.name, lat: ll[0], lon: ll[1], layer: 'telecom', n: c.n, intensity: clamp(c.n / (outages.countries[0].n || 1), .2, 1), items: [{ title: `Internet connectivity drop detected (${c.n} signal${c.n > 1 ? 's' : ''}, IODA)`, url: 'https://ioda.inetintel.cc.gatech.edu/', src: 'IODA' }] }); });
if (disasters) disasters.filter(d => /DR/.test(d.type)).slice(0, 10).forEach(d => hotspots.push({ name: d.country || 'Drought zone', lat: d.lat, lon: d.lon, layer: 'water', n: 1, intensity: d.level === 'Red' ? 1 : d.level === 'Orange' ? .7 : .45, items: [{ title: d.title, url: d.url, src: 'GDACS' }] }));
if (ics) ics.latest.slice(0, 3).forEach(i => hotspots.push({ name: 'ICS advisory', lat: 38.9, lon: -77.03, layer: 'cyber', n: 1, intensity: .5, items: [{ title: i.title, url: i.url, src: 'CISA' }], global: 1 }));

// narrative divergence: tone spread across national media blocs on the same conflict news
const BLOCS = [['US', 'unitedstates'], ['UK', 'unitedkingdom'], ['Russia', 'russia'], ['China', 'china'], ['India', 'india'], ['Qatar', 'qatar']];
const div = [];
for (const [label, sc] of BLOCS) {
  const j = sources.gdelt ? await get(GD + encodeURIComponent(LAYERS[0].q + ' sourcecountry:' + sc) + '&mode=timelinetone&timespan=24h', { wait: 9000, tries: 2, backoff: 15000 }) : null;
  const pts = parseTL(j); if (pts.length) div.push({ bloc: label, tone: +(pts.reduce((s, p) => s + p.v, 0) / pts.length).toFixed(2) });
}
if (div.length < 2) { div.length = 0;
  const MB = [['Western wires', 'site:reuters.com OR site:apnews.com OR site:bbc.com OR site:bbc.co.uk'], ['Russian state', 'site:rt.com OR site:tass.com OR site:sputnikglobe.com'],
    ['Chinese state', 'site:globaltimes.cn OR site:cgtn.com OR site:xinhuanet.com OR site:chinadaily.com.cn'], ['Gulf / Arab', 'site:aljazeera.com OR site:arabnews.com OR site:thenationalnews.com'],
    ['Indian', 'site:thehindu.com OR site:indiatimes.com OR site:ndtv.com OR site:hindustantimes.com'], ['Iranian state', 'site:presstv.ir OR site:tehrantimes.com']];
  for (const [bloc, sites] of MB) { const a = await googleNews(GN.military + ' OR war OR conflict', 'US', sites); const t = a && a.length >= 3 ? lexTone(a) : null; if (t != null) div.push({ bloc, tone: t, n: a.length }); } }
if (div.length >= 2) {
  const tones = div.map(d => d.tone), spread = Math.max(...tones) - Math.min(...tones);
  const n = layers.narrative; n.divergence = { spread: +spread.toFixed(2), blocs: div };
  const sps = history.map(h => h.spread).filter(v => v != null);
  n.parts.data = +(sps.length >= 12 ? pct(spread, sps) : clamp(spread / 2.5, 0, 1)).toFixed(2); n.index = scoreLayer(n.parts);
  n.note = `Tone spread across ${div.length} media blocs: ${spread.toFixed(1)} pts`;
}

// convergence: regions where several layers fire at once
const byRegion = {};
for (const h of hotspots) { if (h.global) continue; (byRegion[h.name] = byRegion[h.name] || { name: h.name, lat: h.lat, lon: h.lon, layers: {}, n: 0 }); byRegion[h.name].layers[h.layer] = (byRegion[h.name].layers[h.layer] || 0) + h.n; byRegion[h.name].n += h.n; }
const convergence = Object.values(byRegion).map(r => ({ ...r, count: Object.keys(r.layers).length })).filter(r => r.count >= 2)
  .sort((a, b) => b.count - a.count || b.n - a.n).slice(0, 10);

// history + deltas
const H2 = history.filter(h => h.v === 2), ref = [...H2].reverse().find(h => now - Date.parse(h.t) >= 20 * 36e5) || H2[0];
for (const [id, L] of Object.entries(layers)) {
  const prev = ref?.idx?.[id];
  L.delta = prev != null ? L.index - prev : null;
  L.trend = L.delta == null ? 'NEW' : L.delta >= 3 ? 'WORSE' : L.delta <= -3 ? 'BETTER' : 'STEADY';
}
// signal chain
const spread = layers.narrative.divergence ? layers.narrative.divergence.spread : null;
const nh = narrativeHard(history, spread); if (nh) H.narrative = nh;
// measured data at a multi-year extreme counts as "up" even if it eased slightly vs a month ago
for (const [id, L] of Object.entries(layers)) { const dp = L.parts.data; if (dp == null || !H[id] || !CAL.parts[id]?.data) continue;
  if (dp >= .85 && H[id].dir !== 1) { H[id].dir = 1; H[id].txt += ` · worse than ${Math.round(dp * 100)}% of days since 2019`; }
  else if (dp <= .15 && H[id].dir !== -1) { H[id].dir = -1; H[id].txt += ` · calmer than ${Math.round((1 - dp) * 100)}% of days since 2019`; } }
const signal = signalCheck(layers, money, LAW, H), fear = fearGauge(mkts);
for (const [id, L] of Object.entries(layers)) { L.tier = tierBy(L.index, CAL.thr[id]); L.thr = CAL.thr[id] || null; }
let prev = null; try { prev = JSON.parse(await fs.readFile(new URL('../data/latest.json', import.meta.url))); } catch {}
const NM = { military: 'Military', maritime: 'Maritime & Supply', cyber: 'Cyber & ICS', narrative: 'Narrative', power: 'Power & Grid', strain: 'Subsistence & Strain', water: 'Water', telecom: 'Telecom & Subsea' };
const EXPL = { 'MONEY MOVING FIRST': 'markets moving before the headlines', 'POLICY MOVING': 'new US rules/orders ahead of the headlines', 'DATA MOVING': 'measured data moving, headlines quiet',
  CONFIRMED: 'headlines backed by money or data', CONTRADICTED: 'headlines up, measured data down', 'NARRATIVE ONLY': 'headlines up, nothing hard behind them yet' };
const moves = [];
if (prev && prev.layers) {
  const RANK = { WATCH: 0, ELEVATED: 1, HIGH: 2, CRITICAL: 3 };
  for (const [id, L] of Object.entries(layers)) { const pt = prev.calib ? prev.layers[id]?.tier : null; // no tier moves across the switch to calibrated tiers
    if (pt && pt !== L.tier) moves.push({ kind: 'tier', layer: id, dir: RANK[L.tier] > RANK[pt] ? 1 : -1, txt: `${NM[id]}: ${pt} → ${L.tier}` }); }
  for (const [id, S] of Object.entries(signal)) { const ps = prev.signal?.[id]?.read;
    if (ps !== S.read && EXPL[S.read]) moves.push({ kind: 'signal', layer: id, dir: ['CONTRADICTED', 'NARRATIVE ONLY'].includes(S.read) ? 0 : 1, txt: `${NM[id]}: ${S.read.toLowerCase()} (${EXPL[S.read]})` }); }
  const pc = new Set((prev.convergence || []).map(r => r.name));
  for (const r of convergence) if (!pc.has(r.name)) moves.push({ kind: 'stack', lat: r.lat, lon: r.lon, name: r.name, dir: 1, txt: `Now stacking: ${r.name} (${r.count} layers)` });
  const ph = new Set((prev.hotspots || []).map(h => h.name + '|' + h.layer));
  hotspots.filter(h => !h.global && h.intensity >= .5 && !ph.has(h.name + '|' + h.layer)).slice(0, 5).forEach(h => moves.push({ kind: 'new', layer: h.layer, lat: h.lat, lon: h.lon, name: h.name, dir: 1, txt: `New flashpoint: ${h.name} (${NM[h.layer]})` }));
}
log('archive');
await archiveDay(now, hotspots, layers, Math.round(Object.values(layers).reduce((s, l) => s + l.index, 0) / LAYERS.length));
await fs.writeFile(new URL('../data/arc.json', import.meta.url), JSON.stringify(await buildArc(now, B, CENT, log)));
history.push({ t: now.toISOString(), v: 2, nv: Object.fromEntries(Object.entries(layers).map(([k, l]) => [k, l.newsRaw])), n: counts, spread, fear: fear?.value, chain: Object.fromEntries(Object.entries(signal).map(([k, v]) => [k, [money[k]?.z ?? null, LAW[k]?.n7 ?? null, layers[k].surgePct, H[k]?.dir ?? null]])), idx: Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.index])) });
history = history.filter(h => now - Date.parse(h.t) < 30 * 864e5);
const composite = Math.round(Object.values(layers).reduce((s, l) => s + l.index, 0) / LAYERS.length);

const out = { updated: now.toISOString(), next: new Date(+now + 4 * 36e5).toISOString(), composite, compositeTier: tierBy(composite, CAL.thrComp), calib: { thr: CAL.thr, thrComp: CAL.thrComp, replay: CAL.replay, method: 'percentile vs ~3y history; tiers: top 25% / 8% / 2% of past-year days' }, marketsAsOf: mAsOf, marketsStale: mStale, fear, signal, hard: H, law: LAW, weights: { money: .35, data: .30, law: .15, news: .20 }, moves: moves.slice(0, 10), layers, hotspots, convergence, macro: mkts,
  feeds: { ics: ics ? { d1: ics.d1, d7: ics.d7, latest: ics.latest.slice(0, 3) } : null, kev: kev ? { d1: kev.d1, d7: kev.d7, latest: kev.latest } : null,
    outages: outages ? outages.countries.slice(0, 12) : null, disasters: disasters ? disasters.slice(0, 12).map(({ title, url, type, level, country }) => ({ title, url, type, level, country })) : null },
  sources };
await fs.writeFile(new URL('../data/latest.json', import.meta.url), JSON.stringify(out));
await fs.writeFile(histPath, JSON.stringify(history));
log('done', 'composite', composite, 'hotspots', hotspots.length, 'stacking regions', convergence.length);
