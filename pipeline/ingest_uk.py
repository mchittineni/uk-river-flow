#!/usr/bin/env python3
"""Build the UK river-flow data bundle from Environment Agency open data.

Two independent layers, deliberately not joined:

  * **archive** - the EA Hydrology API. 1,100+ gauging stations with daily mean
    discharge, quality flags, coordinates for every station and a river name for
    99% of them. This is the primary layer: breadth and history.
  * **live** - the EA real-time flood-monitoring API. ~380 stations at 15-minute
    resolution, fetched in a single request. This is the freshness layer.

The two services use different station identifiers. Measured overlap is only 87
of 352 by identifier and 169 of 314 by coordinate, so joining them would mislabel
roughly half the network. They are therefore published as separate layers that
the UI toggles, rather than merged records. See docs/adr/0004.

Usage:
    python3 pipeline/ingest_uk.py --days 30 --out data/v1
    python3 pipeline/ingest_uk.py --reference --reference-days 365   # monthly
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from riverflow import contract, series
from riverflow.http import Http, HttpError

log = logging.getLogger("ingest-uk")

HYDROLOGY = "https://environment.data.gov.uk/hydrology"
FLOOD = "https://environment.data.gov.uk/flood-monitoring"

# Daily *mean* flow. The API also publishes max/min for the same station and day;
# selecting on this fragment keeps one series per station.
DAILY_MEAN_FRAGMENT = "-flow-m-86400-"

# The EA marks recent values "Unchecked" until a hydrologist reviews them. We keep
# them - a map that lags a month is useless - but the grade travels with the data
# so the UI can say so.
QUALITY_ORDER = {"Good": 3, "Unchecked": 2, "Estimated": 1, "Suspect": 0, "Missing": 0}
REJECT_QUALITY = frozenset({"Missing", "Suspect"})

SOURCES = [
    {
        "name": "Environment Agency Hydrology API (daily mean discharge)",
        "licence": "Open Government Licence v3.0",
        "url": "https://environment.data.gov.uk/hydrology",
        "attribution": "© Environment Agency copyright and/or database right 2026. All rights reserved.",
    },
    {
        "name": "Environment Agency real-time flood-monitoring API (15-minute flow)",
        "licence": "Open Government Licence v3.0",
        "url": "https://environment.data.gov.uk/flood-monitoring/doc/reference",
        "attribution": "© Environment Agency copyright and/or database right 2026. All rights reserved.",
    },
]


def as_list(value: object) -> list:
    """The EA JSON-LD emits a bare object where there is one item and a list where
    there are several. Every field read from it goes through this."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def first_str(value: object) -> str | None:
    for item in as_list(value):
        if isinstance(item, str) and item.strip():
            return item.strip()
    return None


def fetch_stations(http: Http) -> dict[str, dict]:
    """Station metadata, keyed by the daily-mean measure notation.

    Keying by measure rather than station is what makes the readings join a plain
    dictionary lookup: the readings CSV identifies rows by measure URI only.
    """
    log.info("fetching hydrology station metadata")
    payload = http.get_json(f"{HYDROLOGY}/id/stations.json", {"observedProperty": "waterFlow", "_limit": 5000})
    items = payload.get("items", []) if isinstance(payload, dict) else []
    log.info("  %d stations returned", len(items))

    by_measure: dict[str, dict] = {}
    skipped_no_coords = skipped_no_measure = 0

    for item in items:
        lat, lon = item.get("lat"), item.get("long")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            skipped_no_coords += 1
            continue

        measure_id = None
        for measure in as_list(item.get("measures")):
            uri = measure.get("@id") if isinstance(measure, dict) else measure
            if isinstance(uri, str) and DAILY_MEAN_FRAGMENT in uri:
                measure_id = uri.rsplit("/", 1)[-1]
                break
        if not measure_id:
            skipped_no_measure += 1
            continue

        station_id = first_str(item.get("notation")) or measure_id
        by_measure[measure_id] = {
            "id": station_id,
            "name": first_str(item.get("label")) or "Unnamed gauge",
            "river": first_str(item.get("riverName")),
            "lon": round(float(lon), 5),
            "lat": round(float(lat), 5),
            "wiski": first_str(item.get("wiskiID")),
            "opened": first_str(item.get("dateOpened")),
        }

    log.info(
        "  usable: %d (skipped %d without coordinates, %d without a daily-mean measure)",
        len(by_measure),
        skipped_no_coords,
        skipped_no_measure,
    )
    return by_measure


