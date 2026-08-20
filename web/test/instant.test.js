/**
 * Instant handling for the live layer.
 *
 * The live snapshot's `at` field arrives from a static file the browser did not
 * generate. `new Date(bad).toISOString()` throws a RangeError rather than
 * returning something odd, so an unparseable stamp used to take the entire
 * station detail panel down instead of degrading the one line that needs a time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeInstant, relativeAge } from "../src/data.js";

test("a well-formed instant is described and normalised", () => {
  const described = describeInstant("2026-08-10T09:15:00+00:00");
  assert.equal(described.valid, true);
  assert.equal(described.iso, "2026-08-10T09:15:00.000Z");
  assert.ok(described.date instanceof Date);
});

test("an offset stamp keeps its instant", () => {
  assert.equal(describeInstant("2026-08-10T10:15:00+01:00").iso, "2026-08-10T09:15:00.000Z");
});

test("an unparseable stamp is reported rather than thrown", () => {
  // "None" is what the ingest emitted for a reading with no dateTime, and is the
  // exact value that produced the RangeError.
  // `null` is in this list for a reason: `new Date(null)` is *valid* and means
  // 1 January 1970, so a missing stamp would otherwise render as a real reading.
  for (const bad of ["None", "", "   ", "not a date", null, undefined, {}, 1700000000]) {
    const described = describeInstant(bad);
    assert.equal(described.valid, false, String(bad));
    assert.equal(described.iso, null, String(bad));
    assert.equal(described.date, null, String(bad));
  }
});

test("the caller never has to touch a Date that could throw", () => {
  const { valid, date, iso } = describeInstant("None");
  assert.equal(valid, false);
  // Both branches the panel takes are safe: `datetime` is dropped by the element
  // builder when null, and `relativeAge` is never reached with an invalid date.
  assert.equal(iso, null);
  assert.equal(date, null);
});

test("relativeAge still degrades rather than throwing if handed an invalid date", () => {
  assert.equal(relativeAge(new Date("None")), "unknown age");
});
