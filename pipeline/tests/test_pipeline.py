"""Unit tests for the ingest core.

Run with `python3 -m unittest discover -s pipeline/tests`. No network access and no
third-party packages, so these run identically on a laptop and in CI.

The focus is the logic that is easy to get quietly wrong and expensive to notice:
bucketing readings onto a time axis, percentile boundaries, geometry
simplification, and the contract validator actually rejecting bad bundles.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from riverflow import contract, geometry, http, series


UTC = timezone.utc


def day(year: int, month: int, number: int) -> datetime:
    return datetime(year, month, number, tzinfo=UTC)


class TestSeriesBucketing(unittest.TestCase):
    def test_readings_average_into_their_slot(self):
        axis = series.daily_axis(day(2026, 1, 1), day(2026, 1, 3))
        readings = [
            (datetime(2026, 1, 1, 6, tzinfo=UTC), 10.0),
            (datetime(2026, 1, 1, 18, tzinfo=UTC), 20.0),
            (datetime(2026, 1, 3, 0, tzinfo=UTC), 5.0),
        ]
        values = series.bucket_to_axis(readings, axis, timedelta(days=1))
        self.assertEqual(values, [15.0, None, 5.0])

    def test_gaps_stay_none_rather_than_being_interpolated(self):
        axis = series.daily_axis(day(2026, 1, 1), day(2026, 1, 5))
        values = series.bucket_to_axis([(day(2026, 1, 1), 1.0), (day(2026, 1, 5), 9.0)], axis, timedelta(days=1))
        self.assertEqual(values, [1.0, None, None, None, 9.0])

    def test_readings_outside_the_axis_are_ignored(self):
        axis = series.daily_axis(day(2026, 6, 1), day(2026, 6, 2))
        values = series.bucket_to_axis(
            [(day(2020, 1, 1), 999.0), (day(2026, 6, 1), 4.0)], axis, timedelta(days=1)
        )
        self.assertEqual(values, [4.0, None])

    def test_coverage_and_latest(self):
        self.assertEqual(series.coverage([1.0, None, 3.0, None]), 0.5)
        self.assertEqual(series.coverage([]), 0.0)
        self.assertEqual(series.latest([1.0, None, 7.0, None]), (2, 7.0))
        self.assertIsNone(series.latest([None, None]))

    def test_axis_is_inclusive_and_normalised(self):
        axis = series.daily_axis(datetime(2026, 3, 1, 17, 42, tzinfo=UTC), day(2026, 3, 3))
        self.assertEqual(len(axis), 3)
        self.assertEqual(axis[0], day(2026, 3, 1))
        self.assertTrue(all(slot.hour == 0 for slot in axis))


class TestPercentiles(unittest.TestCase):
    def test_known_values(self):
        data = [float(n) for n in range(1, 101)]
        self.assertAlmostEqual(series.percentile(data, 0.0), 1.0)
        self.assertAlmostEqual(series.percentile(data, 1.0), 100.0)
        self.assertAlmostEqual(series.percentile(data, 0.5), 50.5)

    def test_degenerate_inputs(self):
        self.assertEqual(series.percentile([], 0.5), 0.0)
        self.assertEqual(series.percentile([42.0], 0.9), 42.0)

    def test_flow_state_boundaries_are_inclusive_at_the_tails(self):
        reference = {"p10": 10.0, "p25": 25.0, "p50": 50.0, "p75": 75.0, "p95": 95.0}
        self.assertEqual(series.flow_state(5.0, reference), "very-low")
        self.assertEqual(series.flow_state(10.0, reference), "very-low")
        self.assertEqual(series.flow_state(20.0, reference), "low")
        self.assertEqual(series.flow_state(25.0, reference), "low")
        self.assertEqual(series.flow_state(50.0, reference), "normal")
        self.assertEqual(series.flow_state(75.0, reference), "high")
        self.assertEqual(series.flow_state(95.0, reference), "very-high")
        self.assertEqual(series.flow_state(1000.0, reference), "very-high")

    def test_flow_state_matches_the_front_end_thresholds(self):
        # data.js reimplements this for time scrubbing. The two must not drift, so
        # the JS thresholds are asserted here in the same order they appear there.
        reference = {"p10": 1.0, "p25": 2.0, "p50": 3.0, "p75": 4.0, "p95": 5.0}
        expected = {
            0.5: "very-low",
            1.5: "low",
            3.0: "normal",
            4.5: "high",
            6.0: "very-high",
        }
        for value, state in expected.items():
            self.assertEqual(series.flow_state(value, reference), state, msg=f"value={value}")


class TestGeometry(unittest.TestCase):
    def test_simplify_removes_collinear_points(self):
        line = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)]
        self.assertEqual(geometry.simplify(line, 0.001), [(0.0, 0.0), (3.0, 0.0)])

    def test_simplify_keeps_a_real_deviation(self):
        line = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)]
        self.assertEqual(len(geometry.simplify(line, 0.1)), 3)

    def test_simplify_always_keeps_the_endpoints(self):
        line = [(float(n), (n % 2) * 1e-9) for n in range(500)]
        simplified = geometry.simplify(line, 0.5)
        self.assertEqual(simplified[0], line[0])
        self.assertEqual(simplified[-1], line[-1])

    def test_simplify_handles_a_deeply_split_line_without_recursion_error(self):
        # A recursive Douglas-Peucker overflows the stack once the split depth
        # passes ~1000, which is why the implementation carries an explicit stack.
        # A pure zigzag forces maximum depth: every interior point is kept, so the
        # recursion is n deep. 4000 points is well past any recursion limit while
        # staying fast - the algorithm is quadratic on this input by construction.
        line = [(n * 0.001, ((-1) ** n) * 0.01) for n in range(4_000)]
        simplified = geometry.simplify(line, 0.0001)
        self.assertEqual(len(simplified), len(line))
        self.assertEqual(simplified[0], line[0])
        self.assertEqual(simplified[-1], line[-1])

    def test_quantise_drops_duplicates_created_by_rounding(self):
        line = [(1.000001, 2.000001), (1.000002, 2.000002), (3.5, 4.5)]
        self.assertEqual(geometry.quantise(line, 5), [(1.0, 2.0), (3.5, 4.5)])

    def test_haversine_against_a_known_distance(self):
        # London to Paris, ~344 km great-circle.
        km = geometry.haversine_km((-0.1276, 51.5072), (2.3522, 48.8566))
        self.assertAlmostEqual(km, 344, delta=5)

    def test_sample_along_spaces_points_and_keeps_the_ends(self):
        line = [(0.0, 0.0), (0.0, 1.0)]  # ~111 km due north
        picked = geometry.sample_along(line, 25.0)
        self.assertEqual(picked[0], line[0])
        self.assertEqual(picked[-1], line[-1])
        self.assertGreaterEqual(len(picked), 5)

    def test_bbox(self):
        self.assertEqual(geometry.bbox([(1.0, 5.0), (-3.0, 2.0), (0.0, 9.0)]), (-3.0, 2.0, 1.0, 9.0))


class TestContract(unittest.TestCase):
    """The validator is the guard between a bad ingest and a broken production map,
    so each test asserts it *rejects* a specific realistic failure."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.addCleanup(self.dir.cleanup)

    def write(self, **overrides):
        stations = overrides.get(
            "stations",
            [
                {
                    "id": "s1",
                    "name": "Test gauge",
                    "lon": -1.5,
                    "lat": 53.2,
                    "value": 4.0,
                    "state": "normal",
                    "reference": {"p10": 1.0, "p25": 2.0, "p50": 3.0, "p75": 4.0, "p95": 5.0},
                }
            ],
        )
        default_series = {"t": [1700000000, 1700086400], "step": 86400, "v": {"s1": [3.5, 4.0]}}
        meta = overrides.get(
            "meta",
            {
                "contract": 1,
                "generated_at": "2026-01-01T00:00:00+00:00",
                "region": {"code": "GB", "name": "United Kingdom"},
                "units": {"discharge": "m3/s"},
                "counts": {"stations": len(stations)},
                "sources": [{"name": "EA", "licence": "OGL v3", "url": "https://example.org"}],
            },
        )
        contract.write_json(self.root / "meta.json", meta)
        contract.write_json(self.root / "stations.json", stations)
        contract.write_json(self.root / "series.json", overrides.get("series", default_series))

    def test_a_good_bundle_passes(self):
        self.write()
        self.assertEqual(contract.validate_bundle(self.root), [])

    def test_missing_file_is_reported(self):
        errors = contract.validate_bundle(self.root)
        self.assertTrue(any("missing required file" in error for error in errors))

    def test_duplicate_station_ids_are_rejected(self):
        base = {
            "id": "dupe",
            "name": "A",
            "lon": 1.0,
            "lat": 2.0,
            "value": 1.0,
            "state": "normal",
        }
        self.write(stations=[base, dict(base)], series={"t": [1], "step": 86400, "v": {}})
        self.assertTrue(any("duplicated" in error for error in contract.validate_bundle(self.root)))

    def test_null_island_coordinates_are_rejected(self):
        self.write(
            stations=[{"id": "s1", "name": "A", "lon": 0, "lat": 0, "value": 1.0, "state": "normal"}],
            series={"t": [1], "step": 86400, "v": {}},
        )
        self.assertTrue(any("null island" in error for error in contract.validate_bundle(self.root)))

    def test_series_length_mismatch_is_rejected(self):
        self.write(series={"t": [1, 2, 3], "step": 86400, "v": {"s1": [1.0, 2.0]}})
        self.assertTrue(any("length" in error for error in contract.validate_bundle(self.root)))

    def test_negative_discharge_is_rejected(self):
        self.write(series={"t": [1, 2], "step": 86400, "v": {"s1": [1.0, -3.0]}})
        self.assertTrue(any("negative" in error for error in contract.validate_bundle(self.root)))

    def test_non_monotonic_time_axis_is_rejected(self):
        self.write(series={"t": [5, 3], "step": 86400, "v": {"s1": [1.0, 2.0]}})
        self.assertTrue(any("increasing" in error for error in contract.validate_bundle(self.root)))

    def test_non_monotonic_percentiles_are_rejected(self):
        self.write(
            stations=[
                {
                    "id": "s1",
                    "name": "A",
                    "lon": 1.0,
                    "lat": 2.0,
                    "value": 1.0,
                    "state": "normal",
                    "reference": {"p10": 9.0, "p25": 2.0, "p50": 3.0, "p75": 4.0, "p95": 5.0},
                }
            ],
            series={"t": [1], "step": 86400, "v": {"s1": [1.0]}},
        )
        self.assertTrue(any("monotonic" in error for error in contract.validate_bundle(self.root)))

    def test_series_id_absent_from_stations_is_rejected(self):
        self.write(series={"t": [1, 2], "step": 86400, "v": {"ghost": [1.0, 2.0]}})
        self.assertTrue(any("absent from stations" in error for error in contract.validate_bundle(self.root)))

    def test_sources_are_required_because_attribution_is_a_licence_obligation(self):
        self.write(
            meta={
                "contract": 1,
                "generated_at": "2026-01-01T00:00:00+00:00",
                "region": {"code": "GB"},
                "units": {"discharge": "m3/s"},
                "counts": {"stations": 1},
                "sources": [],
            }
        )
        self.assertTrue(any("sources" in error for error in contract.validate_bundle(self.root)))

    def test_meta_count_mismatch_is_rejected(self):
        self.write(
            meta={
                "contract": 1,
                "generated_at": "2026-01-01T00:00:00+00:00",
                "region": {"code": "GB"},
                "units": {"discharge": "m3/s"},
                "counts": {"stations": 99},
                "sources": [{"name": "EA", "licence": "OGL v3", "url": "https://example.org"}],
            }
        )
        self.assertTrue(any("meta.counts.stations" in error for error in contract.validate_bundle(self.root)))

    def test_write_json_is_byte_stable_for_equal_payloads(self):
        # The scheduled ingest relies on this: identical data must produce an
        # identical file, or every run would churn a diff.
        first = self.root / "a.json"
        second = self.root / "b.json"
        payload = {"b": 2, "a": [1, 2, 3]}
        contract.write_json(first, payload)
        contract.write_json(second, {"a": [1, 2, 3], "b": 2})
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_write_json_refuses_nan(self):
        with self.assertRaises(ValueError):
            contract.write_json(self.root / "nan.json", {"x": float("nan")})

    def test_assert_valid_raises_with_a_listing(self):
        with self.assertRaises(contract.ContractError) as caught:
            contract.assert_valid(self.root)
        self.assertIn("missing required file", str(caught.exception))

    def test_network_is_optional_but_validated_when_present(self):
        self.write()
        self.assertEqual(contract.validate_bundle(self.root), [])
        (self.root / "network.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 2]}, "properties": {}}]}),
            encoding="utf-8",
        )
        self.assertTrue(any("LineString" in error for error in contract.validate_bundle(self.root)))


