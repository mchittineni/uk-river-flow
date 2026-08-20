"""The published data contract, and its validator.

The front end is deployed independently of the ingest, so the JSON in `data/`
is a real API between two moving parts. This module is the single definition of
that API: the writers build payloads through `write_bundle`, and CI runs
`validate_bundle` on every change so a malformed ingest fails the pipeline
instead of silently blanking the map in production.

Kept as hand-written checks rather than a JSON Schema library so the ingest
keeps its zero-dependency property.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

CONTRACT_VERSION = 1

FLOW_STATES = frozenset({"very-low", "low", "normal", "high", "very-high"})
REQUIRED_REFERENCE_KEYS = ("p10", "p25", "p50", "p75", "p95")

# The front end cannot render without these three; everything else is additive.
REQUIRED_FILES = ("meta.json", "stations.json", "series.json")
OPTIONAL_FILES = ("network.geojson", "live.json", "climatology.json", "gauges.json")


class ContractError(AssertionError):
    """The data on disk does not satisfy the published contract."""


def _check(condition: bool, message: str, errors: list[str]) -> bool:
    if not condition:
        errors.append(message)
    return condition


def write_json(path: Path, payload: Any) -> int:
    """Write compact JSON and return the byte size.

    Separators are tightened and keys sorted: compact output is smaller over the
    wire, and stable key order means a re-run with unchanged data produces an
    identical file, so the scheduled commit is a genuine no-op rather than
    churning the git history every 15 minutes.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":"), sort_keys=True, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8")
    return len(text) + 1


def read_json(path: Path) -> Any:
    """Read a JSON file written by this pipeline."""
    return json.loads(path.read_text(encoding="utf-8"))


def validate_bundle(root: Path) -> list[str]:
    """Validate a `data/v1` directory. Returns a list of human-readable errors."""
    errors: list[str] = []
    root = root.resolve()

    for name in REQUIRED_FILES:
        if not (root / name).exists():
            errors.append(f"missing required file: {name}")
    if errors:
        return errors

    meta = read_json(root / "meta.json")
    stations = read_json(root / "stations.json")
    series = read_json(root / "series.json")

    _validate_meta(meta, errors)
    ids = _validate_stations(stations, errors)
    _validate_series(series, ids, errors)

    # The river-geometry layer is optional: it is static context that a region may
    # not ship (Overpass cannot practically tile a subcontinent), and the front end
    # already degrades to station markers alone. Validated only when present.
    network_path = root / "network.geojson"
    if network_path.exists():
        _validate_network(read_json(network_path), errors)

    # The live layer is optional in the same way, and is validated separately from
    # stations.json because it comes from a different service with different
    # identifiers (docs/adr/0004) - it is not a subset of the archive.
    live_path = root / "live.json"
    live: Any = None
    if live_path.exists():
        live = read_json(live_path)
        _validate_live(live, errors)

    # Cross-file coherence: the counts advertised in meta.json are what the UI
    # shows before the big files land, so a mismatch is a user-visible lie.
    if isinstance(meta.get("counts"), dict):
        declared = meta["counts"].get("stations")
        if declared is not None and declared != len(ids):
            errors.append(f"meta.counts.stations={declared} but stations.json has {len(ids)}")

        declared_live = meta["counts"].get("live")
        published_live = len(live) if isinstance(live, list) else 0
        if declared_live is not None and declared_live != published_live:
            # Catches the failure that matters: a live fetch that failed, leaving a
            # previous run's snapshot on disk to be served as if it were current.
            errors.append(
                f"meta.counts.live={declared_live} but live.json has {published_live}"
                + ("" if live_path.exists() else " (no live.json present)")
            )

    return errors


