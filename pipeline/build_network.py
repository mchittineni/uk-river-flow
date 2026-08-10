#!/usr/bin/env python3
"""Build the simplified river-centreline layer from OpenStreetMap via Overpass.

Why OpenStreetMap and not a national dataset: licence clarity. OS Open Rivers is
OGL v3 but needs an OS Data Hub account, and HydroRIVERS publishes its licence
only inside a PDF while the hydrosheds.org site terms say "personal,
non-commercial use only" - ambiguous ground for a repository that redistributes a
derived subset. OSM is ODbL 1.0: redistribution of a derived database is
explicitly granted, provided we attribute and keep the derived data open. Both
are true here. See docs/adr/0003.

Overpass cannot serve a whole country in one query, so the bounding box is tiled
and fetched with backoff. Output is simplified and coordinate-quantised, which is
what turns ~90 MB of raw ways into a couple of MB.

Usage:
    python3 pipeline/build_network.py --out data/v1/network.geojson
    python3 pipeline/build_network.py --min-length-km 10 --named-only
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from riverflow import contract, geometry
from riverflow.http import Http, HttpError

log = logging.getLogger("build-network")

# Mirrors are listed so a fork is not dead when one instance is rate-limiting.
# They are tried in order, per tile.
ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

# Great Britain and Northern Ireland, generously bounded.
UK_BBOX = (-8.7, 49.85, 1.85, 60.9)

ATTRIBUTION = "River centrelines © OpenStreetMap contributors, ODbL 1.0"


def overpass_ql(west: float, south: float, east: float, north: float) -> str:
    """Compose the Overpass QL request for one tile.

    Every interpolated value is passed through `float()` first, so the bounds can
    only ever be numeric literals - the bbox arrives from argparse, but casting
    here means no caller can inject clause text through it.
    """
    bounds = ",".join(
        format(float(value), ".6f") for value in (south, west, north, east)
    )
    return (
        "[out:json][timeout:180];\n"
        f'way["waterway"~"^(river|canal)$"]({bounds});\n'
        "out geom qt;\n"
    )


def tiles(bbox: tuple[float, float, float, float], step: float) -> list[tuple[float, float, float, float]]:
    """Split a bounding box into `step`-degree tiles."""
    west, south, east, north = bbox
    out = []
    lat = south
    while lat < north:
        lon = west
        while lon < east:
            out.append((lon, lat, min(lon + step, east), min(lat + step, north)))
            lon += step
        lat += step
    return out


def cache_key(tile: tuple[float, float, float, float]) -> str:
    return "tile_" + "_".join(format(value, "+08.3f").replace("+", "p").replace("-", "m") for value in tile) + ".json"


def fetch_tile(
    http: Http,
    tile: tuple[float, float, float, float],
    start_at: int = 0,
    cache_dir: Path | None = None,
) -> list[dict]:
    """Fetch one tile, rotating across mirrors and caching the result.

    Mirrors are rotated *per tile* rather than only on failure. The public
    Overpass instances rate-limit per client, so retrying the same host after a
    429 mostly earns another 429; moving to the next host succeeds immediately and
    spreads our load across three volunteers instead of leaning on one.

    Results are cached on disk because a whole-country run takes tens of minutes
    across ~60 tiles. Without the cache, one failure at tile 55 throws away the
    other 54 tiles' worth of someone else's bandwidth.
    """
    cache_path = cache_dir / cache_key(tile) if cache_dir else None
    if cache_path and cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            log.warning("  discarding corrupt cache entry %s", cache_path.name)

    west, south, east, north = tile
    body = overpass_ql(west, south, east, north)
    last_error: Exception | None = None

    for offset in range(len(ENDPOINTS)):
        endpoint = ENDPOINTS[(start_at + offset) % len(ENDPOINTS)]
        try:
            raw = http.post_text(endpoint, body, content_type="text/plain; charset=utf-8")
            elements = json.loads(raw).get("elements", [])
            if cache_path:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(json.dumps(elements), encoding="utf-8")
            return elements
        except (HttpError, json.JSONDecodeError) as exc:
            last_error = exc
            log.warning("  %s declined tile %s (%s); rotating mirror", endpoint.split("/")[2], tile, exc)

    raise RuntimeError(f"all {len(ENDPOINTS)} Overpass mirrors failed for tile {tile}: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("data/v1/network.geojson"))
    parser.add_argument("--tile-degrees", type=float, default=1.5)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".cache/overpass"),
        help="where to cache per-tile responses so a re-run resumes",
    )
    parser.add_argument("--no-cache", action="store_true", help="ignore and do not write the tile cache")
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.0008,
        help="simplification tolerance in degrees (~90 m); the main size lever",
    )
    parser.add_argument("--min-length-km", type=float, default=3.0, help="drop ways shorter than this")
    parser.add_argument("--named-only", action="store_true", help="keep only ways carrying a name tag")
    parser.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=list(UK_BBOX))
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    # Overpass asks for one query at a time from a given client. `retries=1` is
    # deliberate: a 429 from one mirror is answered by moving to the next rather
    # than by waiting out a backoff on a host that has already said no.
    http = Http(min_interval=1.5, retries=1, timeout=200.0)
    cache_dir = None if args.no_cache else args.cache_dir
    grid = tiles(tuple(args.bbox), args.tile_degrees)
    log.info(
        "fetching %d tiles of %.1f degrees across %d mirrors%s",
        len(grid),
        args.tile_degrees,
        len(ENDPOINTS),
        f" (cache: {cache_dir})" if cache_dir else "",
    )

    features: list[dict] = []
    seen: set[int] = set()
    raw_vertices = kept_vertices = 0
    dropped_short = dropped_unnamed = 0

    for index, tile in enumerate(grid, start=1):
        # Stagger which mirror each tile starts on, so consecutive tiles do not
        # queue behind one another on the same host.
        elements = fetch_tile(http, tile, start_at=index % len(ENDPOINTS), cache_dir=cache_dir)
        log.info("  tile %d/%d -> %d ways", index, len(grid), len(elements))

        for element in elements:
            way_id = element.get("id")
            # Tiles overlap at their edges and Overpass returns a way whenever any
            # part of it intersects, so the same way arrives several times.
            if way_id in seen:
                continue
            coordinates = [(node["lon"], node["lat"]) for node in element.get("geometry") or [] if node]
            if len(coordinates) < 2:
                continue
            seen.add(way_id)
            raw_vertices += len(coordinates)

            tags = element.get("tags") or {}
            name = tags.get("name") or tags.get("name:en")
            if args.named_only and not name:
                dropped_unnamed += 1
                continue
            if geometry.line_length_km(coordinates) < args.min_length_km:
                dropped_short += 1
                continue

            simplified = geometry.quantise(geometry.simplify(coordinates, args.tolerance))
            if len(simplified) < 2:
                continue
            kept_vertices += len(simplified)

            properties: dict[str, object] = {"id": way_id, "kind": tags.get("waterway", "river")}
            if name:
                properties["name"] = name
            features.append(
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {"type": "LineString", "coordinates": [list(point) for point in simplified]},
                }
            )

    if not features:
        log.error("no river geometry collected; refusing to write an empty layer")
        return 1

    # Longest first: MapLibre draws in feature order, so major rivers end up under
    # the minor ones and stay visible where they cross.
    features.sort(key=lambda f: -len(f["geometry"]["coordinates"]))

    size = contract.write_json(
        args.out,
        {
            "type": "FeatureCollection",
            "attribution": ATTRIBUTION,
            "features": features,
        },
    )

    log.info(
        "wrote %d ways | vertices %d -> %d (%.0f%% reduction) | %.1f KB",
        len(features),
        raw_vertices,
        kept_vertices,
        100 * (1 - kept_vertices / raw_vertices) if raw_vertices else 0,
        size / 1024,
    )
    log.info("  dropped %d short, %d unnamed", dropped_short, dropped_unnamed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
