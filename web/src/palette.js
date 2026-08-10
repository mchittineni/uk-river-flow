/**
 * Flow-state colours.
 *
 * A separate module from `map.js` on purpose. The palette is *data*, and both the
 * map layers and the sparkline need it — but `map.js` imports MapLibre and its
 * stylesheet, so a sparkline that reached through it dragged a 1 MB WebGL library
 * and a `.css` import into anything that touched a chart. That made the pure
 * rendering logic untestable under plain `node --test`, which is how this file
 * came to exist.
 *
 * Diverging, colour-blind-safe, dry → wet.
 */
export const STATE_COLOURS = {
  "very-low": "#c2410c",
  low: "#eab308",
  normal: "#22d3ee",
  high: "#3b82f6",
  "very-high": "#a855f7",
  unknown: "#64748b",
};

/** MapLibre `match` expression over `properties.state`, built from the palette. */
export const STATE_COLOUR_EXPRESSION = [
  "match",
  ["get", "state"],
  "very-low",
  STATE_COLOURS["very-low"],
  "low",
  STATE_COLOURS.low,
  "normal",
  STATE_COLOURS.normal,
  "high",
  STATE_COLOURS.high,
  "very-high",
  STATE_COLOURS["very-high"],
  STATE_COLOURS.unknown,
];
