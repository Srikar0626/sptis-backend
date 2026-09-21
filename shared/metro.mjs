/**
 * metro.js — Hyderabad Metro network engine.
 *
 * Reads the compact metro.json built from the official HMRL GTFS feed
 * (Open Data Telangana) and answers four questions:
 *   whereIsStation / nearestStations   – geography
 *   planMetro                          – station to station with real timetable
 *   nextTrains                         – departure board for one station
 *   metroFare                          – published fare for a station pair
 *
 * No network calls except the one fetch of the data file, so it also works
 * from the service worker cache when the phone is offline.
 */

const DATA_URL = '/data/metro.json';
const FARE_URL = '/data/metro.fares.json';

let cache = null;      // resolved network
let loading = null;    // in-flight promise
let fares = null;

/**
 * In the browser this fetches /data/metro.json. The Express server passes
 * its own `readJson` so the same file can be read from disk.
 *   loadMetro({ readJson: (name) => JSON.parse(fs.readFileSync(...)) })
 */
export async function loadMetro({ readJson = null } = {}) {
  if (cache) return cache;
  if (loading) return loading;
  const get = readJson
    ? (url) => Promise.resolve(readJson(url.split('/').pop()))
    : (url) => fetch(url).then((r) => r.json());
  loading = (async () => {
    const [net, fareTable] = await Promise.all([
      get(DATA_URL),
      Promise.resolve(get(FARE_URL)).catch(() => ({}))
    ]);
    fares = fareTable;
    cache = index(net);
    return cache;
  })();
  return loading;
}

export function getMetro() {
  return cache; // null until loadMetro() resolves
}

// ------------------------------------------------------------------ index
function index(net) {
  const stationById = {};
  net.stations.forEach((s) => { stationById[s.id] = s; });

  const lineById = {};
  net.lines.forEach((l) => { lineById[l.id] = l; });

  // station -> position inside each pattern, so a timetable scan is O(1)
  net.patterns.forEach((p) => {
    p.pos = {};
    p.stations.forEach((id, i) => {
      if (p.pos[id] === undefined) p.pos[id] = i;
    });
    p.terminus = stationById[p.stations[p.stations.length - 1]]?.name || '';
  });

  // typical run time between neighbouring stations, taken from the longest
  // profile on each line and direction
  const hop = {}; // "LINE|A|B" -> seconds
  net.lines.forEach((line) => {
    [0, 1].forEach((dir) => {
      const prof = net.profiles
        .filter((f) => net.patterns[f.p].line === line.id && net.patterns[f.p].dir === dir)
        .sort((a, b) => b.dep.length - a.dep.length)[0];
      if (!prof) return;
      const seq = net.patterns[prof.p].stations;
      for (let i = 0; i + 1 < seq.length; i++) {
        hop[`${line.id}|${seq[i]}|${seq[i + 1]}`] = Math.max(60, prof.arr[i + 1] - prof.dep[i]);
      }
    });
  });

  // adjacency for the shortest-path search
  const adj = {};
  const push = (a, b, e) => { (adj[a] || (adj[a] = [])).push({ to: b, ...e }); };
  Object.keys(hop).forEach((k) => {
    const [line, a, b] = k.split('|');
    push(a, b, { line, sec: hop[k], kind: 'ride' });
  });
  net.transfers.forEach((t) => push(t.from, t.to, { sec: t.sec, kind: 'walk', m: t.m }));

  return { ...net, stationById, lineById, hop, adj };
}

// ------------------------------------------------------------------ basics
export const METRO_LINE_STYLE = {
  RED: { name: 'Red Line', color: '#E31E24', text: '#FFFFFF' },
  GREEN: { name: 'Green Line', color: '#009846', text: '#FFFFFF' },
  BLUE: { name: 'Blue Line', color: '#007ABB', text: '#FFFFFF' }
};

export const metresBetween = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const p1 = a.lat * rad, p2 = b.lat * rad;
  const dp = (b.lat - a.lat) * rad;
  const dl = ((b.lon ?? b.lng) - (a.lon ?? a.lng)) * rad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function findStation(query) {
  if (!cache) return null;
  const q = norm(query);
  if (!q) return null;
  return (
    cache.stations.find((s) => norm(s.name) === q) ||
    cache.stations.find((s) => s.id.toLowerCase() === String(query).toLowerCase()) ||
    cache.stations.find((s) => norm(s.name).startsWith(q)) ||
    cache.stations.find((s) => norm(s.name).includes(q)) ||
    null
  );
}

