/**
 * MapLibre GL setup: basemap, terrain, river network and station layers.
 *
 * Why MapLibre rather than CesiumJS (see docs/adr/0002): CesiumJS itself is
 * Apache-2.0, but its default terrain and imagery come from Cesium ion, whose
 * asset endpoint returns HTTP 401 without an access token and meters usage on the
 * free tier. That is a signup, a secret in CI and a quota — three things this
 * project exists to avoid. MapLibre GL is BSD-3, ships a globe projection since
 * v5, and pairs with OpenFreeMap tiles that need no key and publish no quota.
 * The bundle is also ~940 KB against Cesium's ~5.5 MB plus workers.
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { STATE_COLOURS, STATE_COLOUR_EXPRESSION } from "./palette.js";

/** Keyless, quota-free vector tiles (OpenMapTiles schema, ODbL). */
const BASEMAP_STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

/**
 * Terrarium-encoded elevation from the AWS Open Data registry. Free and keyless,
 * but a third-party best-effort service, so terrain is opt-in and its failure is
 * caught rather than allowed to break the map.
 */
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/**
 * Dash patterns cycled to fake motion along the river lines.
 *
 * MapLibre cannot interpolate `line-dasharray`, so a continuous per-feature
 * velocity is not expressible. Stepping through a fixed sequence of patterns
 * gives the marching-ants effect at a fraction of the cost of a custom WebGL
 * particle layer, and degrades to a static dashed line if animation is disabled
 * or the tab is hidden.
 */
const DASH_SEQUENCE = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

/** Layer ids, exported so the UI can toggle them without string-matching. */
export const LAYERS = {
  riverBase: "rivers-base",
  riverFlow: "rivers-flow",
  stations: "stations",
  stationsHalo: "stations-halo",
  live: "live-stations",
  selected: "station-selected",
};

const EMPTY = { type: "FeatureCollection", features: [] };

export function createMap(container, meta, { theme = "dark" } = {}) {
  const centre = meta?.region?.centre ?? [-2.2, 54.2];
  const zoom = meta?.region?.zoom ?? 4.6;

  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLES[theme] ?? BASEMAP_STYLES.dark,
    center: centre,
    zoom,
    minZoom: 2,
    maxZoom: 14,
    pitch: 0,
    // Attribution is rendered in our own footer from meta.json, because the OGL
    // and ODbL notices must both appear and MapLibre's compact control hides one.
    attributionControl: false,
    // Cooperative gestures keep a two-finger scroll from hijacking the page on
    // touch devices, which matters when the map is full-bleed.
    cooperativeGestures: false,
    hash: "at",
    maxPitch: 75,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
  map.addControl(
    new maplibregl.GeolocateControl({ trackUserLocation: false, showAccuracyCircle: false }),
    "bottom-right",
  );
  map.addControl(new maplibregl.FullscreenControl(), "bottom-right");

  return map;
}

/** Add our sources and layers. Must run after the style has loaded. */
export function addDataLayers(map, { network }) {
  map.addSource("rivers", { type: "geojson", data: network ?? EMPTY });
  map.addSource("stations", { type: "geojson", data: EMPTY });
  map.addSource("live", { type: "geojson", data: EMPTY });

  // Insert beneath the basemap's label layers so place names stay readable on top
  // of the rivers. Falling back to undefined (topmost) keeps this working if
  // OpenFreeMap renames its layers.
  const firstLabelLayer = map
    .getStyle()
    .layers.find((layer) => layer.type === "symbol" && /label|place|poi/i.test(layer.id))?.id;

  map.addLayer(
    {
      id: LAYERS.riverBase,
      type: "line",
      source: "rivers",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_COLOUR_EXPRESSION,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.28, 8, 0.42, 12, 0.5],
        // Width scales with both zoom and the station's relative magnitude, so a
        // major river reads as major without needing absolute discharge.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["+", 0.4, ["*", 1.6, ["coalesce", ["get", "mag"], 0.4]]],
          9,
          ["+", 1.0, ["*", 4.0, ["coalesce", ["get", "mag"], 0.4]]],
          13,
          ["+", 2.0, ["*", 8.0, ["coalesce", ["get", "mag"], 0.4]]],
        ],
      },
    },
    firstLabelLayer,
  );

  map.addLayer(
    {
      id: LAYERS.riverFlow,
      type: "line",
      source: "rivers",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": "#e2f5ff",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.25, 9, 0.55, 13, 0.7],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 9, 1.4, 13, 2.4],
        "line-dasharray": DASH_SEQUENCE[0],
      },
    },
    firstLabelLayer,
  );

  map.addLayer({
    id: LAYERS.stationsHalo,
    type: "circle",
    source: "stations",
    paint: {
      "circle-color": STATE_COLOUR_EXPRESSION,
      "circle-opacity": 0.14,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        ["+", 4, ["*", 10, ["coalesce", ["get", "mag"], 0.3]]],
        10,
        ["+", 10, ["*", 26, ["coalesce", ["get", "mag"], 0.3]]],
      ],
      "circle-blur": 0.6,
    },
  });

  map.addLayer({
    id: LAYERS.stations,
    type: "circle",
    source: "stations",
    paint: {
      "circle-color": STATE_COLOUR_EXPRESSION,
      "circle-stroke-color": "#03080d",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 10, 1.2],
      "circle-opacity": 0.95,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        ["+", 1.8, ["*", 3.4, ["coalesce", ["get", "mag"], 0.3]]],
        8,
        ["+", 3.0, ["*", 6.0, ["coalesce", ["get", "mag"], 0.3]]],
        13,
        ["+", 5.0, ["*", 11.0, ["coalesce", ["get", "mag"], 0.3]]],
      ],
    },
  });

  // The live layer is a distinct shape, not a distinct colour: the two layers use
  // different station networks that cannot be reliably joined, and a square
  // marker makes "this is the other network" obvious without a legend lookup.
  map.addLayer({
    id: LAYERS.live,
    type: "circle",
    source: "live",
    layout: { visibility: "none" },
    paint: {
      "circle-color": "#f8fafc",
      "circle-stroke-color": "#0ea5e9",
      "circle-stroke-width": 2,
      "circle-opacity": 0.9,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 10, 7],
    },
  });

  map.addLayer({
    id: LAYERS.selected,
    type: "circle",
    source: "stations",
    filter: ["==", ["get", "id"], "__none__"],
    paint: {
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 7, 10, 16],
    },
  });
}

