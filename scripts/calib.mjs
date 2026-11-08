// GLOBAL ATLAS — calibration against history.
// Every hard component (money, law, measured data) is scored as a percentile of its own multi-year history,
// so "80" means "more unusual than 80% of days since ~2023", not an arbitrary scale.
// Tiers are then set by replaying the past year: ELEVATED = top 25% of days, HIGH = top 8%, CRITICAL = top 2%.
import { MKT } from './extra.mjs';

const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const std = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : null; };
export const pct = (x, arr) => { if (x == null || !arr.length) return null; let lo = 0, eq = 0; for (const v of arr) { if (v < x) lo++; else if (v === x) eq++; } return (lo + eq / 2) / arr.length; };
const quant = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export const W = { money: .35, data: .30, law: .15, news: .20 };
export const LAYER_MKT = { military: ['Gold', 'VIX', 'Brent', 'Defense (ITA)'], maritime: ['Shipping (BDRY)', 'Brent'], cyber: ['Cyber (CIBR)', 'Semis (SOXX)', 'Rare Earths (REMX)'],
  power: ['EU Gas (TTF)', 'US Nat Gas', 'Utilities (XLU)'], strain: ['Wheat', 'WTI Oil'], water: ['Wheat'] };

/* ---------- 5 years of daily market history (Yahoo, Stooq fallback) ---------- */
export async function marketHistory(get) {
  const H = {};
  for (const [name, y, s, dir, hasVol] of MKT) {
    let d = null, c = null, v = null;
    const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?range=5y&interval=1d`, { tries: 1 });
    const r = j?.chart?.result?.[0], q = r?.indicators?.quote?.[0];
    if (r?.timestamp && q?.close) { d = []; c = []; v = hasVol ? [] : null;
      r.timestamp.forEach((t, i) => { if (q.close[i] == null) return; d.push(iso(t * 1000)); c.push(q.close[i]); if (v) v.push(q.volume?.[i] || 0); }); }
    if ((!c || c.length < 60) && s) { const csv = await get(`https://stooq.com/q/d/l/?s=${s}&i=d`, { type: 'text', tries: 1 });
      const rows = (csv || '').trim().split('\n').slice(1).map(r => r.split(',')).filter(r => +r[4] > 0).slice(-1260);
      if (rows.length > 60) { d = rows.map(r => r[0]); c = rows.map(r => +r[4]); v = hasVol ? rows.map(r => +r[5] || 0) : null; } }
    if (c && c.length > 30) H[name] = { d, c, v, dir, etf: !!hasVol };
  }
  return H;
}

/* per trading day: 5-day move in sigma (vs trailing year) and 3-day volume surge in sigma (vs prior quarter) */
function marketRaw(m) {
  const n = m.c.length, z = new Array(n).fill(null), vz = new Array(n).fill(null), r5 = new Array(n).fill(null);
  for (let i = 5; i < n; i++) r5[i] = (m.c[i] / m.c[i - 5] - 1) * 100;
  for (let i = 60; i < n; i++) { const w = r5.slice(Math.max(5, i - 252), i).filter(x => x != null), sd = std(w); if (sd) z[i] = r5[i] / sd; }
  if (m.v) for (let i = 68; i < n; i++) { const base = m.v.slice(i - 66, i - 3).filter(x => x > 0), sd = std(base); if (sd && m.v[i]) vz[i] = (mean(m.v.slice(i - 2, i + 1)) - mean(base)) / sd; }
  // stress value: signed move for stress-direction markets, absolute move otherwise; volume surges count when positive
  const raw = z.map((zz, i) => { if (zz == null) return null; const p = m.dir ? zz * m.dir : Math.abs(zz), q = vz[i] != null && vz[i] > 0 ? vz[i] * .8 : -9; return Math.max(p, q); });
  return { r5, z, vz, raw };
}
export function liveMarkets(MH) {
  const out = [];
  for (const [name, , , dir, hasVol] of MKT) {
    const m = MH[name]; if (!m) { out.push({ name, last: null, chg: null }); continue; }
    const R = marketRaw(m), n = m.c.length, last = m.c[n - 1], prev = m.c[n - 2];
    out.push({ name, last, chg: (last - prev) / prev * 100, chg5: R.r5[n - 1] != null ? +R.r5[n - 1].toFixed(2) : null, z5: R.z[n - 1] != null ? +R.z[n - 1].toFixed(2) : null,
      vz: R.vz[n - 1] != null ? +R.vz[n - 1].toFixed(2) : null, dir, etf: !!hasVol, asOf: m.d[n - 1], spark: m.c.slice(-60).map(v => +v.toPrecision(5)) });
  }
  return out;
}