class TestRateLimitHandling(unittest.TestCase):
    """The 429 handling is the difference between a pipeline that survives a free
    API's quota and one that fails every run. These assert the observed behaviour of
    Open-Meteo's limiter, which names the exceeded window in the response body."""

    def test_classifies_the_window_from_the_response_body(self):
        hourly = '{"error":true,"reason":"Hourly API request limit exceeded. Please try again in the next hour."}'
        self.assertEqual(http.classify_rate_limit(hourly), "hour")
        self.assertEqual(http.classify_rate_limit("Minutely API request limit exceeded"), "minute")
        self.assertEqual(http.classify_rate_limit("Daily API request limit exceeded"), "day")

    def test_unrecognised_body_yields_no_window(self):
        self.assertIsNone(http.classify_rate_limit("429 Too Many Requests"))
        self.assertIsNone(http.classify_rate_limit(""))

    def test_waits_for_the_boundary_not_a_fixed_duration(self):
        # 15:49:45 -> the hour rolls in 615 s, plus a small margin.
        at_15_49_45 = 15 * 3600 + 49 * 60 + 45
        self.assertAlmostEqual(http.seconds_until_next("hour", at_15_49_45), 620, delta=1)
        # A minute limit hit at :45 needs seconds, not a minute-plus dwell.
        self.assertAlmostEqual(http.seconds_until_next("minute", 45), 17, delta=1)

    def test_boundary_wait_is_always_positive(self):
        # Right on a boundary the naive arithmetic gives 0, which would retry into
        # the same window; the margin has to keep it positive.
        for window in ("minute", "hour", "day"):
            for stamp in (0, 1, 59, 3599, 86399):
                self.assertGreater(http.seconds_until_next(window, stamp), 0)

    def test_backoff_is_jittered_and_capped(self):
        delays = [http._backoff(6) for _ in range(50)]
        self.assertTrue(all(0 < delay <= 60.0 for delay in delays), delays[:5])
        # Full jitter: 50 draws should not all be identical.
        self.assertGreater(len(set(round(delay, 6) for delay in delays)), 1)

    def test_retry_status_set_excludes_client_errors(self):
        for status in (400, 401, 403, 404, 410):
            self.assertNotIn(status, http.RETRY_STATUS, f"{status} must not be retried")
        for status in (429, 500, 502, 503, 504):
            self.assertIn(status, http.RETRY_STATUS)

    def test_reads_a_gzipped_error_body(self):
        """Regression: we send `Accept-Encoding: gzip`, and the API gzips its *error*
        responses too. Decoding those bytes as UTF-8 without gunzipping produced
        mojibake, so the window hint was silently lost and every 429 fell back to a
        fixed 65 s dwell - useless against an hourly limit."""
        import gzip as gziplib

        body = '{"error":true,"reason":"Hourly API request limit exceeded."}'
        compressed = gziplib.compress(body.encode())

        # The naive path finds nothing...
        self.assertIsNone(http.classify_rate_limit(compressed.decode("utf-8", "replace")))
        # ...and the decompressed body classifies correctly.
        self.assertEqual(http.classify_rate_limit(gziplib.decompress(compressed).decode()), "hour")

    def test_user_agent_identifies_the_project(self):
        # An operator seeing us in their logs should be able to find out who we are.
        self.assertIn("riverflow", http.USER_AGENT)
        self.assertIn("github.com", http.USER_AGENT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
