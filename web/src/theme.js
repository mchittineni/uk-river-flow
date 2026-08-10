/**
 * Theme preference: the tri-state the UI exposes, and its persistence.
 *
 * "System" is a mode in its own right rather than a starting value, because the
 * three states are not interchangeable: `dark` and `light` are answers, `system`
 * is a standing instruction to keep following the OS. Collapsing it to whichever
 * theme happened to be active at first paint would silently opt the visitor out
 * of their own day/night switch.
 *
 * Every storage access is wrapped. `localStorage` is not merely unavailable in
 * some contexts, it *throws* on access — Safari's private mode, a third-party
 * iframe with storage partitioned off, or a browser configured to block site
 * data. This module is on the boot path, so an unhandled throw here is a blank
 * page rather than a forgotten preference.
 */

export const THEME_MODES = ["dark", "system", "light"];

const STORAGE_KEY = "river-flow-theme";

/** Resolve a mode plus the OS preference into the theme actually rendered. */
export function resolveThemeName(mode, prefersDark = false) {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/** Read the stored mode, falling back whenever storage is missing or unreadable. */
export function getThemeModePreference(storage, fallback = "system") {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return THEME_MODES.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist the mode. Returns whether it stuck, so a caller can tell "saved" from
 * "worked for this session only" — losing the preference is not worth an error.
 */
export function persistThemeMode(mode, storage) {
  // No storage is a failure to persist, not a success: reporting true here would
  // tell the caller the preference will survive a reload when it will not.
  if (!THEME_MODES.includes(mode) || !storage) return false;
  try {
    storage.setItem(STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}