/* ---------- Federal Register weekly counts since 2019 (facets API: one call per query) ---------- */
export const LAW_Q = {
  military: { ag: ['foreign-assets-control-office', 'state-department', 'defense-department'] },
  maritime: { ag: ['federal-maritime-commission', 'maritime-administration'] },
  cyber: { ag: ['industry-and-security-bureau'], term: 'cybersecurity' },
  power: { ag: ['federal-energy-regulatory-commission', 'energy-department'] },
  strain: { ag: ['agriculture-department'] },
  water: { ag: ['engineers-corps', 'reclamation-bureau'] },
  telecom: { ag: ['federal-communications-commission', 'national-telecommunications-and-information-administration'] },
};
export async function lawWeekly(get) {
  const T = '&conditions[type][]=RULE&conditions[type][]=PRORULE&conditions[type][]=PRESDOCU&conditions[publication_date][gte]=2019-01-01', out = {};
  for (const [id, q] of Object.entries(LAW_Q)) {
    const urls = [`https://www.federalregister.gov/api/v1/documents/facets/weekly?${q.ag.map(a => `conditions[agencies][]=${a}`).join('&')}${T}`];
    if (q.term) urls.push(`https://www.federalregister.gov/api/v1/documents/facets/weekly?conditions[term]=${encodeURIComponent(q.term)}${T}`);
    const acc = {};
    for (const u of urls) { const j = await get(u, { wait: 300 }); if (!j || typeof j !== 'object') continue; for (const [wk, o] of Object.entries(j)) acc[wk] = (acc[wk] || 0) + (o?.count || 0); }
    if (Object.keys(acc).length) out[id] = acc;
  }
  return out;
}

