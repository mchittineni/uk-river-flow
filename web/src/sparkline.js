/**
 * Inline SVG sparkline for a station's discharge history.
 *
 * Hand-built rather than pulled from a charting library: the whole chart is one
 * path, a band and two labels. A charting dependency would outweigh the rest of
 * the front end put together, and inline SVG needs no canvas resize dance on a
 * high-DPI screen.
 */

import { h, s } from "./dom.js";
import { STATE_COLOURS } from "./palette.js";

const WIDTH = 300;
const HEIGHT = 84;
const PADDING = { top: 8, right: 4, bottom: 16, left: 4 };

const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
}).format;

/**
 * Render a sparkline as an SVG element.
 *
 * @param {(number|null)[]} values Discharge per time slot; null where the gauge
 *   reported nothing.
 * @param {Date[]} times Matching timestamps, used for the two axis labels.
 * @param {number} highlight Index of the currently selected moment.
 * @param {{p10:number,p25:number,p50:number,p75:number,p95:number}|null} reference
 *   Percentile band drawn behind the line, so "is this high?" is answerable
 *   without reading any numbers.
 */
export function sparkline(values, times, highlight, reference) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) {
    return h("p.spark__empty", { text: "No readings in this window." });
  }

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  // The percentile band is included in the extent: without it, a station sitting
  // far below its own p95 draws a band that runs off the top of the chart.
  const candidates = [...present];
  if (reference) candidates.push(reference.p10, reference.p95);
  const low = Math.min(...candidates);
  const high = Math.max(...candidates);
  const span = high - low || 1;

  const x = (index) => PADDING.left + (index / Math.max(1, values.length - 1)) * plotWidth;
  const y = (value) => PADDING.top + plotHeight - ((value - low) / span) * plotHeight;

  // One subpath per unbroken run, so an outage shows as a visible break rather than
  // a straight line drawn across the missing days.
  const toPath = (runs) =>
    runs
      .map((run) =>
        run
          .map(
            (index, position) =>
              (position === 0 ? "M" : "L") + x(index).toFixed(1) + " " + y(values[index]).toFixed(1),
          )
          .join(" "),
      )
      .join(" ");

  const commands = toPath(runsIn(values));

  const children = [];

  if (reference) {
    children.push(
      s("rect.spark__band", {
        x: PADDING.left,
        y: y(reference.p75).toFixed(1),
        width: plotWidth,
        height: Math.max(1, y(reference.p25) - y(reference.p75)).toFixed(1),
      }),
      s("line.spark__median", {
        x1: PADDING.left,
        x2: PADDING.left + plotWidth,
        y1: y(reference.p50).toFixed(1),
        y2: y(reference.p50).toFixed(1),
      }),
    );
  }

  children.push(
    s("line.spark__cursor", {
      x1: x(highlight).toFixed(1),
      x2: x(highlight).toFixed(1),
      y1: PADDING.top,
      y2: PADDING.top + plotHeight,
    }),
    s("path.spark__line", { d: commands }),
  );

  const selected = values[highlight];
  if (selected !== null && selected !== undefined) {
    children.push(
      s("circle.spark__dot", { cx: x(highlight).toFixed(1), cy: y(selected).toFixed(1), r: 3.5 }),
    );
  }

  const first = shortDate(times[0]);
  const last = shortDate(times[times.length - 1]);

  children.push(
    s("text.spark__tick", { x: PADDING.left, y: HEIGHT - 4, text: first }),
    s("text.spark__tick.spark__tick--end", { x: WIDTH - PADDING.right, y: HEIGHT - 4, text: last }),
  );

  return s(
    "svg.spark",
    {
      viewBox: "0 0 " + WIDTH + " " + HEIGHT,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "Discharge from " + first + " to " + last,
    },
    children,
  );
}

/** Small coloured pill showing a flow state. */
export function statePill(state, label) {
  return h("span.pill", {
    text: label,
    style: { "--pill": STATE_COLOURS[state] ?? STATE_COLOURS.unknown },
  });
}

/**
 * Contiguous runs of present values within `[from, to)`.
 *
 * Extracted as a pure function for two reasons: it is the part of the chart most
 * likely to be wrong in a way nobody notices (a line drawn straight across a
 * three-day gauge outage looks plausible), and it is testable without a DOM,
 * which the SVG builder is not.
 *
 * @param {(number|null|undefined)[]} values
 * @param {number} from Inclusive start index.
 * @param {number} to Exclusive end index.
 * @returns {number[][]} One array of indices per unbroken run.
 */
export function runsIn(values, from = 0, to = values.length) {
  const runs = [];
  let current = null;

  for (let index = Math.max(0, from); index < Math.min(values.length, to); index += 1) {
    const value = values[index];
    if (value === null || value === undefined) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      runs.push(current);
    }
    current.push(index);
  }

  return runs;
}