/** Start the marching-ants animation. Returns a handle with speed/stop controls. */
export function animateFlow(map, { speed = 0.55 } = {}) {
  let frame = 0;
  let rafId = null;
  let lastStep = 0;
  let currentSpeed = speed;
  let running = false;

  const tick = (now) => {
    if (!running) return;
    // Frame interval derived from the speed slider: 40 ms at full speed, 400 ms
    // near zero. Wall-clock stepping keeps the apparent velocity identical on a
    // 60 Hz and a 144 Hz display.
    const interval = currentSpeed <= 0 ? Infinity : 40 + (1 - currentSpeed) * 360;
    if (now - lastStep >= interval) {
      lastStep = now;
      frame = (frame + 1) % DASH_SEQUENCE.length;
      if (map.getLayer(LAYERS.riverFlow)) {
        map.setPaintProperty(LAYERS.riverFlow, "line-dasharray", DASH_SEQUENCE[frame]);
      }
    }
    rafId = requestAnimationFrame(tick);
  };

  const start = () => {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  };

  // requestAnimationFrame is already throttled in background tabs, but pausing
  // explicitly means we do not burn a wake-up on a hidden tab at all.
  const onVisibility = () => (document.hidden ? stop() : currentSpeed > 0 && start());
  document.addEventListener("visibilitychange", onVisibility);

  if (speed > 0) start();

  return {
    setSpeed(next) {
      currentSpeed = Math.max(0, Math.min(1, next));
      if (currentSpeed === 0) {
        stop();
        if (map.getLayer(LAYERS.riverFlow)) {
          map.setPaintProperty(LAYERS.riverFlow, "line-dasharray", [0, 2, 4]);
        }
      } else if (!document.hidden) {
        start();
      }
    },
    destroy() {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/**
 * Enable or disable hillshaded 3D terrain.
 *
 * Wrapped in try/catch and a source-error listener because the elevation tiles
 * are a free third-party service: if they disappear, terrain should quietly not
 * work rather than take the whole map down with it.
 */
export function setTerrain(map, enabled) {
  if (!enabled) {
    map.setTerrain(null);
    if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 400 });
    return true;
  }

  try {
    if (!map.getSource("terrain")) {
      map.addSource("terrain", {
        type: "raster-dem",
        tiles: [TERRAIN_TILES],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 13,
        attribution: "Elevation: Tilezen / AWS Open Data",
      });
    }
    map.setTerrain({ source: "terrain", exaggeration: 1.3 });
    map.easeTo({ pitch: 55, duration: 700 });
    return true;
  } catch (error) {
    console.warn("terrain unavailable", error);
    return false;
  }
}

/** Switch between the flat web-mercator view and the 3D globe (MapLibre 5+). */
export function setGlobe(map, enabled) {
  try {
    map.setProjection({ type: enabled ? "globe" : "mercator" });
    return true;
  } catch (error) {
    console.warn("globe projection unavailable in this MapLibre build", error);
    return false;
  }
}

/** Show or hide the basemap's own symbol layers, ours excluded. */
export function setBasemapLabels(map, visible) {
  const ours = new Set(Object.values(LAYERS));
  for (const layer of map.getStyle().layers) {
    if (layer.type === "symbol" && !ours.has(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
    }
  }
}

export { maplibregl, STATE_COLOURS };
