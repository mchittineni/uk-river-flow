/**
 * Radiogroup key arithmetic.
 *
 * Only the index maths is tested here; the rest of the module is
 * `addEventListener` and needs a DOM to say anything about. Wrap-around is the
 * part that gets written wrong — `(current - 1) % count` is negative at index 0,
 * and a negative index silently yields `undefined` rather than throwing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRadioIndex } from "../src/radiogroup.js";

test("forward keys advance and wrap", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 3), 1);
  assert.equal(nextRadioIndex("ArrowDown", 1, 3), 2);
  assert.equal(nextRadioIndex("ArrowRight", 2, 3), 0);
});

test("backward keys retreat and wrap past zero", () => {
  assert.equal(nextRadioIndex("ArrowLeft", 2, 3), 1);
  assert.equal(nextRadioIndex("ArrowUp", 1, 3), 0);
  // The one that returns -1 if the count is not added before the modulo.
  assert.equal(nextRadioIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextRadioIndex("ArrowUp", 0, 2), 1);
});

test("Home and End jump to the ends", () => {
  assert.equal(nextRadioIndex("Home", 2, 3), 0);
  assert.equal(nextRadioIndex("End", 0, 3), 2);
});

test("keys the group does not own are passed through", () => {
  // Returning null rather than a number is what lets the handler decline to
  // preventDefault, so Tab, Escape and typing still reach the page.
  assert.equal(nextRadioIndex("Tab", 0, 3), null);
  assert.equal(nextRadioIndex("Escape", 0, 3), null);
  assert.equal(nextRadioIndex("a", 0, 3), null);
});

test("an empty group never produces an index", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 0), null);
  assert.equal(nextRadioIndex("Home", 0, 0), null);
});

test("a single-option group stays put", () => {
  assert.equal(nextRadioIndex("ArrowRight", 0, 1), 0);
  assert.equal(nextRadioIndex("ArrowLeft", 0, 1), 0);
});
