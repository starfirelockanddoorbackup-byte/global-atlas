# GLOBAL ATLAS — Matthews Operations Lab

An open-source **8-layer systems readout** of global stress, refreshed every 4 hours.
It maps daily flashpoints across military, maritime, cyber/ICS, narrative, power, subsistence,
water and telecom layers, scores each layer as better or worse than 24 hours ago, and flags regions
where several layers stack up at once.

**Data:** GDELT news-event signals, CISA ICS advisories and KEV catalog, IODA internet outage signals,
GDACS disaster alerts, public market prices. Indicators, not intelligence. Automated, unverified.

**Conflict data:** UCDP (Uppsala Conflict Data Program, CC BY 4.0) feeds the military layer's measured-data score,
monthly conflict-death zones in the since-2019 view, and yearly conflict counts since 1946. `data/ucdp.json` is rebuilt by hand
when UCDP publishes new files (final GED yearly, preliminary Candidate events monthly):

    python3 scripts/build_ucdp.py --acd UcdpPrioConflict_vXX.csv --ged GEDEvent_vXX.csv --candidate GEDEvent_candidate.csv

`scripts/update.mjs` runs in GitHub Actions (`.github/workflows/telemetry.yml`) and writes `data/latest.json`.
Map outlines: public-domain world.geo.json (see `data/LAND_LICENSE.txt`).