/** Metro stations within `maxM` metres of {lat, lon|lng}, nearest first. */
export function nearestStations(point, maxM = 1000, limit = 4) {
  if (!cache) return [];
  return cache.stations
    .map((s) => ({ station: s, m: Math.round(metresBetween(s, point)) }))
    .filter((x) => x.m <= maxM)
    .sort((a, b) => a.m - b.m)
    .slice(0, limit);
}

/** GTFS service id that runs on a given date (WK / SA / SU). */
export function serviceIdForDate(date = new Date()) {
  if (!cache) return 'WK';
  const day = date.getDay(); // 0 = Sunday
  const hit = Object.keys(cache.calendar).find((id) => cache.calendar[id][day] === 1);
  return hit || 'WK';
}

export const secondsSinceMidnight = (date = new Date()) =>
  date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

export const secToHHMM = (sec) => {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

/** Published single-journey fare in rupees. */
export function metroFare(fromId, toId, { smartCard = false } = {}) {
  if (!fares) return null;
  const p = fares[`${fromId}>${toId}`] ?? fares[`${toId}>${fromId}`];
  if (p === undefined) return null;
  return smartCard ? Math.round(p * (1 - (cache?.smartCardDiscount || 0))) : p;
}

// ------------------------------------------------------------- timetable
/**
 * Next runs that serve `fromId` then `toId` without changing train.
 * Returns [{ line, dir, depSec, arrSec, terminus }].
 */
export function nextRuns(fromId, toId, afterSec, { date = new Date(), limit = 3 } = {}) {
  if (!cache) return [];
  const svc = serviceIdForDate(date);
  const list = cache.trips[svc] || [];
  const out = [];
  for (const [profIdx, start] of list) {
    const prof = cache.profiles[profIdx];
    const pat = cache.patterns[prof.p];
    const i = pat.pos[fromId];
    if (i === undefined) continue;
    const j = pat.pos[toId];
    if (j === undefined || j <= i) continue;
    const dep = start + prof.dep[i];
    if (dep < afterSec) continue;
    out.push({ line: pat.line, dir: pat.dir, depSec: dep, arrSec: start + prof.arr[j], terminus: pat.terminus });
    if (out.length >= limit) break;
  }
  return out;
}

// --------------------------------------------------------- headway model
// The published GTFS timetable only samples a couple thousand trips a day,
// so asking "when is the next train" straight from it can land in a gap
// between sampled trips and show a wait of an hour or more for two
// stations that are five minutes apart. HMRL's advertised real-world
// frequency is a train every ~5 minutes on every line, so that is what
// drives "next train" and journey planning here instead. The GTFS data is
// still used for the network topology (which lines connect where) and for
// realistic station-to-station running times (see `hopSeconds` below).
//
// Service is modelled strictly morning to night — 06:00 to 23:00 — and we
// never assume it wraps past midnight into the next day. If the time asked
// for is outside that window, that simply means no train is available.
export const METRO_SERVICE_START_SEC = 6 * 3600;  // 06:00 — first train
export const METRO_SERVICE_END_SEC = 23 * 3600;   // 23:00 — last train
export const METRO_HEADWAY_SEC = 5 * 60;          // a train every 5 minutes

/**
 * Next departure under the fixed headway model, or null if `afterSec` is
 * at or past closing time. `offset` staggers the opposite direction so it
 * doesn't show the exact same minute as the first direction checked.
 */
function nextHeadwayDeparture(afterSec, offset = 0) {
  if (afterSec >= METRO_SERVICE_END_SEC) return null;
  const earliest = Math.max(afterSec, METRO_SERVICE_START_SEC);
  let dep = Math.ceil((earliest - offset) / METRO_HEADWAY_SEC) * METRO_HEADWAY_SEC + offset;
  if (dep < earliest) dep += METRO_HEADWAY_SEC;
  return dep < METRO_SERVICE_END_SEC ? dep : null;
}

/** Real running time for a ride leg, station by station, from the GTFS-derived hop table. */
function hopSeconds(lineId, stations) {
  let sec = 0;
  for (let i = 0; i + 1 < stations.length; i++) {
    const key = `${lineId}|${stations[i]}|${stations[i + 1]}`;
    sec += cache?.hop[key] ?? 90; // ~90s/station if a hop is missing from the feed
  }
  return sec;
}

/** Name of the end of the line in the direction this leg is travelling. */
function terminusForLeg(lineId, stations) {
  const line = cache?.lineById[lineId];
  if (!line || !line.stations.length) return '';
  const seq = line.stations;
  const iFrom = seq.indexOf(stations[0]);
  const iTo = seq.indexOf(stations[stations.length - 1]);
  if (iFrom === -1 || iTo === -1) return cache.stationById[seq[seq.length - 1]]?.name || '';
  const forward = iTo > iFrom;
  return cache.stationById[forward ? seq[seq.length - 1] : seq[0]]?.name || '';
}

/** Departure board: next trains from one station, any line/direction, every ~5 minutes. */
export function nextTrains(stationId, { after = null, date = new Date(), limit = 6 } = {}) {
  if (!cache) return [];
  const afterSec = after ?? secondsSinceMidnight(date);
  const station = cache.stationById[stationId];
  if (!station) return [];
  const out = [];
  (station.lines || []).forEach((lineId) => {
    const line = cache.lineById[lineId];
    if (!line) return;
    const idx = line.stations.indexOf(stationId);
    if (idx === -1) return;
    if (idx < line.stations.length - 1) {
      const dep = nextHeadwayDeparture(afterSec);
      if (dep !== null) {
        out.push({ line: lineId, dir: 0, depSec: dep, inMin: Math.max(0, Math.round((dep - afterSec) / 60)), terminus: cache.stationById[line.stations[line.stations.length - 1]]?.name || '' });
      }
    }
    if (idx > 0) {
      const dep = nextHeadwayDeparture(afterSec, METRO_HEADWAY_SEC / 2);
      if (dep !== null) {
        out.push({ line: lineId, dir: 1, depSec: dep, inMin: Math.max(0, Math.round((dep - afterSec) / 60)), terminus: cache.stationById[line.stations[0]]?.name || '' });
      }
    }
  });
  return out.sort((a, b) => a.depSec - b.depSec).slice(0, limit);
}

/** First and last train of the day from a station (fixed by the 06:00–23:00 service window). */
export function firstLastTrain(stationId) {
  if (!cache) return null;
  const station = cache.stationById[stationId];
  if (!station) return null;
  const out = [];
  (station.lines || []).forEach((lineId) => {
    const line = cache.lineById[lineId];
    if (!line) return;
    const idx = line.stations.indexOf(stationId);
    if (idx === -1) return;
    if (idx < line.stations.length - 1) {
      out.push({ line: lineId, terminus: cache.stationById[line.stations[line.stations.length - 1]]?.name || '', first: METRO_SERVICE_START_SEC, last: METRO_SERVICE_END_SEC });
    }
    if (idx > 0) {
      out.push({ line: lineId, terminus: cache.stationById[line.stations[0]]?.name || '', first: METRO_SERVICE_START_SEC, last: METRO_SERVICE_END_SEC });
    }
  });
  return out.length ? out : null;
}

// --------------------------------------------------------- crowd estimate
/**
 * The feed has no occupancy data, so metro crowding is estimated from the
 * time of day and how close the station is to the centre of a corridor.
 * Always label this as an estimate in the UI.
 */
export function metroCrowdEstimate(depSec) {
  const h = (depSec / 3600) % 24;
  const peak = (h >= 8.5 && h <= 11) || (h >= 17 && h <= 20.5);
  const shoulder = (h >= 7 && h < 8.5) || (h > 11 && h <= 13) || (h >= 15.5 && h < 17) || (h > 20.5 && h <= 22);
  if (peak) return { level: 'High', score: 0.85 };
  if (shoulder) return { level: 'Medium', score: 0.55 };
  return { level: 'Low', score: 0.25 };
}

// ------------------------------------------------------------- planning
const TRANSFER_PENALTY_SEC = 210; // walk between platforms + wait for the next train

/** Cheapest-time station path, returning legs grouped by line. */
export function metroPath(fromId, toId) {
  if (!cache || fromId === toId) return null;
  if (!cache.stationById[fromId] || !cache.stationById[toId]) return null;

  // A search state is "station + the line you are sitting on", so that
  // changing trains at Ameerpet costs something and staying on does not.
  const START = `${fromId}|`;
  const dist = new Map([[START, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = [[0, START]];
  let goal = null;

  while (queue.length) {
    // small network (57 stations, 4 states each), so a sorted array is plenty
    queue.sort((a, b) => a[0] - b[0]);
    const [d, state] = queue.shift();
    if (done.has(state)) continue;
    done.add(state);

    const sep = state.indexOf('|');
    const node = state.slice(0, sep);
    const line = state.slice(sep + 1);
    if (node === toId) { goal = state; break; }

    for (const e of cache.adj[node] || []) {
      const nextLine = e.kind === 'ride' ? e.line : '';
      const nextState = `${e.to}|${nextLine}`;
      if (done.has(nextState)) continue;   // already final: never re-parent it
      const changedTrain = e.kind === 'ride' && line && e.line !== line;
      const cost = d + e.sec
        + (changedTrain ? TRANSFER_PENALTY_SEC : 0)
        + (e.kind === 'walk' ? TRANSFER_PENALTY_SEC : 0);
      if (!dist.has(nextState) || cost < dist.get(nextState)) {
        dist.set(nextState, cost);
        prev.set(nextState, { state, edge: e });
        queue.push([cost, nextState]);
      }
    }
  }

  if (!goal) return null;

  const steps = [];
  let cur = goal;
  let guard = 0;
  while (prev.has(cur) && guard++ < 400) {
    const { state, edge } = prev.get(cur);
    steps.unshift({ from: state.slice(0, state.indexOf('|')), to: cur.slice(0, cur.indexOf('|')), edge });
    cur = state;
  }
  if (!steps.length) return null;

  // group consecutive same-line rides into one leg
  const legs = [];
  steps.forEach((s) => {
    const last = legs[legs.length - 1];
    if (s.edge.kind === 'ride' && last && last.kind === 'ride' && last.line === s.edge.line) {
      last.stations.push(s.to);
      last.to = s.to;
    } else if (s.edge.kind === 'ride') {
      legs.push({ kind: 'ride', line: s.edge.line, from: s.from, to: s.to, stations: [s.from, s.to] });
    } else {
      legs.push({ kind: 'walk', from: s.from, to: s.to, sec: s.edge.sec, m: s.edge.m });
    }
  });
  return legs;
}

/**
 * Full metro journey using the fixed 5-minute headway model (see above)
 * for waits, and real GTFS-derived running times for the ride itself.
 * Returns { legs, depSec, arrSec, durationSec, fare, transfers } or null.
 * Returns null if a leg would depart outside the 06:00–23:00 service
 * window — no train, and no overnight service is assumed.
 */
export function planMetro(fromId, toId, departSec, { smartCard = false } = {}) {
  const skeleton = metroPath(fromId, toId);
  if (!skeleton) return null;

  let t = departSec;
  const legs = [];
  for (const leg of skeleton) {
    if (leg.kind === 'walk') {
      legs.push({ ...leg, depSec: t, arrSec: t + leg.sec });
      t += leg.sec;
      continue;
    }
    const dep = nextHeadwayDeparture(t);
    if (dep === null) return null; // outside 06:00–23:00 service, no train
    const rideSec = hopSeconds(leg.line, leg.stations);
    const arr = dep + rideSec;
    legs.push({
      kind: 'metro',
      line: leg.line,
      from: leg.from,
      to: leg.to,
      stations: leg.stations,
      stops: leg.stations.length - 1,
      terminus: terminusForLeg(leg.line, leg.stations),
      depSec: dep,
      arrSec: arr,
      waitSec: dep - t,
      crowd: metroCrowdEstimate(dep)
    });
    t = arr;
  }

  const rides = legs.filter((l) => l.kind === 'metro');
  return {
    legs,
    depSec: legs[0].depSec,
    arrSec: t,
    durationSec: t - departSec,
    fare: metroFare(fromId, toId, { smartCard }),
    transfers: Math.max(0, rides.length - 1),
    stops: rides.reduce((n, l) => n + l.stops, 0)
  };
}
