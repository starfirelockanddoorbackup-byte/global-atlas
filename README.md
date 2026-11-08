# GLOBAL ATLAS — Matthews Operations Lab

An open-source **8-layer systems readout** of global stress, refreshed every 4 hours.
It maps daily flashpoints across military, maritime, cyber/ICS, narrative, power, subsistence,
water and telecom layers, scores each layer as better or worse than 24 hours ago, and flags regions
where several layers stack up at once.

**Data:** GDELT news-event signals, CISA ICS advisories and KEV catalog, IODA internet outage signals,
GDACS disaster alerts, public market prices. Indicators, not intelligence. Automated, unverified.

`scripts/update.mjs` runs in GitHub Actions (`.github/workflows/telemetry.yml`) and writes `data/latest.json`.
Map outlines: public-domain world.geo.json (see `data/LAND_LICENSE.txt`).
