/**
 * Application wiring: load the bundle, build the map, bind the controls.
 *
 * State is deliberately a plain object mutated by named handlers rather than a
 * framework. There are six pieces of interactive state and one render path, and a
 * reactive layer would cost more bytes than the entire rest of the front end.
 */

import "./style.css";

import { DataError, flowState, formatDate, loadBundle, relativeMagnitude, valueAt } from "./data.js";
import { applyNetworkState, joinNetworkToStations } from "./join.js";
import {
  LAYERS,
  addDataLayers,
  animateFlow,
  createMap,
  maplibregl,
  setBasemapLabels,
  setGlobe,
  setMapTheme,
  setTerrain,
} from "./map.js";
import {
  renderCredits,
  renderFatal,
  renderLiveDetail,
  renderStationDetail,
  renderSubtitle,
} from "./panel.js";
import { bindRadioGroup, setRadioGroupSelection } from "./radiogroup.js";
import { getThemeModePreference, persistThemeMode, resolveThemeName } from "./theme.js";

/** Milliseconds per frame when playing the time animation. */
const PLAY_INTERVAL = 550;

/** Keeps the browser chrome (address bar, task switcher) in step with the page. */
const THEME_COLOURS = { dark: "#0a1119", light: "#eef4f8" };

const element = (id) => document.getElementById(id);

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

const state = {
  bundle: null,
  index: 0,
  layer: "archive",
  minFlowPercentile: 0,
  playing: false,
  playTimer: null,
  selectedId: null,
  flow: null,
  themeMode: "system",
  /** The theme `themeMode` currently resolves to, so a no-op swap can be skipped. */
  resolvedTheme: null,
  stationsVisible: true,
  riversVisible: true,
  terrainEnabled: false,
  globeEnabled: false,
  labelsVisible: true,
  /** Station lookup by id, so click handling is O(1) rather than a scan. */
  byId: new Map(),
  /** Sorted latest values, used to turn the filter slider into a percentile. */
  sortedLatest: [],
};

/**
 * Apply a theme mode: repaint the chrome, then swap the basemap if the theme it
 * resolves to actually changed.
 *
 * `persist` defaults to off so the boot-time call does not write back a
 * preference the visitor never expressed — the difference matters, because a
 * stored "system" and an absent key mean the same thing today but only the
 * absent key stays neutral if the default ever changes.
 */
function applyTheme(map, mode = state.themeMode, { persist = false } = {}) {
  state.themeMode = mode;
  if (persist) persistThemeMode(mode, window.localStorage);

  const resolved = resolveThemeName(mode, darkMedia.matches);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;

  const themeColour = document.querySelector('meta[name="theme-color"]');
  if (themeColour) themeColour.setAttribute("content", THEME_COLOURS[resolved]);

  setRadioGroupSelection(element("theme-select"), (radio) => radio.dataset.themeMode === mode);

  // Only the *resolved* theme drives the basemap, so moving between "system" and
  // the explicit mode it already matches is a no-op. Worth checking: a style swap
  // refetches the entire basemap style, its glyphs and its sprites.
  const changed = resolved !== state.resolvedTheme;
  state.resolvedTheme = resolved;
  if (!map || !changed) return;

  setMapTheme(map, resolved, {
    network: state.bundle?.network,
    preserveView: true,
    onReady: () => {
      addDataLayers(map, { network: state.bundle?.network });
      // `addDataLayers` recreates the live source empty, because the style swap
      // took the old one with it. Without this the Live layer comes back blank.
      map.getSource("live").setData(liveFeatures(state.bundle.live));
      setRiverVisibility(map, state.riversVisible);
      setStationVisibility(map, state.stationsVisible);
      setTerrain(map, state.terrainEnabled);
      setGlobe(map, state.globeEnabled);
      setBasemapLabels(map, state.labelsVisible);
      // Reflect the layer choice without running the *user action*, which would
      // dismiss the detail panel: changing theme is not deselecting a station.
      applyLayerSelection(map);
      render(map);
    },
  });
}

function setRiverVisibility(map, visible) {
  state.riversVisible = visible;
  const visibility = visible ? "visible" : "none";
  for (const id of [LAYERS.riverBase, LAYERS.riverFlow]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }
}

function setStationVisibility(map, visible) {
  state.stationsVisible = visible;
  const visibility = visible ? "visible" : "none";
  for (const id of [LAYERS.stations, LAYERS.stationsHalo, LAYERS.selected]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }
  if (map.getLayer(LAYERS.live)) {
    map.setLayoutProperty(LAYERS.live, "visibility", visible && state.layer === "live" ? "visible" : "none");
  }
}