def fetch_daily_readings(http: Http, start: datetime, end: datetime) -> dict[str, list[tuple[datetime, float, str]]]:
    """Daily mean discharge for every station, as (timestamp, value, quality).

    Requested as CSV rather than JSON: the same 30-day national window is ~5 MB
    of CSV against ~30 MB of JSON-LD, because every JSON row repeats the full
    measure URI and key names.
    """
    log.info("fetching daily mean flow %s .. %s", start.date(), end.date())
    raw = http.get_bytes(
        f"{HYDROLOGY}/data/readings.csv",
        {
            "observedProperty": "waterFlow",
            "period": 86400,
            "mineq-date": start.date().isoformat(),
            "maxeq-date": end.date().isoformat(),
            "_limit": 2_000_000,
        },
    )
    log.info("  %.1f MB of CSV", len(raw) / 1e6)

    readings: dict[str, list[tuple[datetime, float, str]]] = defaultdict(list)
    rejected = negatives = 0

    for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        measure = (row.get("measure") or "").rsplit("/", 1)[-1]
        if DAILY_MEAN_FRAGMENT not in measure:
            continue

        quality = (row.get("quality") or "Unchecked").strip()
        if quality in REJECT_QUALITY:
            rejected += 1
            continue

        raw_value = (row.get("value") or "").strip()
        if not raw_value:
            continue
        try:
            value = float(raw_value)
        except ValueError:
            continue

        if value < 0:
            # Tidal reach or a sensor fault. Dropped rather than clamped to zero,
            # because a fabricated zero looks like a real drought on the map.
            negatives += 1
            continue

        stamp = parse_date(row.get("date") or row.get("dateTime") or "")
        if stamp is None:
            continue
        readings[measure].append((stamp, value, quality))

    log.info(
        "  %d measures with readings (dropped %d flagged rows, %d negative values)",
        len(readings),
        rejected,
        negatives,
    )
    return readings


