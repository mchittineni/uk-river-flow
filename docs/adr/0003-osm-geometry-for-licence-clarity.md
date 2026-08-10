# ADR 0003 — OpenStreetMap for river geometry, for licence clarity

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

We need river centrelines to draw, and we redistribute a derived, simplified
subset of them in this repository. That makes the licence a functional
requirement, not a footnote: we are republishing a modified database.

Three candidates:

| Source | Coverage | Licence position |
| --- | --- | --- |
| OS Open Rivers | GB, high fidelity | OGL v3, but distributed through an OS Data Hub account |
| HydroRIVERS (HydroSHEDS) | Global, includes long-run mean discharge attributes | Product page says "scientific, educational and commercial use"; actual terms are only inside a PDF, and hydrosheds.org's own Terms of Use say the site materials are for "personal, non-commercial use only" and exclude "any resale or redistribution" |
| OpenStreetMap `waterway=river` | Global | ODbL 1.0 |

HydroRIVERS was the tempting option — global, and it carries a `DIS_AV_CMS` mean
discharge attribute we could have styled with directly. But we could not establish
from the published terms whether redistributing a modified subset is permitted.
The product page and the site terms disagree, and the operative document is a PDF
that the terms page itself defers to.

## Decision

Use **OpenStreetMap** `waterway=river|canal`, fetched via Overpass, simplified,
and committed under **ODbL 1.0** with attribution.

## Rationale

When you are redistributing derived data publicly, pick the source with the
clearest grant, not the best attributes. ODbL is unambiguous about exactly what we
are doing: it explicitly grants creation and distribution of a Derivative Database,
requiring attribution and that the derived database stay under a compatible open
licence. Both hold here — the repo is public and MIT/ODbL-licensed, and
`DATA_LICENSES.md` carries the notice.

Secondary benefits: one code path works for any country, so the India sibling repo
reuses `build_network.py` unchanged; and no account is needed, keeping the
zero-signup property from [ADR 0002](./0002-maplibre-not-cesium.md).

## Consequences

- Overpass is a volunteer-run service that rate-limits hard. Measured during
  development: frequent 429 and 502 responses from `overpass-api.de`. Mitigated
  three ways — rotate across three mirrors *per tile* rather than retrying a host
  that has already said no, cache every tile to disk so a run resumes, and commit
  the output so a fork never needs Overpass at all.
- A whole-country build takes one to two hours. Acceptable: it runs quarterly, and
  the geometry is static.
- OSM river data quality varies by region. Named, long ways are well mapped;
  minor watercourses less so. `--min-length-km` and `--named-only` exist to trade
  completeness against noise.
- We lose HydroRIVERS' discharge attributes, so segment colour comes from a
  browser-side nearest-gauge join instead (`web/src/join.js`). That turned out
  better anyway: the colour then reflects live readings rather than a long-run
  average baked into the geometry.

## Note for forks

If you only need Great Britain and are willing to register for a free OS Data Hub
account, **OS Open Rivers** is materially better geometry and is OGL v3. It is a
drop-in replacement for `build_network.py`'s output. We did not use it because it
would reintroduce a signup.