def _validate_live(live: Any, errors: list[str]) -> None:
    """Validate the real-time snapshot.

    Every field here is rendered directly: `at` becomes a `<time datetime=...>`
    and a "3 h ago" label, so an unparseable stamp is an Invalid Date in the
    browser rather than a cosmetic problem.
    """
    if not _check(isinstance(live, list), "live.json must be an array", errors):
        return

    seen: set[str] = set()
    for index, station in enumerate(live):
        where = f"live[{index}]"
        if not isinstance(station, dict):
            errors.append(f"{where} must be an object")
            continue

        station_id = station.get("id")
        if not isinstance(station_id, str) or not station_id:
            errors.append(f"{where}.id must be a non-empty string")
        elif station_id in seen:
            errors.append(f"{where}.id duplicated: {station_id}")
        else:
            seen.add(station_id)

        _check(bool(station.get("name")), f"{where}.name is required", errors)

        lon, lat = station.get("lon"), station.get("lat")
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            _check(-180 <= lon <= 180, f"{where}.lon out of range: {lon}", errors)
            _check(-90 <= lat <= 90, f"{where}.lat out of range: {lat}", errors)
            _check(not (lon == 0 and lat == 0), f"{where} sits at null island (0,0)", errors)
        else:
            errors.append(f"{where}.lon/lat must be numbers")

        value = station.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            errors.append(f"{where}.value must be a number")
        elif math.isnan(value) or math.isinf(value):
            errors.append(f"{where}.value is NaN/Inf")
        elif value < 0:
            errors.append(f"{where}.value is negative discharge: {value}")

        at = station.get("at")
        if not isinstance(at, str) or not _parses_as_instant(at):
            errors.append(f"{where}.at must be an ISO-8601 instant, got {at!r}")


def _parses_as_instant(text: str) -> bool:
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _validate_meta(meta: Any, errors: list[str]) -> None:
    if not _check(isinstance(meta, dict), "meta.json must be an object", errors):
        return
    _check(meta.get("contract") == CONTRACT_VERSION, f"meta.contract must be {CONTRACT_VERSION}", errors)
    for key in ("generated_at", "region", "sources", "counts", "units"):
        _check(key in meta, f"meta.{key} is required", errors)
    _check(
        isinstance(meta.get("sources"), list) and bool(meta.get("sources")),
        "meta.sources must be a non-empty list (attribution is a licence obligation)",
        errors,
    )
    for index, source in enumerate(meta.get("sources") or []):
        if isinstance(source, dict):
            for key in ("name", "licence", "url"):
                _check(bool(source.get(key)), f"meta.sources[{index}].{key} is required", errors)
        else:
            errors.append(f"meta.sources[{index}] must be an object")


def _validate_stations(stations: Any, errors: list[str]) -> set[str]:
    ids: set[str] = set()
    if not _check(isinstance(stations, list), "stations.json must be an array", errors):
        return ids
    _check(bool(stations), "stations.json must not be empty", errors)

    for index, station in enumerate(stations):
        where = f"stations[{index}]"
        if not isinstance(station, dict):
            errors.append(f"{where} must be an object")
            continue

        station_id = station.get("id")
        if not isinstance(station_id, str) or not station_id:
            errors.append(f"{where}.id must be a non-empty string")
        elif station_id in ids:
            errors.append(f"{where}.id duplicated: {station_id}")
        else:
            ids.add(station_id)

        for key in ("name", "lon", "lat", "state"):
            _check(key in station, f"{where}.{key} is required", errors)

        lon, lat = station.get("lon"), station.get("lat")
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            # A station at (0, 0) is the classic sign of a null coordinate that
            # survived parsing; it would render in the Gulf of Guinea.
            _check(-180 <= lon <= 180, f"{where}.lon out of range: {lon}", errors)
            _check(-90 <= lat <= 90, f"{where}.lat out of range: {lat}", errors)
            _check(not (lon == 0 and lat == 0), f"{where} sits at null island (0,0)", errors)
        else:
            errors.append(f"{where}.lon/lat must be numbers")

        state = station.get("state")
        if state is not None:
            _check(state in FLOW_STATES, f"{where}.state invalid: {state!r}", errors)

        reference = station.get("reference")
        if reference is not None:
            if isinstance(reference, dict):
                missing = [k for k in REQUIRED_REFERENCE_KEYS if k not in reference]
                _check(not missing, f"{where}.reference missing {missing}", errors)
                ordered = [reference.get(k) for k in REQUIRED_REFERENCE_KEYS]
                if all(isinstance(v, (int, float)) for v in ordered):
                    _check(
                        all(ordered[i] <= ordered[i + 1] for i in range(len(ordered) - 1)),
                        f"{where}.reference percentiles not monotonic: {ordered}",
                        errors,
                    )
            else:
                errors.append(f"{where}.reference must be an object")

    return ids