async function boot() {
  const boot = element("boot");

  let bundle;
  try {
    bundle = await loadBundle();
  } catch (error) {
    boot.hidden = true;
    renderFatal(element("map"), error instanceof DataError ? error : new DataError(String(error)));
    return;
  }

  state.bundle = bundle;
  state.index = bundle.times.length - 1;
  state.themeMode = getThemeModePreference(window.localStorage, "system");
  for (const station of bundle.stations) state.byId.set(station.id, station);
  state.sortedLatest = bundle.stations
    .map((station) => station.value)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);

  renderSubtitle(element("masthead-subtitle"), bundle.meta);
  renderCredits(element("credits-body"), bundle.meta);

  // Paint the chrome before the map exists, so the shell is already the right
  // theme on first frame rather than flashing dark and correcting itself.
  applyTheme(null, state.themeMode);
  const map = createMap("map", bundle.meta, { theme: state.resolvedTheme });

  darkMedia.addEventListener?.("change", () => {
    if (state.themeMode === "system") applyTheme(map, "system");
  });

  map.on("load", () => {
    addDataLayers(map, { network: bundle.network });

    const joined = joinNetworkToStations(bundle.network, bundle.stations);
    console.info(
      "joined " + joined.joined + " of " + joined.total + " river segments to a gauge within 30 km",
    );

    map.getSource("live").setData(liveFeatures(bundle.live));

    state.flow = animateFlow(map, { speed: 0.55 });

    bindControls(map);
    bindInteractions(map);
    render(map);

    boot.hidden = true;
  });

  map.on("error", (event) => {
    // Tile 404s from a free basemap are noise; a style or source failure is not.
    if (event?.error?.status === 404) return;
    console.warn("map error", event?.error ?? event);
  });
}

/** Build the station GeoJSON for the currently selected moment. */
function stationFeatures(bundle, index, minValue) {
  const features = [];
  const states = new Map();

  for (const station of bundle.stations) {
    const reading = valueAt(bundle.series, station.id, index);
    if (!reading) continue;

    const magnitude = relativeMagnitude(reading.value, station.reference);
    const current = flowState(reading.value, station.reference);
    states.set(station.id, { state: current, mag: magnitude });

    if (reading.value < minValue) continue;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
      properties: {
        id: station.id,
        state: current,
        mag: magnitude,
        value: reading.value,
      },
    });
  }

  return { collection: { type: "FeatureCollection", features }, states };
}

function liveFeatures(live) {
  return {
    type: "FeatureCollection",
    features: live.map((station) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
      properties: { id: station.id, value: station.value },
    })),
  };
}

/** Recompute and push everything that depends on the selected moment. */
function render(map) {
  const { bundle, index } = state;

  // The filter slider is a percentile of the current distribution, not an
  // absolute value: absolute thresholds are meaningless across a network
  // spanning four orders of magnitude of discharge.
  const cut = state.minFlowPercentile;
  const minValue =
    cut <= 0
      ? -Infinity
      : (state.sortedLatest[
          Math.min(state.sortedLatest.length - 1, Math.floor((cut / 100) * state.sortedLatest.length))
        ] ?? -Infinity);

  const { collection, states } = stationFeatures(bundle, index, minValue);
  map.getSource("stations").setData(collection);
  map.getSource("rivers").setData(applyNetworkState(bundle.network, states));

  element("time-readout").textContent = formatDate(bundle.times[index]);
  element("min-flow-readout").textContent =
    cut <= 0 ? "all" : "top " + (100 - cut) + "% (" + collection.features.length + " shown)";

  if (state.selectedId) {
    map.setFilter(LAYERS.selected, ["==", ["get", "id"], state.selectedId]);
    const station = state.byId.get(state.selectedId);
    if (station) renderStationDetail(element("detail-body"), { station, bundle, index });
  }
}

