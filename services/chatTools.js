/**
 * chatTools.js — the only things the chatbot is allowed to know.
 *
 * Every tool reads the same data the website reads: live bus telemetry from
 * Supabase and the official HMRL GTFS timetable. The model is told to answer
 * from these results only, so it cannot invent a bus time.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// --------------------------------------------------------------- engine
// metro.mjs / routing.mjs are ES modules shared with the frontend, so they
// are pulled in with a dynamic import once and then cached.
let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const metro = await import('../shared/metro.mjs');
      const routing = await import('../shared/routing.mjs');
      await metro.loadMetro({
        readJson: (file) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', file), 'utf8'))
      });
      return { metro, routing };
    })();
  }
  return enginePromise;
}

// ----------------------------------------------------------- bus cache
let busCache = { at: 0, data: [] };
async function getBuses() {
  if (Date.now() - busCache.at < 5000) return busCache.data;
  const [{ data: stat }, { data: live }] = await Promise.all([
    supabase.from('bus_static_info').select('*'),
    supabase.from('bus_telemetry').select('*')
  ]);
  const byId = {};
  (live || []).forEach((r) => { byId[r.id] = r; });
  const merged = (stat || []).map((s) => {
    const l = byId[s.id] || {};
    const stops = s.stops || [];
    return {
      id: s.id,
      route: s.route,
      type: s.type,
      depot: s.depot,
      totalSeats: s.total_seats,
      crowdLevel: s.crowd_level,
      scheduledTime: s.scheduled_time,
      stops,
      occupiedSeats: l.occupied_seats || 0,
      currentStopIndex: stops.length ? (l.current_stop_index || 0) % stops.length : 0,
      etaSeconds: l.eta_seconds || 0,
      bufferActive: !!l.buffer_active
    };
  });
  busCache = { at: Date.now(), data: merged };
  return merged;
}

const minutes = (sec) => Math.max(0, Math.round(sec / 60));

// ------------------------------------------------------------- schemas
const TOOL_SCHEMAS = [
  {
    name: 'plan_journey',
    description:
      'Plan a journey between two places using buses, Hyderabad Metro and walking. ' +
      'Use this whenever someone asks how to get from one place to another. ' +
      'Returns several options with real metro departure times, fares, number of changes and how crowded each one is.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Starting bus stop or metro station name' },
        to: { type: 'string', description: 'Destination bus stop or metro station name' },
        prefer: {
          type: 'string',
          enum: ['fastest', 'cheapest', 'fewest', 'least_crowded'],
          description: 'How to rank the options. Default fastest.'
        }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'next_buses_at_stop',
    description: 'Buses heading to a given bus stop soon, with how many minutes away and how full they are.',
    input_schema: {
      type: 'object',
      properties: { stop: { type: 'string' } },
      required: ['stop']
    }
  },
  {
    name: 'bus_status',
    description: 'Live position, crowding and route of one bus, by its registration number such as TS-10-1010.',
    input_schema: {
      type: 'object',
      properties: { bus_id: { type: 'string' } },
      required: ['bus_id']
    }
  },
  {
    name: 'next_trains',
    description: 'Next metro departures from a station, with line and direction. Also gives first and last train of the day.',
    input_schema: {
      type: 'object',
      properties: { station: { type: 'string' } },
      required: ['station']
    }
  },
  {
    name: 'metro_fare',
    description: 'Published metro fare between two stations, cash and smart card.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'find_places',
    description:
      'Look up stop or station names when the user gives a place that is spelled differently or only partly. ' +
      'Call this first if plan_journey says a place was not found.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
];

// ------------------------------------------------------------ handlers
async function plan_journey({ from, to, prefer = 'fastest' }, collect) {
  const { metro, routing } = await engine();
  const buses = await getBuses();
  const places = routing.buildPlaces(buses);

  const a = routing.resolvePlace(places, from);
  const b = routing.resolvePlace(places, to);
  if (!a || !b) {
    return {
      error: 'place_not_found',
      missing: !a ? from : to,
      hint: 'Call find_places with that name to see close matches.'
    };
  }

  const list = routing.sortJourneys(
    routing.planJourneys({ buses, from: a, to: b, places }),
    prefer
  ).slice(0, 3);

  if (!list.length) return { error: 'no_route', from: a.name, to: b.name };

  // hand the full objects back to the route handler so the browser can draw
  // real route cards instead of re-parsing the model's prose
  if (collect) collect.journeys.push(...list);

  return {
    from: a.name,
    to: b.name,
    ranked_by: prefer,
    options: list.map((j) => ({
      depart: metro.secToHHMM(j.depSec),
      arrive: metro.secToHHMM(j.arrSec),
      total_minutes: minutes(j.durationSec),
      fare_rupees: j.fare,
      changes: j.transfers,
      walking_metres: j.walkM,
      crowding: j.crowdLevel,
      co2_saved_kg: +j.co2SavedKg.toFixed(2),
      steps: j.legs.map((l) =>
        l.kind === 'walk'
          ? `Walk ${l.m} m from ${l.from} to ${l.to}`
          : l.kind === 'metro'
            ? `Metro ${l.line} line from ${l.from} to ${l.to}, ${l.stops} stops towards ${l.terminus}, departs ${metro.secToHHMM(l.depSec)}`
            : `Bus ${String(l.route || '').split(' - ')[0]} (${l.busId}) from ${l.from} to ${l.to}, ${l.stops} stops, ${l.crowd.occupied}/${l.crowd.seats} seats taken`
      )
    }))
  };
}

async function next_buses_at_stop({ stop }) {
  const { routing } = await engine();
  const buses = await getBuses();
  const target = String(stop).toLowerCase();

  const rows = [];
  buses.forEach((bus) => {
    const idx = (bus.stops || []).findIndex((s) => String(s.name).toLowerCase() === target);
    if (idx < 0) return;
    const here = bus.currentStopIndex;
    if (idx < here) return; // already gone past
    const eta = (bus.etaSeconds || 0) + (idx - here) * routing.BUS_STOP_SECONDS;
    rows.push({
      bus_id: bus.id,
      route: bus.route,
      type: bus.type,
      arrives_in_minutes: minutes(eta),
      seats_taken: bus.occupiedSeats,
      total_seats: bus.totalSeats,
      crowding: bus.occupiedSeats / (bus.totalSeats || 50) >= 0.85 ? 'High'
        : bus.occupiedSeats / (bus.totalSeats || 50) >= 0.6 ? 'Medium-High'
          : bus.occupiedSeats / (bus.totalSeats || 50) >= 0.35 ? 'Medium' : 'Low',
      currently_at: bus.stops[here]?.name,
      final_stop: bus.stops[bus.stops.length - 1]?.name
    });
  });

  if (!rows.length) return { error: 'stop_not_found_or_no_buses', stop };
  return { stop, buses: rows.sort((x, y) => x.arrives_in_minutes - y.arrives_in_minutes).slice(0, 6) };
}

async function bus_status({ bus_id }) {
  const buses = await getBuses();
  const bus = buses.find((b) => String(b.id).toLowerCase() === String(bus_id).toLowerCase());
  if (!bus) return { error: 'bus_not_found', bus_id };
  const stop = bus.stops[bus.currentStopIndex];
  const next = bus.stops[(bus.currentStopIndex + 1) % bus.stops.length];
  return {
    bus_id: bus.id,
    route: bus.route,
    type: bus.type,
    depot: bus.depot,
    status: bus.bufferActive ? `waiting at ${stop?.name}` : `on the way to ${next?.name}`,
    next_stop: next?.name,
    next_stop_in_minutes: minutes(bus.etaSeconds),
    seats_taken: bus.occupiedSeats,
    total_seats: bus.totalSeats,
    percent_full: Math.round((bus.occupiedSeats / (bus.totalSeats || 50)) * 100)
  };
}

async function next_trains({ station }) {
  const { metro } = await engine();
  const st = metro.findStation(station);
  if (!st) return { error: 'station_not_found', station };
  const now = metro.secondsSinceMidnight();
  return {
    station: st.name,
    lines: st.lines,
    departures: metro.nextTrains(st.id, { limit: 6 }).map((d) => ({
      line: d.line, towards: d.terminus, at: metro.secToHHMM(d.depSec), in_minutes: Math.max(0, d.inMin)
    })),
    first_and_last: (metro.firstLastTrain(st.id) || []).map((x) => ({
      line: x.line, towards: x.terminus, first: metro.secToHHMM(x.first), last: metro.secToHHMM(x.last)
    })),
    note: now > 24 * 3600 ? null : 'Times come from the official HMRL GTFS timetable.'
  };
}

async function metro_fare({ from, to }) {
  const { metro } = await engine();
  const a = metro.findStation(from);
  const b = metro.findStation(to);
  if (!a || !b) return { error: 'station_not_found', missing: !a ? from : to };
  const cash = metro.metroFare(a.id, b.id);
  if (cash === null) return { error: 'fare_not_published', from: a.name, to: b.name };
  return {
    from: a.name,
    to: b.name,
    cash_rupees: cash,
    smart_card_rupees: metro.metroFare(a.id, b.id, { smartCard: true })
  };
}

async function find_places({ query }) {
  const { routing } = await engine();
  const buses = await getBuses();
  const places = routing.buildPlaces(buses);
  const q = String(query).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = places
    .filter((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q))
    .slice(0, 10)
    .map((p) => ({ name: p.name, kind: p.kind, metro_lines: p.lines || null }));
  return hits.length ? { matches: hits } : { error: 'no_match', query };
}

const HANDLERS = { plan_journey, next_buses_at_stop, bus_status, next_trains, metro_fare, find_places };

async function runTool(name, input, collect) {
  const fn = HANDLERS[name];
  if (!fn) return { error: 'unknown_tool', name };
  try {
    return await fn(input || {}, collect);
  } catch (err) {
    console.error(`tool ${name} failed:`, err.message);
    return { error: 'tool_failed', detail: err.message };
  }
}

module.exports = { TOOL_SCHEMAS, runTool, getBuses, engine };
