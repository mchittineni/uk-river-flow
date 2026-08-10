/**
 * Joining river geometry to gauging stations, in the browser.
 *
 * The river network is static geometry that changes on a scale of years; the
 * discharge readings change every day. Precomputing the join in the pipeline
 * would couple the two and force a full geometry rebuild on every data refresh,
 * so the join happens here instead — once, at load, against whatever stations the
 * current bundle happens to contain.
 *
 * A brute-force nearest-neighbour search is O(features x stations): roughly
 * 20,000 x 1,000 = 20 million haversine calls, which is seconds of main-thread
 * work. A uniform grid index brings it down to a handful of cells per feature and
 * runs in tens of milliseconds.
 */

/** Grid cell size in degrees. ~28 km at UK latitudes: a few stations per cell. */
const CELL_DEGREES = 0.25;

/** Beyond this, a station tells you nothing useful about a river segment. */
const MAX_JOIN_KM = 30;

const EARTH_RADIUS_KM = 6371.0088;
const TO_RADIANS = Math.PI / 180;

function haversineKm(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * TO_RADIANS;
  const dLon = (lon2 - lon1) * TO_RADIANS;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TO_RADIANS) * Math.cos(lat2 * TO_RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

const cellKey = (lon, lat) => Math.floor(lon / CELL_DEGREES) + ":" + Math.floor(lat / CELL_DEGREES);

/** Build a grid index of stations for repeated nearest-neighbour queries. */
export function indexStations(stations) {
  const cells = new Map();
  for (const station of stations) {
    const key = cellKey(station.lon, station.lat);
    const bucket = cells.get(key);
    if (bucket) bucket.push(station);
    else cells.set(key, [station]);
  }
  return cells;
}

function nearestStation(cells, lon, lat, maxKm) {
  // Widen the search ring by ring. Stopping as soon as a ring yields a hit is not
  // strictly correct — a nearer station can sit just outside a diagonal — so we
  // always scan one ring beyond the first hit, which is enough at this cell size.
  const centreX = Math.floor(lon / CELL_DEGREES);
  const centreY = Math.floor(lat / CELL_DEGREES);
  const maxRings = Math.ceil(maxKm / (CELL_DEGREES * 111)) + 1;

  let best = null;
  let bestKm = maxKm;
  let ringsSinceHit = -1;

  for (let ring = 0; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        // Only the perimeter of this ring; the interior was covered already.
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const bucket = cells.get(centreX + dx + ":" + (centreY + dy));
        if (!bucket) continue;
        for (const station of bucket) {
          const km = haversineKm(lon, lat, station.lon, station.lat);
          if (km < bestKm) {
            bestKm = km;
            best = station;
          }
        }
      }
    }
    if (best !== null) {
      ringsSinceHit += 1;
      if (ringsSinceHit >= 1) break;
    }
  }

  return best ? { station: best, km: bestKm } : null;
}

/**
 * Attach the nearest station id to every river feature, in place.
 *
 * Called once. Afterwards `applyNetworkState` only rewrites the two properties
 * that change with time, which is what keeps time-scrubbing cheap.
 */
export function joinNetworkToStations(network, stations) {
  const cells = indexStations(stations);
  let joined = 0;

  for (const feature of network.features) {
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length === 0) continue;

    // The midpoint vertex, not the centroid: for a sinuous river the centroid can
    // fall on the far side of a meander, or on dry land inside an oxbow.
    const [lon, lat] = coordinates[Math.floor(coordinates.length / 2)];
    const hit = nearestStation(cells, lon, lat, MAX_JOIN_KM);
    if (hit) {
      feature.properties.sid = hit.station.id;
      feature.properties.skm = Math.round(hit.km);
      joined += 1;
    }
  }

  return { joined, total: network.features.length };
}

/**
 * Rewrite the time-varying properties on the river network.
 *
 * `states` maps station id to `{ state, mag }`. Segments whose station has no
 * reading for the selected moment fall back to `unknown`, which renders grey
 * rather than pretending the last known value still holds.
 */
export function applyNetworkState(network, states) {
  for (const feature of network.features) {
    const current = states.get(feature.properties.sid);
    if (current) {
      feature.properties.state = current.state;
      feature.properties.mag = current.mag;
    } else {
      feature.properties.state = "unknown";
      feature.properties.mag = 0.25;
    }
  }
  return network;
}
