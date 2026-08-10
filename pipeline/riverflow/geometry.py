"""Line simplification and coordinate quantisation.

The single biggest lever on page weight is geometry, and raw OpenStreetMap
waterways are far more detailed than a zoomable flow map needs. Simplifying to
a tolerance and then rounding coordinates to a fixed number of decimals cuts
payload by roughly an order of magnitude with no visible difference at the
zoom levels this map uses.
"""

from __future__ import annotations

import math

Point = tuple[float, float]

# 5 decimal places is ~1.1 m at the equator - well below the accuracy of the
# source data and far finer than a river line drawn 2 px wide.
COORD_DECIMALS = 5


def simplify(points: list[Point], tolerance_deg: float) -> list[Point]:
    """Ramer-Douglas-Peucker simplification, iterative to avoid deep recursion.

    A long river way can carry tens of thousands of vertices; a recursive
    implementation blows the stack on the worst of them, so the split stack is
    explicit here.

    Args:
        points: Ordered [lon, lat] vertices.
        tolerance_deg: Maximum perpendicular deviation, in degrees.

    Returns:
        A simplified line preserving the first and last vertex.
    """
    if len(points) < 3 or tolerance_deg <= 0:
        return list(points)

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack: list[tuple[int, int]] = [(0, len(points) - 1)]

    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        worst_index, worst_distance = start, -1.0
        ax, ay = points[start]
        bx, by = points[end]
        for index in range(start + 1, end):
            distance = _perpendicular_distance(points[index], ax, ay, bx, by)
            if distance > worst_distance:
                worst_index, worst_distance = index, distance
        if worst_distance > tolerance_deg:
            keep[worst_index] = True
            stack.append((start, worst_index))
            stack.append((worst_index, end))

    return [point for point, keeper in zip(points, keep) if keeper]


def _perpendicular_distance(point: Point, ax: float, ay: float, bx: float, by: float) -> float:
    px, py = point
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    # Projection parameter of point onto segment AB, clamped to the segment.
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def quantise(points: list[Point], decimals: int = COORD_DECIMALS) -> list[Point]:
    """Round coordinates and drop consecutive duplicates created by rounding."""
    out: list[Point] = []
    for lon, lat in points:
        rounded = (round(lon, decimals), round(lat, decimals))
        if not out or out[-1] != rounded:
            out.append(rounded)
    return out


def haversine_km(a: Point, b: Point) -> float:
    """Great-circle distance in kilometres between two [lon, lat] points."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def line_length_km(points: list[Point]) -> float:
    return sum(haversine_km(points[i], points[i + 1]) for i in range(len(points) - 1))


def sample_along(points: list[Point], spacing_km: float) -> list[Point]:
    """Pick points spaced roughly `spacing_km` apart along a polyline.

    Used to place virtual gauges on a river centreline when the discharge source
    is a grid model rather than a set of physical stations.
    """
    if not points:
        return []
    picked = [points[0]]
    carried = 0.0
    for index in range(len(points) - 1):
        segment = haversine_km(points[index], points[index + 1])
        if segment == 0.0:
            continue
        travelled = carried
        while travelled + spacing_km <= carried + segment:
            travelled += spacing_km
            fraction = (travelled - carried) / segment
            lon = points[index][0] + fraction * (points[index + 1][0] - points[index][0])
            lat = points[index][1] + fraction * (points[index + 1][1] - points[index][1])
            picked.append((round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)))
        carried += segment
    if picked[-1] != points[-1]:
        picked.append(points[-1])
    return picked


def bbox(points: list[Point]) -> tuple[float, float, float, float]:
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return (min(lons), min(lats), max(lons), max(lats))
