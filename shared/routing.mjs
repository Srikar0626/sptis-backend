/**
 * routing.js — one journey planner over buses, metro and walking.
 *
 * Buses come from the live Supabase telemetry the app already loads
 * (bus.stops = [{ name, lat, lng }], bus.occupiedSeats, bus.totalSeats,
 * bus.currentStopIndex, bus.etaSeconds). Metro comes from metro.js.
 *
 * The output is a list of journeys that can be sorted four ways:
 *   fastest | cheapest | fewest | least_crowded
 */
import {
  getMetro, planMetro, nearestStations, metresBetween, secondsSinceMidnight
} from './metro.mjs';

// ---------------------------------------------------------------- tuning
export const WALK_SPEED_M_S = 1.25;       // ~4.5 km/h
export const MAX_WALK_M = 1200;           // longest walk we will suggest
export const STOP_TO_STATION_M = 450;     // bus stop counted as "at" a station
export const BUS_STOP_SECONDS = 180;      // average time between two bus stops
export const BUS_BOARD_SECONDS = 60;      // boarding / doors
export const DEFAULT_BUS_HEADWAY_SEC = 12 * 60;
export const TRANSFER_PENALTY_SEC = 180;

// grams of CO2 per passenger-km
const CO2 = { car: 171, bus: 68, metro: 22, walk: 0 };

const walkSec = (m) => Math.round(m / WALK_SPEED_M_S);
const toPoint = (o) => ({ lat: o.lat, lon: o.lon ?? o.lng });

// ---------------------------------------------------------- place index
/**
 * Every bus stop and every metro station as one searchable list.
 * Names that exist in both networks stay separate entries but are linked by
 * a short walk, which is what actually happens on the ground.
 */
export function buildPlaces(buses) {
  const metro = getMetro();
  const byName = new Map();

  (buses || []).forEach((bus) => {
    (bus.stops || []).forEach((s, i) => {
      if (!s?.name) return;
      const key = `bus:${s.name}`;
      if (!byName.has(key)) {
        byName.set(key, { id: key, kind: 'bus', name: s.name, lat: s.lat, lon: s.lng, serving: [] });
      }
      byName.get(key).serving.push({ busId: bus.id, index: i });
    });
  });

  if (metro) {
    metro.stations.forEach((st) => {
      byName.set(`metro:${st.id}`, {
        id: `metro:${st.id}`, kind: 'metro', name: st.name,
        lat: st.lat, lon: st.lon, stationId: st.id, lines: st.lines
      });
    });
  }

  return [...byName.values()];
}