def parse_date(text: str) -> datetime | None:
    text = text.strip()
    if not text:
        return None
    try:
        # Accepts "2026-08-09" and "2026-08-09T09:00:00" alike; the API mixes them
        # between the `date` and `dateTime` columns.
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def parse_timestamp(value: object) -> str | None:
    """Normalise an instant to a UTC ISO-8601 string, or `None` if unparseable.

    Unlike `parse_date` this keeps the time of day, because the live layer is a
    15-minute snapshot whose whole point is the minute it was taken.

    Normalising to a single UTC representation is what makes the plain string
    comparison in `fetch_live` a genuine freshness test: raw API stamps may carry
    different offsets, and "2026-08-10T09:00:00+01:00" sorts after
    "2026-08-10T09:30:00Z" as text while being the earlier instant.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def fetch_live(http: Http) -> list[dict]:
    """Latest 15-minute flow for every real-time station, in one request.

    `?parameter=flow&latest` returns the whole national picture in ~120 KB, which
    is what makes a 15-minute refresh cadence essentially free.
    """
    log.info("fetching real-time flow snapshot")
    try:
        stations_payload = http.get_json(f"{FLOOD}/id/stations", {"parameter": "flow", "_limit": 2000})
        readings_payload = http.get_json(f"{FLOOD}/data/readings", {"parameter": "flow", "latest": "", "_limit": 5000})
    except HttpError as exc:
        # The live layer is additive. Losing it must not fail the whole ingest and
        # blank the archive layer that users actually navigate by.
        log.warning("live layer unavailable, continuing without it: %s", exc)
        return []

    meta: dict[str, dict] = {}
    for item in as_list(stations_payload.get("items")):
        reference = first_str(item.get("stationReference")) or first_str(item.get("notation"))
        lat, lon = item.get("lat"), item.get("long")
        if not reference or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        # The same null-coordinate guard the archive layer gets. A flood-monitoring
        # station with a missing easting/northing comes back as 0/0, which renders
        # in the Gulf of Guinea and reads as a real gauge to anyone looking.
        if not (-180 <= lon <= 180 and -90 <= lat <= 90) or (lon == 0 and lat == 0):
            log.debug("dropping live station %s at null/out-of-range coords (%s, %s)", reference, lon, lat)
            continue
        meta[reference] = {
            "id": f"rt-{reference}",
            "name": first_str(item.get("label")) or reference,
            "river": first_str(item.get("riverName")),
            "lon": round(float(lon), 5),
            "lat": round(float(lat), 5),
        }

    out: dict[str, dict] = {}
    for reading in as_list(readings_payload.get("items")):
        measure = (reading.get("measure") or "").rsplit("/", 1)[-1]
        reference = measure.split("-", 1)[0]
        station = meta.get(reference)
        value = reading.get("value")
        if not station or not isinstance(value, (int, float)) or value < 0:
            continue
        # `at` is rendered as a `<time datetime=...>` and turned into "3 h ago", so
        # an unparseable stamp is worse than a missing station: it becomes an
        # Invalid Date in the browser. Drop the reading rather than publish it.
        stamp = parse_timestamp(reading.get("dateTime"))
        if stamp is None:
            continue
        # A station can expose several flow measures (logged, stage-derived, mean).
        # Keep the freshest reading rather than whichever arrived last.
        existing = out.get(reference)
        if existing and existing["at"] >= stamp:
            continue
        out[reference] = {**station, "value": round(float(value), 3), "at": stamp}

    log.info("  %d live stations", len(out))
    return sorted(out.values(), key=lambda s: s["id"])


def build_reference(readings: dict[str, list[tuple[datetime, float, str]]]) -> dict[str, dict[str, float]]:
    """Per-station percentiles of daily mean discharge.

    Every colour in the UI is relative to the station's own distribution, because
    absolute discharge is meaningless across catchments: 20 m3/s is a drought on
    the Thames and a once-a-decade flood on a chalk stream.
    """
    reference: dict[str, dict[str, float]] = {}
    for measure, rows in readings.items():
        values = sorted(value for _, value, _ in rows)
        if len(values) < 10:
            # Too few points for a percentile to mean anything; the UI falls back
            # to a neutral colour for these stations.
            continue
        reference[measure] = {
            "p10": round(series.percentile(values, 0.10), 3),
            "p25": round(series.percentile(values, 0.25), 3),
            "p50": round(series.percentile(values, 0.50), 3),
            "p75": round(series.percentile(values, 0.75), 3),
            "p95": round(series.percentile(values, 0.95), 3),
            "n": len(values),
        }
    return reference


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=30, help="length of the published series window")
    parser.add_argument("--out", type=Path, default=Path("data/v1"), help="output directory")
    parser.add_argument(
        "--reference",
        action="store_true",
        help="also recompute the long-run percentile reference (slow; run monthly)",
    )
    parser.add_argument("--reference-days", type=int, default=365)
    parser.add_argument("--skip-live", action="store_true", help="skip the real-time layer")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    http = Http(min_interval=0.5)
    now = datetime.now(timezone.utc)
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    stations_by_measure = fetch_stations(http)
    if not stations_by_measure:
        log.error("no usable stations; refusing to overwrite a good bundle with an empty one")
        return 1

    window_start = now - timedelta(days=args.days)
    readings = fetch_daily_readings(http, window_start, now)

    reference_path = out / "reference.json"
    if args.reference:
        log.info("recomputing percentile reference over %d days", args.reference_days)
        long_readings = fetch_daily_readings(http, now - timedelta(days=args.reference_days), now)
        reference = build_reference(long_readings)
        contract.write_json(reference_path, {"generated_at": now.isoformat(), "days": args.reference_days, "by_measure": reference})
        log.info("  reference written for %d stations", len(reference))
    elif reference_path.exists():
        reference = json.loads(reference_path.read_text(encoding="utf-8")).get("by_measure", {})
        log.info("reusing existing percentile reference (%d stations)", len(reference))
    else:
        # First run in a fresh clone: derive from whatever window we have so the
        # map is usable immediately, and label it honestly in meta.json.
        log.info("no reference on disk - deriving from the %d-day window", args.days)
        reference = build_reference(readings)

    axis = series.daily_axis(window_start, now)
    step = timedelta(days=1)

    published: list[dict] = []
    columns: dict[str, list[float | None]] = {}

    for measure, station in sorted(stations_by_measure.items(), key=lambda kv: kv[1]["id"]):
        rows = readings.get(measure)
        if not rows:
            continue
        values = series.bucket_to_axis([(when, value) for when, value, _ in rows], axis, step)
        newest = series.latest(values)
        if newest is None:
            continue

        _, current = newest
        station_reference = reference.get(measure)
        grades = {quality for _, _, quality in rows}
        record = {
            "id": station["id"],
            "name": station["name"],
            "lon": station["lon"],
            "lat": station["lat"],
            "value": current,
            "state": series.flow_state(current, station_reference) if station_reference else "normal",
            "coverage": series.coverage(values),
            "quality": min(grades, key=lambda q: QUALITY_ORDER.get(q, 2)) if grades else "Unchecked",
        }
        if station["river"]:
            record["river"] = station["river"]
        if station_reference:
            record["reference"] = {k: v for k, v in station_reference.items() if k != "n"}
        published.append(record)
        columns[station["id"]] = values

    if not published:
        log.error("every station was filtered out; refusing to publish an empty bundle")
        return 1

    sizes = {
        "stations.json": contract.write_json(out / "stations.json", published),
        "series.json": contract.write_json(
            out / "series.json",
            {"t": [int(slot.timestamp()) for slot in axis], "step": int(step.total_seconds()), "v": columns},
        ),
    }

    live = [] if args.skip_live else fetch_live(http)
    live_path = out / "live.json"
    if live:
        sizes["live.json"] = contract.write_json(live_path, live)
    elif live_path.exists():
        # The live layer is additive, so losing it does not fail the ingest - but
        # leaving the previous file behind is worse than dropping the layer. The
        # committed seed ships a live.json, so a failed fetch would otherwise
        # republish a weeks-old snapshot under a "Live - 15-minute" label while
        # meta.counts.live said zero. Remove it and let the front end degrade.
        live_path.unlink()
        log.warning("removed a stale live.json; this run has no real-time layer")

    meta = {
        "contract": contract.CONTRACT_VERSION,
        "generated_at": now.replace(microsecond=0).isoformat(),
        "region": {"code": "GB", "name": "United Kingdom", "centre": [-2.2, 54.2], "zoom": 4.6},
        "units": {"discharge": "m3/s"},
        "resolution": {"archive": "P1D", "live": "PT15M"},
        "window": {"start": axis[0].date().isoformat(), "end": axis[-1].date().isoformat(), "days": args.days},
        "reference": {
            "source": "long-run" if args.reference or reference_path.exists() else "window",
            "stations": len(reference),
        },
        "counts": {"stations": len(published), "live": len(live), "samples": len(axis)},
        "sources": SOURCES,
        "bytes": sizes,
    }
    contract.write_json(out / "meta.json", meta)

    total = sum(sizes.values())
    log.info("wrote %d stations, %d samples, %d live | %.0f KB uncompressed", len(published), len(axis), len(live), total / 1024)
    for name, size in sorted(sizes.items()):
        log.info("  %-16s %7.1f KB", name, size / 1024)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