/* ---------- daily raw series per layer and component (calendar days, last ~3 years) ---------- */
function calendar(now, days) { const out = [], d0 = Date.parse(iso(+now)) - (days - 1) * DAY; for (let i = 0; i < days; i++) out.push(iso(d0 + i * DAY)); return out; }
function stepOn(dates, srcDates, vals) { // carry the last known value forward onto calendar days (weekends, holidays)
  const out = new Array(dates.length).fill(null); let j = 0, cur = null;
  for (let i = 0; i < dates.length; i++) { while (j < srcDates.length && srcDates[j] <= dates[i]) { if (vals[j] != null) cur = vals[j]; j++; } out[i] = cur; }
  return out;
}
export function rawSeries(now, MH, LW, B) {
  const days = calendar(now, 1095), S = {};
  const put = (id, k, arr) => { (S[id] = S[id] || {})[k] = arr; };
  // money
  const MR = {}; for (const [n, m] of Object.entries(MH)) MR[n] = stepOn(days, m.d, marketRaw(m).raw);
  for (const [id, names] of Object.entries(LAYER_MKT)) { const ss = names.map(n => MR[n]).filter(Boolean); if (!ss.length) continue;
    put(id, 'money', days.map((_, i) => { const v = ss.map(s => s[i]).filter(x => x != null); return v.length ? Math.max(...v) : null; })); }
  // law: this week's count vs the prior 13-week average
  for (const [id, wk] of Object.entries(LW || {})) { const ks = Object.keys(wk).sort(), vals = ks.map(k => wk[k]), ratio = vals.map((v, j) => j < 13 ? null : (v + 1) / (mean(vals.slice(j - 13, j)) + 1));
    put(id, 'law', stepOn(days, ks, ratio)); }
  // data: maritime — average deviation of major chokepoints from their normal traffic
  if (B.portwatch) { const majors = Object.values(B.portwatch).filter(p => p.base >= 15);
    put('maritime', 'data', days.map(d => { const v = majors.map(p => { const ds = p.days; if (ds[d] != null) { const w = []; for (let k = 0; k < 7; k++) { const x = ds[iso(Date.parse(d) - k * DAY)]; if (x != null) w.push(x); } return w.length ? Math.abs(mean(w) / p.base - 1) : null; }
      const mv = p.months[d.slice(0, 7)]; return mv != null ? Math.abs(mv / p.base - 1) : null; }).filter(x => x != null); return v.length ? mean(v) : null; })); }
  // data: cyber — unique scanners of industrial-control ports, 7-day mean vs prior 90 days
  const DS = B.dshield2; if (DS) { const tot = {}; for (const arr of Object.values(DS.ports)) arr.forEach((s, i) => { const d = iso(Date.parse(DS.start) + i * DAY); tot[d] = (tot[d] || 0) + s; });
    const ks = Object.keys(tot).sort(), v = ks.map(k => tot[k]), r = v.map((x, i) => i < 97 ? null : mean(v.slice(i - 6, i + 1)) / (mean(v.slice(i - 97, i - 7)) || 1));
    put('cyber', 'data', stepOn(days, ks, r)); }
  // data: water (Orange/Red droughts + floods active) and power (Orange/Red tropical cyclones active)
  if (B.gdacs) { const active = (t, re) => B.gdacs.filter(e => re.test(e.type || 'DR') && e.from <= t && (e.to || +now) >= t - 10 * DAY).length;
    put('water', 'data', days.map(d => active(Date.parse(d), /DR|FL/))); put('power', 'data', days.map(d => active(Date.parse(d), /TC/))); }
  return { days, S };
}

/* ---------- percentile scoring + replayed tiers ---------- */
export function calibrate(now, RS, today) {
  const out = { parts: {}, thr: {}, replay: {} }, n = RS.days.length, last = 365;
  const layers = Object.keys(today);
  const repl = {};
  for (const id of layers) {
    const comps = RS.S[id] || {}, parts = {}, hist = {};
    for (const [k, arr] of Object.entries(comps)) { const h = arr.filter(x => x != null); if (h.length < 120) continue; hist[k] = h; parts[k] = today[id][k] != null ? pct(today[id][k], h) : null; }
    out.parts[id] = parts;
    // replay the past year with the same weights (components that have history)
    const ks = Object.keys(hist); if (!ks.length) continue;
    const series = [];
    for (let i = n - last; i < n; i++) { let s = 0, w = 0; for (const k of ks) { const v = comps[k][i]; if (v == null) continue; s += W[k] * pct(v, hist[k]); w += W[k]; } if (w) series.push(100 * s / w); else series.push(null); }
    repl[id] = series;
    const f = series.filter(x => x != null); if (f.length > 120) out.thr[id] = [quant(f, .75), quant(f, .92), quant(f, .98)].map(Math.round);
  }
  const compSeries = []; for (let i = 0; i < last; i++) { const v = Object.values(repl).map(s => s[i]).filter(x => x != null); compSeries.push(v.length >= 3 ? mean(v) : null); }
  const cf = compSeries.filter(x => x != null); if (cf.length > 120) out.thrComp = [quant(cf, .75), quant(cf, .92), quant(cf, .98)].map(Math.round);
  out.replay = Object.fromEntries(Object.entries(repl).map(([k, s]) => [k, s.slice(-90).map(x => x == null ? null : Math.round(x))]));
  return out;
}
export const tierBy = (v, t) => !t ? (v >= 85 ? 'CRITICAL' : v >= 72 ? 'HIGH' : v >= 58 ? 'ELEVATED' : 'WATCH') : v >= t[2] ? 'CRITICAL' : v >= t[1] ? 'HIGH' : v >= t[0] ? 'ELEVATED' : 'WATCH';
