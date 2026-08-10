/**
 * Tests for the pure logic in `src/data.js`.
 *
 * The important one is the parity check. `flowState` is implemented twice — in
 * Python (`pipeline/riverflow/series.py:flow_state`) so the newest reading's colour
 * is precomputed and needs no work on first paint, and in JavaScript so scrubbing
 * back through time can recolour without a round trip.
 *
 * Duplicated logic drifts. These are the exact same cases asserted in
 * `pipeline/tests/test_pipeline.py::test_flow_state_matches_the_front_end_thresholds`,
 * so if someone changes a boundary on one side, one of the two suites fails.
 *
 * Run: `npm test` (node:test, no test framework dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { flowState, formatDischarge, relativeAge, relativeMagnitude, valueAt } from "../src/data.js";
import { runsIn } from "../src/sparkline.js";

const REFERENCE = { p10: 10, p25: 25, p50: 50, p75: 75, p95: 95 };

test("flowState: tail boundaries are inclusive", () => {
  assert.equal(flowState(5, REFERENCE), "very-low");
  assert.equal(flowState(10, REFERENCE), "very-low", "p10 itself counts as very-low");
  assert.equal(flowState(20, REFERENCE), "low");
  assert.equal(flowState(25, REFERENCE), "low", "p25 itself counts as low");
  assert.equal(flowState(50, REFERENCE), "normal");
  assert.equal(flowState(75, REFERENCE), "high", "p75 itself counts as high");
  assert.equal(flowState(95, REFERENCE), "very-high", "p95 itself counts as very-high");
  assert.equal(flowState(1000, REFERENCE), "very-high");
});

test("flowState: matches the Python implementation on the shared fixture", () => {
  // Mirrors test_flow_state_matches_the_front_end_thresholds exactly.
  const reference = { p10: 1, p25: 2, p50: 3, p75: 4, p95: 5 };
  const expected = [
    [0.5, "very-low"],
    [1.5, "low"],
    [3.0, "normal"],
    [4.5, "high"],
    [6.0, "very-high"],
  ];
  for (const [value, state] of expected) {
    assert.equal(flowState(value, reference), state, `value=${value}`);
  }
});

test("flowState: no reference means unknown, not a guess", () => {
  assert.equal(flowState(42, null), "unknown");
  assert.equal(flowState(42, undefined), "unknown");
});

test("relativeMagnitude: clamps to 0..1 and centres without a reference", () => {
  assert.equal(relativeMagnitude(10, REFERENCE), 0);
  assert.equal(relativeMagnitude(95, REFERENCE), 1);
  assert.equal(relativeMagnitude(-5, REFERENCE), 0, "below p10 clamps rather than going negative");
  assert.equal(relativeMagnitude(500, REFERENCE), 1);
  assert.equal(relativeMagnitude(52.5, REFERENCE), 0.5);
  assert.equal(relativeMagnitude(1, null), 0.5, "unknown magnitude renders mid-scale");
});

test("relativeMagnitude: survives a degenerate reference without dividing by zero", () => {
  const flat = { p10: 7, p25: 7, p50: 7, p75: 7, p95: 7 };
  const result = relativeMagnitude(7, flat);
  assert.ok(Number.isFinite(result), `expected a finite number, got ${result}`);
  assert.ok(result >= 0 && result <= 1);
});

test("valueAt: walks back over gaps and reports how stale the value is", () => {
  const series = { t: [1, 2, 3, 4, 5], v: { s1: [5, null, null, null, null] } };

  assert.deepEqual(valueAt(series, "s1", 0), { value: 5, staleBy: 0 });
  assert.deepEqual(valueAt(series, "s1", 2), { value: 5, staleBy: 2 });
  // The default lookback is 3 slots, so index 3 is still reachable...
  assert.deepEqual(valueAt(series, "s1", 3), { value: 5, staleBy: 3 });
  // ...and index 4 is one slot too far, which must read as no data rather than as
  // an ever-older value carried forward indefinitely.
  assert.equal(valueAt(series, "s1", 4), null, "beyond the lookback window, report nothing");
});

test("valueAt: respects an explicit lookback and unknown stations", () => {
  const series = { t: [1, 2, 3], v: { s1: [9, null, null] } };
  assert.equal(valueAt(series, "s1", 2, 1), null);
  assert.deepEqual(valueAt(series, "s1", 2, 2), { value: 9, staleBy: 2 });
  assert.equal(valueAt(series, "nope", 0), null);
});

test("valueAt: treats a genuine zero as a reading, not a gap", () => {
  // Regression guard: a truthiness check here would skip real zero-flow readings on
  // a dry channel and silently carry a stale value forward instead.
  const series = { t: [1, 2], v: { s1: [4, 0] } };
  assert.deepEqual(valueAt(series, "s1", 1), { value: 0, staleBy: 0 });
});

test("formatDischarge: significant figures scale with magnitude", () => {
  assert.equal(formatDischarge(1234.5), "1235 m³/s");
  assert.equal(formatDischarge(42.34), "42.3 m³/s");
  assert.equal(formatDischarge(4.238), "4.24 m³/s");
  assert.equal(formatDischarge(0.0421), "0.042 m³/s");
  assert.equal(formatDischarge(null), "no reading");
  assert.equal(formatDischarge(undefined), "no reading");
});

test("relativeAge: reads as a human would say it", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  assert.equal(relativeAge(new Date("2026-08-10T11:59:30Z"), now), "just now");
  assert.equal(relativeAge(new Date("2026-08-10T11:15:00Z"), now), "45 min ago");
  assert.equal(relativeAge(new Date("2026-08-10T06:00:00Z"), now), "6 h ago");
  assert.equal(relativeAge(new Date("2026-08-07T12:00:00Z"), now), "3 d ago");
});

test("runsIn: an outage breaks the line instead of being drawn across", () => {
  // The failure this guards against is silent: a straight line across three missing
  // days looks like real data, so a gap must produce two subpaths, not one.
  assert.deepEqual(runsIn([1, 2, null, 4, 5]), [
    [0, 1],
    [3, 4],
  ]);
  assert.deepEqual(runsIn([null, null]), []);
  assert.deepEqual(runsIn([1, 2, 3]), [[0, 1, 2]]);
});

test("runsIn: a genuine zero is a value, not a gap", () => {
  // A truthiness check here would treat a dry channel as missing data.
  assert.deepEqual(runsIn([0, 0, 1]), [[0, 1, 2]]);
});

test("runsIn: honours an index window and clamps out-of-range bounds", () => {
  const values = [1, 2, 3, 4, 5];
  assert.deepEqual(runsIn(values, 1, 3), [[1, 2]]);
  assert.deepEqual(runsIn(values, -5, 99), [[0, 1, 2, 3, 4]]);
  assert.deepEqual(runsIn(values, 3, 3), []);
});
