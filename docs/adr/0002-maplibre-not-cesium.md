# ADR 0002 — MapLibre GL JS, not CesiumJS

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

The project this one is modelled on renders with CesiumJS 1.133, and CesiumJS is
genuinely open source (Apache-2.0). A reproducibility assessment that stops at the
licence concludes the stack is "100% reproducible".

It is not, quite. CesiumJS's default terrain and imagery do not come from CesiumJS
— they come from **Cesium ion**, a hosted service:

```
$ curl -so /dev/null -w '%{http_code}\n' https://api.cesium.com/v1/assets/1/endpoint
401
```

`Cesium.Terrain.fromWorldTerrain()` and the default Bing imagery both require an
ion access token. Free tokens exist, but they mean: a signup, a credential to
inject into CI and a metered quota that a popular map can exhaust. Those are the
three things this project exists to avoid.

The bundle size is the second problem:

| | Bytes |
| --- | --- |
| `Cesium.js` (single file, before workers and assets) | 5,514,028 |
| `maplibre-gl.js` | 939,269 |

Cesium also ships web workers and a static asset directory that must be served
alongside it.

## Decision

Render with **MapLibre GL JS 5** (BSD-3-Clause), on tiles that need no account:

| Layer | Source | Licence / cost |
| --- | --- | --- |
| Vector basemap | [OpenFreeMap](https://openfreemap.org) `dark` / `positron` | ODbL, no key, no published quota |
| Glyphs and sprites | OpenFreeMap | same |
| Terrain (opt-in) | Tilezen terrarium tiles on AWS Open Data | public, keyless |
| River lines | This repo, from OpenStreetMap | ODbL |

MapLibre 5 added a globe projection, so the 3D-globe character of the original is
preserved without ion.

Measured result: **307 KB gzipped** for the whole application, against Cesium's
~5.5 MB of JavaScript before its workers and assets.

## Rationale

- No account, no token, no secret in CI, no quota to monitor. The repo can be
  cloned and deployed by anyone with zero signups — which was the actual goal.
- A ~940 KB library that we split into its own chunk caches independently of our
  code, so a UI change re-downloads ~20 KB rather than a megabyte.
- Vector tiles restyle client-side, so light and dark themes cost nothing extra.
- Terrain and globe are both opt-in toggles, and both are wrapped in failure
  handling — they depend on third-party best-effort services, so they degrade
  instead of taking the map down.

## Consequences

- **No true particle-flow rendering.** MapLibre cannot interpolate
  `line-dasharray`, so per-feature continuous velocity is not expressible. We step
  through a fixed dash sequence for a marching-ants effect instead. Cheaper, and it
  degrades to a static dashed line when animation is off or the tab is hidden. A
  custom WebGL layer could do real particles later; it is not worth the complexity
  for the current design.
- MapLibre's globe is younger than Cesium's and less capable at extreme tilt. The
  toggle is wrapped in a `try`/`catch` that reverts the checkbox if the projection
  call throws.
- OpenFreeMap publishes no formal SLA. It is a free public good, which is exactly
  what we need and also a dependency worth naming — swapping to another
  OpenMapTiles-schema host is a one-line change in `web/src/map.js`.

## Explicitly rejected

- **`tile.openstreetmap.org` as a basemap.** Free and keyless, but the OSMF tile
  usage policy prohibits use by applications. Using it would be a licence and
  etiquette violation dressed up as a cost saving.
- **Cesium with ion and a free token.** Workable, but reintroduces the signup,
  the CI secret and the quota.
- **Cesium with only OSM imagery and ellipsoid terrain.** Avoids ion, but keeps
  the 5.5 MB download and loses the terrain that was the reason to pick Cesium.
