/**
 * Loading and indexing the published data bundle.
 *
 * Everything here reads same-origin static JSON written by the ingest pipeline.
 * There is no runtime API call to any upstream service, which is what makes the
 * page fast, keyless, immune to an upstream outage, and free to host.
 */

const BASE = "./data/v1";

/** Files the map cannot render without, versus files that only add a layer. */
const REQUIRED = ["meta.json", "stations.json", "series.json"];
const OPTIONAL = ["network.geojson", "live.json"];

export class DataError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DataError";
  }
}

async function fetchJson(name, { required }) {
  let response;
  try {
    response = await fetch(BASE + "/" + name, { cache: "no-cache" });
  } catch (cause) {
    if (required) throw new DataError("Could not reach " + name + ". Are you offline?", cause);
    return null;
  }

  if (!response.ok) {
    if (required) {
      throw new DataError(
        name +
          " returned HTTP " +
          response.status +
          ". If this is a fresh clone, run the ingest pipeline to generate data/v1.",
      );
    }
    return null;
  }

  try {
    return await response.json();
  } catch (cause) {
    if (required) throw new DataError(name + " is not valid JSON.", cause);
    return null;
  }
}

/**
 * Load the whole bundle in parallel.
 *
 * Required and optional files are requested together rather than in sequence:
 * the optional layers are the two largest files, and waiting for the small ones
 * first would serialise the slowest part of page load for no benefit.
 */
export async function loadBundle() {
  const names = [...REQUIRED, ...OPTIONAL];
  const results = await Promise.all(
    names.map((name) => fetchJson(name, { required: REQUIRED.includes(name) })),
  );

  const [meta, stations, series, network, live] = results;

  if (meta?.contract !== 1) {
    throw new DataError(
      "Unsupported data contract " + (meta?.contract ?? "(missing)") + "; this front end speaks version 1.",
    );
  }
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new DataError("stations.json contained no stations.");
  }
  if (!Array.isArray(series?.t) || series.t.length === 0) {
    throw new DataError("series.json contained no time axis.");
  }

  return {
    meta,
    stations,
    series,
    network: network ?? { type: "FeatureCollection", features: [] },
    live: Array.isArray(live) ? live : [],
    /** Epoch-second axis converted once, since the slider reads it on every frame. */
    times: series.t.map((seconds) => new Date(seconds * 1000)),
  };
}

/**
 * Value for a station at a point on the time axis.
 *
 * Gauges go offline, so a slot can legitimately be null. Rather than render a
 * hole, we walk back up to `maxLookback` slots and mark the result as stale —
 * the UI shows the age so a stale reading is never mistaken for a live one.
 */
export function valueAt(series, stationId, index, maxLookback = 3) {
  const column = series.v[stationId];
  if (!column) return null;

  for (let offset = 0; offset <= maxLookback; offset += 1) {
    const at = index - offset;
    if (at < 0) break;
    const value = column[at];
    if (value !== null && value !== undefined) {
      return { value, staleBy: offset };
    }
  }
  return null;
}

/**
 * Classify a discharge value against a station's own percentile record.
 *
 * Mirrors `series.flow_state` in the pipeline. It is duplicated deliberately: the
 * pipeline stamps the state for the newest reading so the first paint needs no
 * computation, and this recomputes it as the user scrubs back through time.
 * `test/flow-state.test.js` asserts the two agree on the published thresholds.
 */
export function flowState(value, reference) {
  if (!reference) return "unknown";
  if (value <= reference.p10) return "very-low";
  if (value <= reference.p25) return "low";
  if (value >= reference.p95) return "very-high";
  if (value >= reference.p75) return "high";
  return "normal";
}

/**
 * Normalised 0–1 position of a value within a station's own range.
 * Drives marker radius and flow speed, so a big river reads as big.
 */
export function relativeMagnitude(value, reference) {
  if (!reference) return 0.5;
  const low = reference.p10;
  const high = Math.max(reference.p95, low + 1e-6);
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

/** Format discharge with a sensible number of significant figures. */
export function formatDischarge(value) {
  if (value === null || value === undefined) return "no reading";
  if (value >= 100) return Math.round(value) + " m³/s";
  if (value >= 10) return value.toFixed(1) + " m³/s";
  if (value >= 1) return value.toFixed(2) + " m³/s";
  return value.toFixed(3) + " m³/s";
}

// Bound `format` getters rather than call sites, so these are plain functions.
export const formatDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
}).format;

export const formatDateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
}).format;

/** "3 hours ago" — used on live readings, where age is the thing that matters. */
export function relativeAge(date, now = new Date()) {
  const minutes = Math.round((now - date) / 60000);
  if (!Number.isFinite(minutes)) return "unknown age";
  if (minutes < 2) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " h ago";
  return Math.round(hours / 24) + " d ago";
}
