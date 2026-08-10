/**
 * The station detail panel and the attribution footer.
 *
 * Kept apart from map.js so the DOM work and the WebGL work stay independently
 * testable, and so a fork wanting a different UI can replace this one file.
 */

import { definition, h, replaceChildren } from "./dom.js";
import { formatDateTime, formatDischarge, flowState, relativeAge, valueAt } from "./data.js";
import { sparkline, statePill } from "./sparkline.js";

const STATE_LABELS = {
  "very-low": "Exceptionally low",
  low: "Below normal",
  normal: "Normal",
  high: "Above normal",
  "very-high": "Exceptionally high",
  unknown: "No reference data",
};

/** Where a value sits in its own record, as a plain-English sentence. */
function contextSentence(value, reference) {
  if (!reference) {
    return "This gauge has too little history in the current window to place the reading in context.";
  }
  if (value <= reference.p10) {
    return (
      "Lower than 90% of the days on record for this gauge (10th percentile is " +
      formatDischarge(reference.p10) +
      ")."
    );
  }
  if (value >= reference.p95) {
    return (
      "Higher than 95% of the days on record for this gauge (95th percentile is " +
      formatDischarge(reference.p95) +
      ")."
    );
  }
  const median = reference.p50;
  const ratio = median > 0 ? value / median : 1;
  if (ratio >= 1.15) return "About " + ratio.toFixed(1) + "x the median for this gauge.";
  if (ratio <= 0.85) return "About " + Math.round(ratio * 100) + "% of the median for this gauge.";
  return "Close to the median for this gauge (" + formatDischarge(median) + ").";
}

export function renderStationDetail(container, { station, bundle, index }) {
  const { series, times } = bundle;
  const column = series.v[station.id] ?? [];
  const reading = valueAt(series, station.id, index);
  const value = reading?.value ?? null;
  const state = value === null ? "unknown" : flowState(value, station.reference);

  const blocks = [
    h("h2.detail__name", { text: station.name }),
    station.river && h("p.detail__river", { text: station.river }),
    h("p.detail__value", { text: formatDischarge(value) }),
    h("p.detail__state", {}, [
      statePill(state, STATE_LABELS[state] ?? state),
      h("time", { datetime: times[index].toISOString(), text: formatDateTime(times[index]) }),
    ]),
  ];

  if (reading && reading.staleBy > 0) {
    blocks.push(
      h("p.detail__warn", {
        text:
          "Carried forward from " +
          reading.staleBy +
          " reading" +
          (reading.staleBy > 1 ? "s" : "") +
          " earlier — this gauge reported nothing for the selected date.",
      }),
    );
  }

  blocks.push(
    sparkline(column, times, index, station.reference ?? null),
    h("p.detail__context", { text: contextSentence(value ?? 0, station.reference) }),
  );

  if (station.quality && station.quality !== "Good") {
    blocks.push(
      h("p.detail__note", {}, [
        "Quality grade: ",
        h("strong", { text: station.quality }),
        ". The Environment Agency marks recent values Unchecked until a hydrologist reviews them.",
      ]),
    );
  }

  if (typeof station.coverage === "number" && station.coverage < 0.9) {
    blocks.push(
      h("p.detail__note", {
        text: "Reported on " + Math.round(station.coverage * 100) + "% of days in this window.",
      }),
    );
  }

  const facts = [
    definition("Coordinates", station.lat.toFixed(4) + ", " + station.lon.toFixed(4)),
    definition("Station id", station.id.length > 18 ? station.id.slice(0, 8) + "…" : station.id),
  ];
  if (station.reference) {
    facts.push(
      definition("Median (window)", formatDischarge(station.reference.p50)),
      definition(
        "Range p10–p95",
        formatDischarge(station.reference.p10) + " – " + formatDischarge(station.reference.p95),
      ),
    );
  }
  blocks.push(h("dl.detail__facts", {}, facts));

  replaceChildren(container, blocks);
}

export function renderLiveDetail(container, station) {
  const observed = new Date(station.at);
  replaceChildren(container, [
    h("h2.detail__name", { text: station.name }),
    station.river && h("p.detail__river", { text: station.river }),
    h("p.detail__value", { text: formatDischarge(station.value) }),
    h("p.detail__state", {}, [
      statePill("normal", "Live · 15-minute"),
      h("time", { datetime: observed.toISOString(), text: relativeAge(observed) }),
    ]),
    h("p.detail__context", {
      text:
        "Real-time reading from the flood-monitoring network. This network uses different station " +
        "identifiers from the daily archive, so it is shown as a separate layer rather than merged.",
    }),
    h("dl.detail__facts", {}, [
      definition("Coordinates", station.lat.toFixed(4) + ", " + station.lon.toFixed(4)),
      definition("Observed", formatDateTime(observed)),
    ]),
  ]);
}

/**
 * Build the attribution footer from meta.json.
 *
 * Generated rather than hardcoded because both source licences (OGL v3 for the
 * Environment Agency data, ODbL for OpenStreetMap geometry) require attribution,
 * and deriving it from the same manifest the pipeline writes means the notice
 * cannot silently drift away from what is actually being served.
 */
export function renderCredits(container, meta) {
  const parts = [h("span", { text: "Updated " + formatDateTime(new Date(meta.generated_at)) })];

  for (const source of meta.sources ?? []) {
    parts.push(
      " · ",
      h("a", { href: source.url, rel: "noopener", text: source.name }),
      h("span", { text: " (" + source.licence + ")" }),
    );
  }

  parts.push(
    " · ",
    h("a", { href: "https://openfreemap.org/", rel: "noopener", text: "Basemap OpenFreeMap" }),
    h("span", { text: " (© OpenStreetMap contributors, ODbL)" }),
  );

  replaceChildren(container, parts);
}

export function renderSubtitle(element, meta) {
  const stations = meta.counts?.stations ?? 0;
  const live = meta.counts?.live ?? 0;
  const parts = [stations.toLocaleString("en-GB") + " gauging stations"];
  if (live) parts.push(live.toLocaleString("en-GB") + " live");
  if (meta.window?.days) parts.push(meta.window.days + "-day window");
  element.textContent = parts.join(" · ");
}

/**
 * Show a fatal load error in place of the map.
 *
 * A blank dark rectangle is the worst failure mode: it looks like a slow network
 * and gives a visitor nothing to act on. This says what broke and what to do.
 */
export function renderFatal(container, error) {
  replaceChildren(container, [
    h("div.notice.notice--error", { role: "alert" }, [
      h("h1", { text: "The map could not load its data" }),
      h("p", { text: error.message }),
      h("p", { text: "If you are running this locally, generate the data bundle first:" }),
      h("pre", {}, [h("code", { text: "python3 pipeline/ingest_uk.py --days 30" })]),
    ]),
  ]);
  container.hidden = false;
}