/** Everything the autocomplete should offer, metro stations flagged. */
export function placeOptions(places) {
  const seen = new Set();
  return places
    .filter((p) => {
      const k = `${p.name}|${p.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve a typed name to a place, preferring an exact match. */
export function resolvePlace(places, query) {
  const q = norm(query);
  if (!q) return null;
  return (
    places.find((p) => norm(p.name) === q) ||
    places.find((p) => norm(p.name).startsWith(q)) ||
    places.find((p) => norm(p.name).includes(q)) ||
    null
  );
}

// ----------------------------------------------------------- bus helpers
const stopIndex = (bus, name) => (bus.stops || []).findIndex((s) => s.name === name);

/**
 * How long until this bus reaches `stopIdx`, using the live telemetry.
 * If it has already gone past, assume the next bus on the same route.
 */
function busWaitSeconds(bus, stopIdx) {
  const here = bus.currentStopIndex ?? 0;
  const eta = Math.max(0, bus.etaSeconds ?? 0);
  if (stopIdx < here) return DEFAULT_BUS_HEADWAY_SEC; // missed it, wait for the next one
  const hops = stopIdx - here;
  return eta + hops * BUS_STOP_SECONDS;
}

function busCrowd(bus) {
  const seats = bus.totalSeats || 50;
  const score = Math.min(1, (bus.occupiedSeats || 0) / seats);
  const level = score >= 0.85 ? 'High' : score >= 0.6 ? 'Medium-High' : score >= 0.35 ? 'Medium' : 'Low';
  return { level, score, occupied: bus.occupiedSeats || 0, seats };
}

function busLeg(bus, fromIdx, toIdx, startSec, fareFn) {
  const stops = toIdx - fromIdx;
  const wait = busWaitSeconds(bus, fromIdx);
  const depSec = startSec + wait;
  const rideSec = stops * BUS_STOP_SECONDS + BUS_BOARD_SECONDS;
  const seq = bus.stops.slice(fromIdx, toIdx + 1);
  let km = 0;
  for (let i = 0; i + 1 < seq.length; i++) km += metresBetween(toPoint(seq[i]), toPoint(seq[i + 1])) / 1000;
  return {
    kind: 'bus',
    busId: bus.id,
    route: bus.route,
    busType: bus.type,
    from: bus.stops[fromIdx].name,
    to: bus.stops[toIdx].name,
    stops,
    stopNames: seq.map((s) => s.name),
    path: seq.map((s) => [s.lat, s.lng]),
    waitSec: wait,
    depSec,
    arrSec: depSec + rideSec,
    km,
    crowd: busCrowd(bus),
    fare: fareFn ? fareFn(bus, stops, bus.stops[fromIdx].name, bus.stops[toIdx].name) : estimateBusFare(km, bus.type)
  };
}

export function estimateBusFare(km, type) {
  const premium = /METRO ?EXPRESS|AC|LUXURY|VOLVO|DELUXE/i.test(type || '');
  const base = premium ? 20 : 10;
  const perKm = premium ? 2.2 : 1.2;
  return Math.max(base, Math.round((base + km * perKm) / 5) * 5);
}

function walkLeg(from, to, startSec) {
  const m = Math.round(metresBetween(toPoint(from), toPoint(to)));
  const sec = walkSec(m);
  return {
    kind: 'walk', from: from.name, to: to.name, m, depSec: startSec, arrSec: startSec + sec,
    path: [[from.lat, from.lon ?? from.lng], [to.lat, to.lon ?? to.lng]]
  };
}

// ------------------------------------------------------- access / egress
/**
 * Ways of getting from `origin` to a metro station: walk there, or take one
 * bus to a stop next to one. Returns the cheapest few by time.
 */
function accessToMetro(origin, places, buses, startSec, fareFn, limit = 3) {
  const out = [];

  nearestStations(toPoint(origin), MAX_WALK_M, 3).forEach(({ station, m }) => {
    const place = places.find((p) => p.id === `metro:${station.id}`);
    if (!place) return;
    out.push({ stationId: station.id, legs: m < 40 ? [] : [walkLeg(origin, place, startSec)], arrSec: startSec + walkSec(m) });
  });

  if (origin.kind === 'bus') {
    (buses || []).forEach((bus) => {
      const fromIdx = stopIndex(bus, origin.name);
      if (fromIdx < 0) return;
      // find a later stop on this bus that sits next to a metro station
      for (let i = fromIdx + 1; i < bus.stops.length; i++) {
        const near = nearestStations(toPoint(bus.stops[i]), STOP_TO_STATION_M, 1)[0];
        if (!near) continue;
        const leg = busLeg(bus, fromIdx, i, startSec, fareFn);
        const stationPlace = places.find((p) => p.id === `metro:${near.station.id}`);
        const legs = [leg];
        let arr = leg.arrSec;
        if (near.m > 40 && stationPlace) {
          const w = walkLeg(bus.stops[i], stationPlace, arr);
          legs.push(w);
          arr = w.arrSec;
        }
        out.push({ stationId: near.station.id, legs, arrSec: arr });
        break; // one entry point per bus is enough
      }
    });
  }

  const best = new Map();
  out.forEach((o) => {
    const cur = best.get(o.stationId);
    if (!cur || o.arrSec < cur.arrSec) best.set(o.stationId, o);
  });
  return [...best.values()].sort((a, b) => a.arrSec - b.arrSec).slice(0, limit);
}

/** Mirror image: from a metro station to the destination. */
function egressFromMetro(dest, places, buses, fareFn, limit = 3) {
  const out = [];

  nearestStations(toPoint(dest), MAX_WALK_M, 3).forEach(({ station, m }) => {
    out.push({ stationId: station.id, m, build: (t) => {
      const place = places.find((p) => p.id === `metro:${station.id}`);
      return m < 40 ? [] : [walkLeg(place, dest, t)];
    } });
  });

  if (dest.kind === 'bus') {
    (buses || []).forEach((bus) => {
      const toIdx = stopIndex(bus, dest.name);
      if (toIdx < 0) return;
      for (let i = toIdx - 1; i >= 0; i--) {
        const near = nearestStations(toPoint(bus.stops[i]), STOP_TO_STATION_M, 1)[0];
        if (!near) continue;
        out.push({ stationId: near.station.id, m: near.m, build: (t) => {
          const legs = [];
          let now = t;
          if (near.m > 40) {
            const place = places.find((p) => p.id === `metro:${near.station.id}`);
            const w = walkLeg(place, bus.stops[i], now);
            legs.push(w); now = w.arrSec;
          }
          legs.push(busLeg(bus, i, toIdx, now, fareFn));
          return legs;
        } });
        break;
      }
    });
  }

  const best = new Map();
  out.forEach((o) => { if (!best.has(o.stationId)) best.set(o.stationId, o); });
  return [...best.values()].slice(0, limit);
}

// ------------------------------------------------------------- assemble
function finish(legs, startSec, label) {
  if (!legs.length) return null;
  const depSec = legs[0].depSec;
  const arrSec = legs[legs.length - 1].arrSec;
  const rides = legs.filter((l) => l.kind === 'bus' || l.kind === 'metro');
  if (!rides.length) return null;

  const fare = rides.reduce((n, l) => n + (l.fare || 0), 0);
  const walkM = legs.filter((l) => l.kind === 'walk').reduce((n, l) => n + l.m, 0);

  let grams = 0, km = 0;
  rides.forEach((l) => {
    const d = l.km ?? (l.stops * 1.2);
    km += d;
    grams += d * (l.kind === 'metro' ? CO2.metro : CO2.bus);
  });

  // 0 = empty, 1 = packed; the worst leg drives the score
  const crowdScore = Math.max(...rides.map((l) => l.crowd?.score ?? 0.5));

  return {
    id: `${label}-${rides.map((l) => l.busId || l.line).join('-')}-${depSec}`,
    label,
    legs,
    depSec,
    arrSec,
    durationSec: arrSec - startSec,
    waitSec: depSec - startSec,
    fare,
    transfers: rides.length - 1,
    walkM,
    km,
    crowdScore,
    crowdLevel: crowdScore >= 0.85 ? 'High' : crowdScore >= 0.6 ? 'Medium-High' : crowdScore >= 0.35 ? 'Medium' : 'Low',
    co2SavedKg: Math.max(0, (km * CO2.car - grams) / 1000),
    modes: [...new Set(legs.map((l) => l.kind))]
  };
}

/**
 * Main entry point.
 *
 *   planJourneys({ buses, from: 'Miyapur', to: 'HITEC City' })
 *
 * `busFare` lets you plug in the fare function the app already has:
 *   busFare: (bus, stops, fromName, toName) => number
 */
export function planJourneys({
  buses = [],
  from,
  to,
  date = new Date(),
  busFare = null,
  smartCard = false,
  places: given = null,
  max = 6
} = {}) {
  const places = given || buildPlaces(buses);
  const origin = typeof from === 'string' ? resolvePlace(places, from) : from;
  const dest = typeof to === 'string' ? resolvePlace(places, to) : to;
  if (!origin || !dest || origin.id === dest.id) return [];

  const startSec = secondsSinceMidnight(date);
  const journeys = [];

  // 1 — one bus all the way
  buses.forEach((bus) => {
    const a = stopIndex(bus, origin.name);
    const b = stopIndex(bus, dest.name);
    if (a < 0 || b < 0 || a >= b) return;
    journeys.push(finish([busLeg(bus, a, b, startSec, busFare)], startSec, 'direct_bus'));
  });

  // 2 — metro, with a walk at each end if needed
  const metro = getMetro();
  if (metro) {
    const access = accessToMetro(origin, places, buses, startSec, busFare);
    const egress = egressFromMetro(dest, places, buses, busFare);

    access.forEach((acc) => {
      egress.forEach((eg) => {
        if (acc.stationId === eg.stationId) return;
        const ride = planMetro(acc.stationId, eg.stationId, acc.arrSec + (acc.legs.length ? TRANSFER_PENALTY_SEC : 0), { date, smartCard });
        if (!ride) return;
        const metroLegs = ride.legs.map((l) => ({
          ...l,
          fromId: l.from,
          toId: l.to,
          from: stationName(l.from),
          to: stationName(l.to),
          stationNames: (l.stations || []).map(stationName),
          fare: 0,
          km: l.kind === 'metro' ? metroKm(l) : 0,
          path: metroPathCoords(l)
        }));
        if (metroLegs[0]) metroLegs[0].fare = ride.fare || 0;

        const legs = [...acc.legs, ...metroLegs, ...eg.build(ride.arrSec)];
        journeys.push(finish(legs, startSec, legs.some((l) => l.kind === 'bus') ? 'bus_metro' : 'metro'));
      });
    });
  }

  // 3 — two buses with one change
  buses.forEach((b1) => {
    const a = stopIndex(b1, origin.name);
    if (a < 0) return;
    buses.forEach((b2) => {
      if (b1.id === b2.id) return;
      const d2 = stopIndex(b2, dest.name);
      if (d2 < 0) return;
      for (let i = a + 1; i < b1.stops.length; i++) {
        const name = b1.stops[i].name;
        const j = stopIndex(b2, name);
        if (j < 0 || j >= d2) continue;
        const leg1 = busLeg(b1, a, i, startSec, busFare);
        const leg2 = busLeg(b2, j, d2, leg1.arrSec + TRANSFER_PENALTY_SEC, busFare);
        journeys.push(finish([leg1, leg2], startSec, 'bus_transfer'));
        return;
      }
    });
  });

  // de-duplicate, keep the quickest of each shape
  const unique = new Map();
  journeys.filter(Boolean).forEach((j) => {
    const key = j.legs.map((l) => `${l.kind}:${l.busId || l.line || ''}:${l.from}>${l.to}`).join('|');
    const cur = unique.get(key);
    if (!cur || j.arrSec < cur.arrSec) unique.set(key, j);
  });

  return [...unique.values()].sort((x, y) => x.arrSec - y.arrSec).slice(0, max);
}

function stationName(id) {
  const m = getMetro();
  return m?.stationById[id]?.name || id;
}
function metroKm(leg) {
  const m = getMetro();
  if (!m) return leg.stops * 1.1;
  let km = 0;
  for (let i = 0; i + 1 < leg.stations.length; i++) {
    const a = m.stationById[leg.stations[i]], b = m.stationById[leg.stations[i + 1]];
    if (a && b) km += metresBetween(a, b) / 1000;
  }
  return km;
}
function metroPathCoords(leg) {
  const m = getMetro();
  if (!m) return [];
  const ids = leg.stations || [leg.from, leg.to];
  return ids.map((id) => m.stationById[id]).filter(Boolean).map((s) => [s.lat, s.lon]);
}

// ---------------------------------------------------------------- sorting
export const SORT_MODES = [
  { id: 'fastest', labelKey: 'sort_fastest' },
  { id: 'cheapest', labelKey: 'sort_cheapest' },
  { id: 'fewest', labelKey: 'sort_fewest' },
  { id: 'least_crowded', labelKey: 'sort_least_crowded' }
];

export function sortJourneys(list, mode = 'fastest') {
  const copy = [...list];
  switch (mode) {
    case 'cheapest':
      return copy.sort((a, b) => a.fare - b.fare || a.durationSec - b.durationSec);
    case 'fewest':
      return copy.sort((a, b) => a.transfers - b.transfers || a.durationSec - b.durationSec);
    case 'least_crowded':
      return copy.sort((a, b) => a.crowdScore - b.crowdScore || a.durationSec - b.durationSec);
    default:
      return copy.sort((a, b) => a.durationSec - b.durationSec);
  }
}

/** Short human summary, reused by the chatbot. */
export function describeJourney(j) {
  const bits = j.legs.map((l) => {
    if (l.kind === 'walk') return `walk ${l.m} m`;
    if (l.kind === 'metro') return `Metro ${l.line[0] + l.line.slice(1).toLowerCase()} Line ${l.from}→${l.to}`;
    return `Bus ${String(l.route || '').split(' - ')[0]} ${l.from}→${l.to}`;
  });
  return `${bits.join(', then ')} — ${Math.round(j.durationSec / 60)} min, ₹${j.fare}, ${j.transfers} change(s), ${j.crowdLevel.toLowerCase()} crowding`;
}
