# Data licences and attribution

The **code** in this repository is MIT ([`LICENSE`](LICENSE)). The **data** in
`data/` is not ours — it is derived from third-party open datasets, each with its own
licence and obligations.

Attribution here is a licence condition, not a courtesy. That is why the site footer
is generated from `data/v1/meta.json` rather than hardcoded, and why
`pipeline/validate_data.py` fails if the source list is empty.

---

## 1. Environment Agency hydrological data

**Open Government Licence v3.0** — <https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/>

Used for: all discharge readings, station metadata, coordinates, river names, quality
grades, and the derived percentile reference.

Endpoints:

- Hydrology API — <https://environment.data.gov.uk/hydrology>
- Real-time flood-monitoring API — <https://environment.data.gov.uk/flood-monitoring/doc/reference>

Required notice, reproduced in the site footer and here:

> Contains public sector information licensed under the Open Government Licence v3.0.
> © Environment Agency copyright and/or database right 2026. All rights reserved.

**What OGL v3 permits:** copy, publish, distribute, adapt and exploit commercially,
provided the source is acknowledged with the notice above.

**Note on derived values.** The percentile reference, flow-state classifications and
hourly/daily buckets in `data/v1/` are *our* derivations from EA data, not EA
outputs. They should not be attributed to the Environment Agency as if the agency
published them. This project is not affiliated with or endorsed by the Environment
Agency.

---

## 2. OpenStreetMap river centrelines

**Open Database License (ODbL) 1.0** — <https://opendatacommons.org/licenses/odbl/1-0/>

Used for: `data/v1/network.geojson` — river and canal centrelines, simplified and
coordinate-quantised from OSM `waterway=river` and `waterway=canal` ways, fetched via
the Overpass API.

Required notice:

> River centrelines © OpenStreetMap contributors, available under the Open Database
> License. <https://www.openstreetmap.org/copyright>

**ODbL obligations we are meeting, and what they mean for you:**

- **Attribution** — the notice above appears in the footer and in the GeoJSON's own
  `attribution` property.
- **Share-alike** — `network.geojson` is a *Derivative Database*. If you redistribute
  it, or a database derived from it, that must also be under ODbL. This is the one
  obligation that catches people out: **the MIT licence on this repository's code does
  not extend to this file.**
- **Keep open** — no technical measures restrict access to it.

You may produce and distribute *Produced Works* (a rendered map image, a screenshot,
a chart) under any licence you like, provided the attribution notice accompanies them.

See [ADR 0003](docs/adr/0003-osm-geometry-for-licence-clarity.md) for why OSM was
chosen over OS Open Rivers and HydroRIVERS.

---

## 3. Basemap tiles — OpenFreeMap

Tiles, glyphs and sprites: <https://openfreemap.org>

- Underlying data: OpenStreetMap, **ODbL 1.0**
- Style definitions: derived from OpenMapTiles / Maputnik styles, **BSD-2-Clause**

Not redistributed by this repository — fetched by the browser at runtime. The
attribution appears in the footer as required.

---

## 4. Terrain tiles (optional layer, off by default)

Tilezen / Mapzen terrarium elevation tiles, hosted on the AWS Open Data registry:
<https://registry.opendata.aws/terrain-tiles/>

Underlying sources are various open datasets — chiefly SRTM, NED, and national
elevation products — each with its own terms, listed in the registry entry. Not
redistributed here; fetched by the browser only when the terrain toggle is enabled.

---

## 5. Software dependencies

| Package | Licence |
| --- | --- |
| MapLibre GL JS | BSD-3-Clause |
| Vite | MIT |
| ESLint | MIT |
| Prettier | MIT |

The Python pipeline has no third-party dependencies — CI enforces this.

---

## If you fork this

1. Keep both notices (OGL v3 and ODbL) wherever the data or a rendering of it appears.
2. If you redistribute `network.geojson` or anything derived from it, keep it ODbL.
3. If you swap in a different data source, update `SOURCES` in the ingest script —
   the footer and the validator both read from it, so the notice follows the data
   automatically.
4. Do not imply endorsement by the Environment Agency or any other data provider.
