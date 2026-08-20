# River Flow UK

An interactive map of river discharge across the United Kingdom, built entirely
from Environment Agency open data.

**No API keys. No accounts. No servers. No bill.** Clone it, run one Python script
with no dependencies, and you have the whole thing.

<!-- Replace with a real screenshot once deployed. -->
<!-- ![River Flow UK](docs/screenshot.png) -->

---

## What it shows

| | |
| --- | --- |
| **1,003 gauging stations** | Daily mean discharge from the EA Hydrology API, with quality grades |
| **279 live stations** | 15-minute readings from the real-time flood-monitoring API |
| **Relative colour** | Every station is coloured against **its own** record, not an absolute scale |
| **Time scrub** | Step or animate through the published window — 30 days by default — and watch a rainfall event propagate |
| **Animated river network** | Centrelines coloured and flowing by the nearest gauge's reading |
| **854 KB per visit, gzipped** | 304 KB of app and 550 KB of data, of which the river network is 416 KB |

The relative colouring is the point. 20 m³/s is a drought on the Thames and a
once-a-decade flood on a chalk stream, so absolute discharge tells you almost
nothing. Each station is placed against its own percentile record, and the detail
panel says what that means in words: *"Higher than 95% of the days on record for
this gauge."*

## Quick start

```bash
git clone https://github.com/mchittineni/uk-river-flow
cd uk-river-flow

# 1. Fetch the data. Standard library only - nothing to install.
python3 pipeline/ingest_uk.py --days 30

# 2. Run the map.
cd web && npm install && npm run dev
```

That's it. There is no step three, no `.env`, and nothing to sign up for.