def _validate_series(series: Any, station_ids: set[str], errors: list[str]) -> None:
    if not _check(isinstance(series, dict), "series.json must be an object", errors):
        return

    axis = series.get("t")
    if not _check(isinstance(axis, list) and bool(axis), "series.t must be a non-empty array", errors):
        return
    _check(
        all(isinstance(t, int) for t in axis),
        "series.t must be integer epoch seconds (compact and timezone-free)",
        errors,
    )
    _check(
        all(axis[i] < axis[i + 1] for i in range(len(axis) - 1)),
        "series.t must be strictly increasing",
        errors,
    )

    values = series.get("v")
    if not _check(isinstance(values, dict), "series.v must be an object keyed by station id", errors):
        return

    unknown = set(values) - station_ids
    if unknown:
        errors.append(f"series.v has {len(unknown)} ids absent from stations.json, e.g. {sorted(unknown)[:3]}")

    for station_id, column in values.items():
        if not isinstance(column, list):
            errors.append(f"series.v[{station_id}] must be an array")
            continue
        if len(column) != len(axis):
            errors.append(f"series.v[{station_id}] length {len(column)} != axis length {len(axis)}")
        for value in column:
            if value is None:
                continue
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                errors.append(f"series.v[{station_id}] contains a non-numeric value: {value!r}")
                break
            if math.isnan(value) or math.isinf(value):
                errors.append(f"series.v[{station_id}] contains NaN/Inf")
                break
            if value < 0:
                # Negative discharge means tidal reversal or a sensor fault. It
                # breaks the log colour scale, so the ingest must clamp or drop it.
                errors.append(f"series.v[{station_id}] contains negative discharge: {value}")
                break


def _validate_network(network: Any, errors: list[str]) -> None:
    if not _check(isinstance(network, dict), "network.geojson must be an object", errors):
        return
    _check(network.get("type") == "FeatureCollection", "network.geojson must be a FeatureCollection", errors)
    features = network.get("features")
    if not _check(isinstance(features, list), "network.geojson.features must be an array", errors):
        return
    _check(bool(features), "network.geojson has no features", errors)

    for index, feature in enumerate(features[:5000]):
        where = f"network.features[{index}]"
        if not isinstance(feature, dict):
            errors.append(f"{where} must be an object")
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            errors.append(f"{where}.geometry.type must be LineString, got {geometry.get('type')!r}")
            continue
        coords = geometry.get("coordinates")
        if not isinstance(coords, list) or len(coords) < 2:
            errors.append(f"{where} needs at least 2 coordinates")
            continue
        first = coords[0]
        if not (isinstance(first, list) and len(first) == 2):
            errors.append(f"{where} coordinates must be [lon, lat] pairs")


def assert_valid(root: Path) -> None:
    """Raise `ContractError` listing every problem, for use in CI."""
    errors = validate_bundle(root)
    if errors:
        listing = "\n".join(f"  - {error}" for error in errors[:60])
        more = "" if len(errors) <= 60 else f"\n  ... and {len(errors) - 60} more"
        raise ContractError(f"{len(errors)} contract violation(s) in {root}:\n{listing}{more}")
