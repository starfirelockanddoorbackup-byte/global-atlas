#!/usr/bin/env python3
"""Build data/ucdp.json from UCDP downloads (run by hand when UCDP publishes new files).

UCDP data is published under CC BY 4.0 - attribution is shown in the Atlas source list.

  python3 scripts/build_ucdp.py --acd UcdpPrioConflict_v26_1.csv \
      --ged GEDEvent_v26_1.csv --candidate GEDEvent_v26_01_26_09.csv

--acd        UCDP/PRIO Armed Conflict Dataset (yearly conflict counts, 1946-)
--ged        UCDP Georeferenced Event Dataset, final (events, 1989-)
--candidate  UCDP Candidate Events (preliminary current-year months); repeatable, later files win on duplicate ids
"""
import argparse, csv, json, math, sys
from collections import defaultdict
from datetime import datetime, timezone

ARC_FROM = '2019-01'          # matches ARC_FROM in scripts/extra.mjs
MIN_ZONE_DEATHS = 100         # a country needs this many deaths since ARC_FROM to get a long-arc zone

csv.field_size_limit(sys.maxsize)


def rows(path):
    with open(path, newline='', encoding='utf-8') as f:
        yield from csv.DictReader(f)


def lvl(deaths):
    """monthly deaths -> 0-9 long-arc level on a log scale (25 ~ 3, 1,000 ~ 7, 10,000+ = 9)"""
    if deaths < 5:
        return 0
    return max(1, min(9, math.ceil(math.log10(deaths) / 4 * 9)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--acd', required=True)
    ap.add_argument('--ged', required=True)
    ap.add_argument('--candidate', action='append', default=[])
    ap.add_argument('--out', default='data/ucdp.json')
    a = ap.parse_args()

    # 1) yearly counts from the Armed Conflict Dataset
    yr = defaultdict(lambda: {'c': set(), 'w': 0, 'i': set()})
    acd_ver = None
    for r in rows(a.acd):
        y = int(r['year']); acd_ver = r.get('version') or acd_ver
        yr[y]['c'].add(r['conflict_id'])
        if r['intensity_level'] == '2': yr[y]['w'] += 1
        if r['type_of_conflict'] == '2': yr[y]['i'].add(r['conflict_id'])
    annual = [[y, len(v['c']), v['w'], len(v['i'])] for y, v in sorted(yr.items())]

    # 2) events: final GED, then candidate files (preliminary)
    ev = {}
    final_thru = None
    for r in rows(a.ged):
        ev[r['id']] = (r, False)
        final_thru = max(final_thru or '', r['date_start'][:7])
    for p in a.candidate:
        for r in rows(p):
            ev[r['id']] = (r, True)

    sb = defaultdict(float)          # month -> state-based deaths (global)
    n_ev = defaultdict(int)          # month -> events (all types)
    dy = defaultdict(lambda: defaultdict(float))   # (year) -> conflict -> state-based deaths
    dy_thru = defaultdict(str)
    zone = defaultdict(lambda: {'m': defaultdict(float), 'lat': 0.0, 'lon': 0.0, 'w': 0.0, 'conf': defaultdict(float)})
    prelim_months = set()
    for r, pre in ev.values():
        m = r['date_start'][:7]; d = float(r['best'] or 0)
        n_ev[m] += 1
        if pre: prelim_months.add(m)
        if r['type_of_violence'] == '1':
            sb[m] += d
            y = int(m[:4]); dy[y][(r['conflict_new_id'], r['conflict_name'])] += d; dy_thru[y] = max(dy_thru[y], m)
        if m >= ARC_FROM and r['country']:
            z = zone[r['country']]; z['m'][m] += d
            w = max(d, 1.0); z['lat'] += float(r['latitude']) * w; z['lon'] += float(r['longitude']) * w; z['w'] += w
            z['conf'][r['conflict_name']] += d

    seen = sorted(n_ev.keys())
    months, (y, mo) = [], map(int, seen[0].split('-'))
    while f'{y:04d}-{mo:02d}' <= seen[-1]:
        months.append(f'{y:04d}-{mo:02d}'); y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    thru = months[-1]

    # 3) year-to-date conflict counts for the current (preliminary) year, same rule as UCDP: 25+ state-based deaths
    def ytd(y, upto):
        q = [(k, v) for k, v in dy[y].items() if v >= 25]
        if upto:  # recompute limited to months <= upto for a like-for-like prior-year comparison
            acc = defaultdict(float)
            for r, _ in ev.values():
                if r['type_of_violence'] == '1' and r['date_start'][:4] == str(y) and r['date_start'][:7] <= upto:
                    acc[(r['conflict_new_id'], r['conflict_name'])] += float(r['best'] or 0)
            q = [(k, v) for k, v in acc.items() if v >= 25]
        named = [(k, v) for k, v in q if not k[1].startswith('XXX')]
        return {'conflicts': len(named), 'unassigned': len(q) - len(named),
                'wars': sum(1 for _, v in named if v >= 1000),
                'interstate': sum(1 for k, _ in named if ' - ' in k[1])}
    cur_y = int(thru[:4])
    last_annual = annual[-1][0] if annual else None
    ytd_block = None
    if last_annual is not None and cur_y > last_annual:
        mm = thru[5:]
        ytd_block = {'year': cur_y, 'through': thru, **ytd(cur_y, None),
                     'prev': {'year': cur_y - 1, 'through': f'{cur_y - 1}-{mm}', **ytd(cur_y - 1, f'{cur_y - 1}-{mm}')}}

    zones = []
    for name, z in zone.items():
        tot = sum(z['m'].values())
        if tot < MIN_ZONE_DEATHS or not z['w']:
            continue
        top = max(z['conf'].items(), key=lambda kv: kv[1])[0]
        zones.append({'name': name, 'lat': round(z['lat'] / z['w'], 2), 'lon': round(z['lon'] / z['w'], 2),
                      'top': top, 'm': {m: round(v) for m, v in sorted(z['m'].items())},
                      'lv': {m: lvl(v) for m, v in sorted(z['m'].items()) if lvl(v)}})
    zones.sort(key=lambda z: -sum(z['m'].values()))

    out = {
        'built': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'through': thru, 'final_through': final_thru,
        'preliminary_months': sorted(prelim_months - {m for m in prelim_months if final_thru and m <= final_thru}),
        'versions': {'acd': acd_ver, 'ged': a.ged.split('/')[-1], 'candidate': [p.split('/')[-1] for p in a.candidate]},
        'license': 'UCDP data, CC BY 4.0 - Uppsala Conflict Data Program, ucdp.uu.se',
        'annual_cols': ['year', 'conflicts', 'wars', 'interstate'], 'annual': annual,
        'ytd': ytd_block,
        'months_from': months[0],
        'sb_deaths': [round(sb.get(m, 0)) for m in months],
        'events': [n_ev.get(m, 0) for m in months],
        'zones': zones,
    }
    with open(a.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {a.out}: {len(months)} months ({months[0]}..{thru}), {len(zones)} zones, ytd={ytd_block}')


if __name__ == '__main__':
    main()