A seed bundle is already committed, so you can skip step 1 and go straight to the
map — the data will just be up to a month old.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│ GitHub Actions  (free + unlimited on public repos)              │
│                                                                 │
│  refresh-and-deploy.yml     3x daily                            │
│    │                                                            │
│    ├── EA Hydrology API ──────────┐  1 CSV request = 30 days,   │
│    │   (daily mean, 1,102 flow    │  whole country, ~4 MB       │
│    │    stations, quality flags)  │                             │
│    │                              ▼                             │
│    ├── EA flood-monitoring ──> normalise ──> validate ──> build  │
│    │   (15-min latest, 1 request)     │           │             │
│    │                                  │      contract v1        │
│    │                             data/v1/*.json   gate          │
│    └──────────────────────────────────┴───────────┴──> Pages    │
│                                                                 │
│  refresh-seed.yml       monthly, opens a PR   (committed seed)   │
│  refresh-network.yml    quarterly, opens a PR (OSM geometry)     │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        Browser: MapLibre GL JS
                        reads same-origin static JSON
                        no runtime API calls at all
```

The scheduled job **is** the backend. There is no server, no database and no
runtime API — the browser only ever reads static files from the same origin it was
served from. That is what makes it free to host, fast to load, and immune to an
upstream outage: if the EA API is down when you arrive, you see yesterday's map
rather than an error.

Full reasoning in [`docs/adr/`](docs/adr/). The short version:

| Decision | Why |
| --- | --- |
| [Scheduled ingest, not browser fetch](docs/adr/0001-static-site-with-scheduled-ingest.md) | The EA APIs *do* send `Access-Control-Allow-Origin: *`, so browser-side would work — but it puts 3–5 calls per page view on a public service to render identical data, serialises first paint, and can't accumulate history |
| [MapLibre, not CesiumJS](docs/adr/0002-maplibre-not-cesium.md) | Cesium ion's asset endpoint returns **401 without a token**. Free tokens mean a signup, a CI secret and a quota. MapLibre + OpenFreeMap needs none, and is 304 KB against 5.5 MB |
| [OpenStreetMap geometry](docs/adr/0003-osm-geometry-for-licence-clarity.md) | We redistribute a derived subset, so licence clarity beats data quality. ODbL explicitly permits it; HydroRIVERS' terms are ambiguous |
| [Two station layers, no join](docs/adr/0004-two-layers-not-one-join.md) | The EA's two services overlap on only **87 of 352** station identifiers. A 25% join produces plausible wrong values, which is worse than none |
| [Don't commit refreshed data](docs/adr/0005-do-not-commit-refreshed-data.md) | 450 KB × 3/day ≈ 490 MB of git objects a year. Deploy from the artefact; commit a monthly seed |

## Running costs

The honest answer: **£0**, and here is the arithmetic rather than the assertion.

| Resource | Usage | Free tier | Headroom |
| --- | --- | --- | --- |
| GitHub Actions | ~15 min/day | Unlimited for public repos | ∞ |
| GitHub Pages bandwidth | 854 KB/visit | 100 GB/month soft | ~120,000 visits/month |
| Cloudflare Pages (alternative) | same | No hard bandwidth cap; 500 builds/month | Builds, not bytes |
| EA Hydrology API | 3 requests/day | No published limit, no key | ∞ |
| EA flood-monitoring API | 6 requests/day | No published limit, no key | ∞ |
| OpenFreeMap tiles | per visitor | No key, no published quota | — |
| Overpass API | ~64 requests/quarter | Volunteer-run, rate-limited | Cached + committed |

**Where a naive build would have cost money.** Cesium's runtime is ~5.5 MB of JS
plus workers and assets — call it 30 MB per cold visit with terrain tiles. On
Netlify's 100 GB/month free tier that is roughly **3,300 visits before you are
billed**. This build fits ~120,000. That single stack decision is the difference
between a hobby project and an invoice.

The river network is now the largest single asset at 416 KB gzipped — half the
page. It is fetched eagerly and treated as optional, so the map still renders if it
fails, but it is the obvious next thing to cut: serving it as vector tiles, or
loading it after first paint, would roughly halve the per-visit figure above.

**Recommended host: Cloudflare Pages**, because it applies no hard bandwidth cap.
GitHub Pages is configured here because it needs no third-party account; the Vite
config uses relative asset paths so the same build works at a domain root or under
a `/repo-name/` prefix with no rebuild.

## Data sources and licences

All data is open, and attribution is a licence condition rather than a courtesy —
so the footer is generated from `meta.json` and CI fails if the source list is
empty.

| Source | Licence | Used for |
| --- | --- | --- |
| [EA Hydrology API](https://environment.data.gov.uk/hydrology) | OGL v3 | Daily mean discharge, station metadata, percentiles |
| [EA flood-monitoring API](https://environment.data.gov.uk/flood-monitoring/doc/reference) | OGL v3 | 15-minute live layer |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via [Overpass](https://overpass-api.de) | ODbL 1.0 | River centrelines |
| [OpenFreeMap](https://openfreemap.org) | ODbL (data), BSD-2 (styles) | Basemap tiles, glyphs, sprites |
| [Tilezen terrain](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data | Various open, see registry | Optional 3D terrain |

> Contains public sector information licensed under the Open Government Licence
> v3.0. © Environment Agency copyright and/or database right 2026.
> River centrelines © OpenStreetMap contributors, ODbL 1.0.

See [`DATA_LICENSES.md`](DATA_LICENSES.md) for the full notices and obligations.

## Repository layout

```
pipeline/                 stdlib-only Python. No requirements.txt, by design.
  riverflow/
    contract.py           the published data contract + its validator
    http.py               polite client: throttle, backoff, 429 window dwell
    geometry.py           Douglas-Peucker, quantisation, haversine
    series.py             columnar packing, percentiles, flow states
  ingest_uk.py            the main job: EA APIs -> data/v1
  build_network.py        Overpass -> simplified river GeoJSON (quarterly)
  validate_data.py        contract + page-weight gate, run in CI
  tests/                  53 unit tests, no network

web/                      Vite + vanilla JS. No framework.
  src/
    map.js                MapLibre layers, flow animation, terrain, globe
    data.js               bundle loading, flow states, formatting
    join.js               grid-indexed nearest-gauge join for river segments
    theme.js              dark/system/light preference, and its persistence
    radiogroup.js         WAI-ARIA keyboard behaviour for the segmented controls
    panel.js, sparkline.js, dom.js
  vite.config.js          data-bundle plugin + the generated security headers
  dev-data-route.js       dev-server path containment, unit-tested
  scripts/                build-output assertions run in CI
data/v1/                  the published bundle (committed seed)
docs/adr/                 why things are the way they are
```

### The data contract

`data/v1/` is a real API between the pipeline and the front end, which deploy
independently. It is versioned, documented in `pipeline/riverflow/contract.py`, and
validated on every change:

```bash
python3 pipeline/validate_data.py
```

```
bundle: data/v1
  live.json                  35.6 KB raw       7.8 KB gzip
  meta.json                   1.0 KB raw       0.5 KB gzip
  series.json               164.8 KB raw      58.2 KB gzip
  stations.json             257.8 KB raw      66.9 KB gzip
  network.geojson          1409.2 KB raw     416.4 KB gzip
  TOTAL                    1868.4 KB raw     549.9 KB gzip
  generated 2026-08-10T14:31:47+00:00 | 1003 stations, 22 samples, 279 live

OK    bundle satisfies contract v1
```

The validator rejects things a schema check would miss and a human would not
notice: stations at `(0, 0)`, non-monotonic percentiles, negative discharge, a
series column whose length disagrees with the time axis, series ids absent from the
station list, an empty source list, and a gzipped bundle over budget.

The live layer gets the same treatment, because it is published to the browser and
rendered without further checking: a real-time reading at `(0, 0)`, a negative
discharge, a duplicated identifier, or an `at` stamp that is not a parseable
instant all fail the bundle. So does the case that motivated it — `meta.counts.live`
disagreeing with `live.json`, which is what a failed real-time fetch looks like when
last run's snapshot is still sitting on disk waiting to be served as current.

## Security

There are no accounts, no cookies, no analytics and no secrets — every upstream API
is keyless and public by design. That removes most of the usual attack surface, so
the controls that remain are about the two things left: what the page is allowed to
do, and what gets into the build.

| Control | Where |
| --- | --- |
| CSP allowing script from `'self'` only, plus the two keyless origins the map needs | generated in [`web/vite.config.js`](web/vite.config.js), emitted as both a `<meta>` tag and a Cloudflare `_headers` file from one definition |
| Build-output assertion, so the policy cannot silently disappear | [`web/scripts/check-headers.mjs`](web/scripts/check-headers.mjs), run in CI |
| Every DOM write goes through `textContent` | [`web/src/dom.js`](web/src/dom.js) — station and river names are third-party data |
| Dev-server path containment | [`web/dev-data-route.js`](web/dev-data-route.js), unit-tested against traversal, encoded traversal and prefix-sibling escapes |
| Actions pinned to commit SHAs, not tags | all of [`.github/workflows/`](.github/workflows/), bumped by Dependabot |
| No credentials left in `.git/config` for an artifact to carry | `persist-credentials: false` on every read-only checkout |

`style-src` permits `'unsafe-inline'` and always will: MapLibre positions every
control and popup by writing to `element.style`, CSP counts a style attribute as
inline style, and there is no nonce mechanism for attributes. The alternative is not
a tighter policy, it is a map that does not render.

See [`SECURITY.md`](SECURITY.md) for what is in scope and how to report something.

## Adapting this to another country

The architecture is deliberately region-agnostic. To point it somewhere else you
need one thing: **a discharge source your pipeline can reach.** Everything else —
the contract, the front end, the workflows, the geometry builder — is reusable.

Its sibling repo, [india-river-flow](https://github.com/mchittineni/india-river-flow),
does exactly this for a country with no browser-reachable gauge network, using the
Copernicus GloFAS model instead.

A rough guide to feasibility elsewhere:

| Region | Source | Notes |
| --- | --- | --- |
| UK | EA Hydrology + flood-monitoring | This repo. Keyless, CORS-open, excellent metadata |
| Norway | NVE HydAPI | Needs a free API key |
| USA | USGS Water Services | Keyless, very good coverage |
| Anywhere | Copernicus GloFAS via Open-Meteo | Modelled not measured, but global and includes a forecast |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: `python3 -m unittest discover -s
pipeline/tests` and `npm run lint && npm test` in `web/` must pass (53 Python and 42
JavaScript tests, none of which touch the network), and the pipeline must stay
dependency-free — CI enforces that last one.

Good first issues: the NRFA-mediated station join described in
[ADR 0004](docs/adr/0004-two-layers-not-one-join.md), a real WebGL particle layer
for the flow animation, and catchment polygons.

## Acknowledgements

The interface here is modelled on **[Tingkart](https://norway-charts.netlify.app)**'s
[river flow map of Norway](https://norway-charts.netlify.app/river_flow_map/) — the
project that worked out this shape of UI first, and did it well: a full-bleed map
with a single control rail, rivers whose colour and width carry the reading, and a
detail panel that appears on click rather than a permanent sidebar. Tingkart is an
independent data-visualisation project by [@tingkart](https://github.com/tingkart),
built on Norwegian open data from NVE; it is not affiliated with this repository,
and any clumsiness in the imitation is ours.

Worth a look for its own sake — the same author's work covers rather more than
rivers.

## Licence

Code is [MIT](LICENSE). Data carries its upstream licences — see
[`DATA_LICENSES.md`](DATA_LICENSES.md).

This project is not affiliated with or endorsed by the Environment Agency.
