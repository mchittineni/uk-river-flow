"""Columnar packing for station time series.

A naive `[{"t": "...", "v": 1.2}, ...]` per station spends most of its bytes
repeating ISO timestamps and JSON punctuation. Storing one shared time axis and
a bare array of values per station cuts the payload by roughly 5x before gzip
and makes the browser-side time slider a plain array index rather than a search.
"""

from __future__ import annotations

import bisect
from datetime import datetime, timedelta, timezone

# Values are rounded before serialising: gauge discharge is not meaningful to
# more than a few significant figures, and trailing float noise is pure payload.
VALUE_DECIMALS = 3


def hourly_axis(start: datetime, end: datetime) -> list[datetime]:
    """Inclusive hourly timestamps, normalised to the top of the hour in UTC."""
    cursor = start.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    stop = end.astimezone(timezone.utc)
    axis: list[datetime] = []
    while cursor <= stop:
        axis.append(cursor)
        cursor += timedelta(hours=1)
    return axis


def daily_axis(start: datetime, end: datetime) -> list[datetime]:
    cursor = start.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    stop = end.astimezone(timezone.utc)
    axis: list[datetime] = []
    while cursor <= stop:
        axis.append(cursor)
        cursor += timedelta(days=1)
    return axis


def bucket_to_axis(
    readings: list[tuple[datetime, float]],
    axis: list[datetime],
    step: timedelta,
) -> list[float | None]:
    """Average readings into fixed buckets aligned to `axis`.

    The Environment Agency publishes flow at 15-minute resolution; keeping all
    of it would quadruple payload for detail invisible on a 7-day chart. Each
    axis slot becomes the mean of the readings that fall inside it, and slots
    with no reading stay `None` so the front end can render a genuine gap
    instead of interpolating over an outage.
    """
    if not axis:
        return []
    sums = [0.0] * len(axis)
    counts = [0] * len(axis)
    epochs = [slot.timestamp() for slot in axis]
    span = step.total_seconds()

    for when, value in readings:
        ts = when.timestamp()
        index = bisect.bisect_right(epochs, ts) - 1
        if 0 <= index < len(axis) and ts - epochs[index] < span:
            sums[index] += value
            counts[index] += 1

    return [round(sums[i] / counts[i], VALUE_DECIMALS) if counts[i] else None for i in range(len(axis))]


def coverage(values: list[float | None]) -> float:
    """Fraction of axis slots that carry a real reading, 0.0-1.0."""
    if not values:
        return 0.0
    return round(sum(1 for v in values if v is not None) / len(values), 3)


def latest(values: list[float | None]) -> tuple[int, float] | None:
    """Most recent non-null value as (index, value), or None if all null."""
    for index in range(len(values) - 1, -1, -1):
        value = values[index]
        if value is not None:
            return index, value
    return None


def percentile(sorted_values: list[float], fraction: float) -> float:
    """Linear-interpolated percentile of an already-sorted list."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = fraction * (len(sorted_values) - 1)
    low = int(position)
    high = min(low + 1, len(sorted_values) - 1)
    weight = position - low
    return sorted_values[low] * (1 - weight) + sorted_values[high] * weight


def flow_state(value: float, reference: dict[str, float]) -> str:
    """Classify a reading against a station's own historical distribution.

    Absolute discharge says nothing useful on its own - 20 m3/s is a drought on
    the Thames and a flood on a chalk stream. Every colour and label in the UI
    is driven by this per-station relative scale instead.
    """
    if value <= reference.get("p10", 0.0):
        return "very-low"
    if value <= reference.get("p25", 0.0):
        return "low"
    if value >= reference.get("p95", float("inf")):
        return "very-high"
    if value >= reference.get("p75", float("inf")):
        return "high"
    return "normal"
