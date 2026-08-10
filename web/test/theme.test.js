/**
 * Theme preference tests.
 *
 * The interesting cases are the hostile ones. `localStorage` is not simply absent
 * in a private window or a partitioned iframe — touching it *throws* — and this
 * module runs on the boot path, so an unhandled throw is a blank page rather than
 * a forgotten preference. Those two tests are the reason the file exists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { THEME_MODES, getThemeModePreference, persistThemeMode, resolveThemeName } from "../src/theme.js";

/** Storage that throws on every access, like Safari's private mode. */
const hostileStorage = {
  getItem() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
  setItem() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
};

/** Storage that accepts writes but has no room, like a full quota. */
const fullStorage = {
  getItem: () => null,
  setItem() {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  },
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    read: (key) => map.get(key),
  };
}

test("resolveThemeName: an explicit mode ignores the OS preference", () => {
  assert.equal(resolveThemeName("dark", false), "dark");
  assert.equal(resolveThemeName("dark", true), "dark");
  assert.equal(resolveThemeName("light", true), "light");
  assert.equal(resolveThemeName("light", false), "light");
});

test("resolveThemeName: system follows the OS preference", () => {
  assert.equal(resolveThemeName("system", true), "dark");
  assert.equal(resolveThemeName("system", false), "light");
});

test("resolveThemeName: an unknown mode is treated as system, not as dark", () => {
  // A stale value from an older build must still track the OS rather than pin
  // the visitor to whichever branch happened to be written first.
  assert.equal(resolveThemeName(undefined, true), "dark");
  assert.equal(resolveThemeName("sepia", false), "light");
});

test("getThemeModePreference: reads a stored mode", () => {
  for (const mode of THEME_MODES) {
    const storage = memoryStorage({ "river-flow-theme": mode });
    assert.equal(getThemeModePreference(storage), mode);
  }
});

test("getThemeModePreference: rejects a value that is not a mode", () => {
  const storage = memoryStorage({ "river-flow-theme": "<script>" });
  assert.equal(getThemeModePreference(storage), "system");
  assert.equal(getThemeModePreference(storage, "dark"), "dark");
});

test("getThemeModePreference: absent, missing and throwing storage all fall back", () => {
  assert.equal(getThemeModePreference(memoryStorage()), "system");
  assert.equal(getThemeModePreference(undefined), "system");
  assert.equal(getThemeModePreference(null, "dark"), "dark");
  // The one that would otherwise take the whole page down.
  assert.equal(getThemeModePreference(hostileStorage, "light"), "light");
});

test("persistThemeMode: stores a valid mode and reports success", () => {
  const storage = memoryStorage();
  assert.equal(persistThemeMode("light", storage), true);
  assert.equal(storage.read("river-flow-theme"), "light");
});

test("persistThemeMode: refuses a mode the UI cannot express", () => {
  const storage = memoryStorage();
  assert.equal(persistThemeMode("sepia", storage), false);
  assert.equal(storage.read("river-flow-theme"), undefined);
});

test("persistThemeMode: a storage failure is reported, never thrown", () => {
  assert.doesNotThrow(() => persistThemeMode("dark", hostileStorage));
  assert.equal(persistThemeMode("dark", hostileStorage), false);
  assert.equal(persistThemeMode("dark", fullStorage), false);
  // Absent storage is a failed write, not a silent success.
  assert.equal(persistThemeMode("dark", undefined), false);
});