function bindControls(map) {
  const { bundle } = state;

  state.riversVisible = element("toggle-rivers").checked;
  state.terrainEnabled = element("toggle-terrain").checked;
  state.globeEnabled = element("toggle-globe").checked;
  state.labelsVisible = element("toggle-labels").checked;
  state.stationsVisible = element("toggle-stations").checked;

  const slider = element("time");
  slider.max = String(bundle.times.length - 1);
  slider.value = String(state.index);
  slider.addEventListener("input", () => {
    stopPlaying();
    state.index = Number(slider.value);
    render(map);
  });

  element("now").addEventListener("click", () => {
    stopPlaying();
    state.index = bundle.times.length - 1;
    slider.value = String(state.index);
    render(map);
  });

  element("play").addEventListener("click", () => (state.playing ? stopPlaying() : startPlaying(map)));

  const speed = element("flow-speed");
  speed.addEventListener("input", () => {
    const fraction = Number(speed.value) / 100;
    state.flow?.setSpeed(fraction);
    element("speed-readout").textContent = fraction === 0 ? "off" : Math.round(fraction * 100) + "%";
  });

  const minFlow = element("min-flow");
  minFlow.addEventListener("input", () => {
    state.minFlowPercentile = Number(minFlow.value);
    render(map);
  });

  bindRadioGroup(element("layer-select"), (radio) => selectLayer(map, radio.dataset.layer));
  bindRadioGroup(element("theme-select"), (radio) =>
    applyTheme(map, radio.dataset.themeMode, { persist: true }),
  );

  element("toggle-stations").addEventListener("change", (event) => {
    const visible = event.target.checked;
    if (!visible) clearSelection(map);
    setStationVisibility(map, visible);
  });

  element("toggle-rivers").addEventListener("change", (event) => {
    setRiverVisibility(map, event.target.checked);
  });

  element("toggle-terrain").addEventListener("change", (event) => {
    state.terrainEnabled = event.target.checked;
    const ok = setTerrain(map, event.target.checked);
    if (!ok) event.target.checked = false;
  });

  element("toggle-globe").addEventListener("change", (event) => {
    state.globeEnabled = event.target.checked;
    const ok = setGlobe(map, event.target.checked);
    if (!ok) event.target.checked = false;
  });

  element("toggle-labels").addEventListener("change", (event) => {
    state.labelsVisible = event.target.checked;
    setBasemapLabels(map, event.target.checked);
  });

  element("detail-close").addEventListener("click", () => clearSelection(map));

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;

    // Space and the arrows belong to whichever control has focus: Space activates
    // a button, the arrows move within a segmented control. Claiming them
    // globally means Space on "Latest" starts playback and never presses the
    // button. Escape stays global — dismissing the panel should always work.
    const onControl = typeof event.target?.closest === "function" && event.target.closest("button");
    if (onControl && event.key !== "Escape") return;

    if (event.key === " ") {
      event.preventDefault();
      state.playing ? stopPlaying() : startPlaying(map);
    } else if (event.key === "Escape") {
      clearSelection(map);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // Only intercept when the slider is not focused, or we double-step.
      if (document.activeElement === slider) return;
      event.preventDefault();
      stopPlaying();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      state.index = Math.max(0, Math.min(bundle.times.length - 1, state.index + delta));
      slider.value = String(state.index);
      render(map);
    }
  });
}

/** User picked a layer: apply it, and drop a selection that belongs to the old one. */
function selectLayer(map, layer) {
  if (state.layer === layer) return;
  state.layer = layer;
  applyLayerSelection(map);
  clearSelection(map);
}

/**
 * Push `state.layer` into the DOM and the map.
 *
 * Separate from `selectLayer` because it also runs after a basemap swap, where
 * clearing the visitor's selected station would be a side effect of changing
 * theme rather than anything they asked for.
 */
function applyLayerSelection(map) {
  const archive = state.layer === "archive";

  setRadioGroupSelection(element("layer-select"), (radio) => radio.dataset.layer === state.layer);
  setStationVisibility(map, state.stationsVisible);

  // The time controls describe the daily archive only; the live layer is a single
  // snapshot, so leaving an active slider on screen would imply history it lacks.
  element("time-group").hidden = !archive;
  if (!archive) stopPlaying();
}

function startPlaying(map) {
  const { bundle } = state;
  const slider = element("time");
  state.playing = true;
  element("play").setAttribute("aria-pressed", "true");
  element("play").querySelector(".btn__icon").textContent = "❚❚";

  state.playTimer = setInterval(() => {
    state.index = (state.index + 1) % bundle.times.length;
    slider.value = String(state.index);
    render(map);
  }, PLAY_INTERVAL);
}

function stopPlaying() {
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  state.playing = false;
  const play = element("play");
  play.setAttribute("aria-pressed", "false");
  play.querySelector(".btn__icon").textContent = "▶";
}

function clearSelection(map) {
  state.selectedId = null;
  map.setFilter(LAYERS.selected, ["==", ["get", "id"], "__none__"]);
  element("detail").hidden = true;
}

function bindInteractions(map) {
  const hitLayers = [LAYERS.stations, LAYERS.live];

  for (const layer of hitLayers) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }

  map.on("click", LAYERS.stations, (event) => {
    const id = event.features?.[0]?.properties?.id;
    const station = id && state.byId.get(id);
    if (!station) return;
    state.selectedId = id;
    map.setFilter(LAYERS.selected, ["==", ["get", "id"], id]);
    renderStationDetail(element("detail-body"), { station, bundle: state.bundle, index: state.index });
    element("detail").hidden = false;
  });

  map.on("click", LAYERS.live, (event) => {
    const id = event.features?.[0]?.properties?.id;
    const station = state.bundle.live.find((candidate) => candidate.id === id);
    if (!station) return;
    renderLiveDetail(element("detail-body"), station);
    element("detail").hidden = false;
  });

  // A click on empty map dismisses the panel. Queried against the hit layers so a
  // click that lands on a marker is not also treated as a background click.
  map.on("click", (event) => {
    const hits = map.queryRenderedFeatures(event.point, { layers: hitLayers.filter((l) => map.getLayer(l)) });
    if (hits.length === 0) clearSelection(map);
  });

  // River name on hover: cheap, and it answers "which river is that?" without
  // requiring a click or an always-on label layer.
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "river-popup" });
  map.on("mousemove", LAYERS.riverBase, (event) => {
    const name = event.features?.[0]?.properties?.name;
    if (!name) {
      popup.remove();
      return;
    }
    popup.setLngLat(event.lngLat).setText(name).addTo(map);
  });
  map.on("mouseleave", LAYERS.riverBase, () => popup.remove());
}

boot();
