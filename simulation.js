require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------
const TICK_MS = 3000;          // engine loop speed (3 seconds)
const TICK_SEC = 3;            // seconds subtracted from every timer per tick
const DRIVE_SECONDS = 20;      // drive time to the next stop
const WAIT_SECONDS = 9;        // wait time at a stop
const UPDATE_BATCH_SIZE = 20;  // max simultaneous Supabase writes

// Passenger model. Capacity comes from each bus's own total_seats
// (bus_static_info) instead of one fixed number for every bus.
const STANDING_ALLOWANCE = 1.1;   // a bus can go to 110% of its seats (standing)
const DEFAULT_SEATS = 50;
const ALIGHT_MIN = 0.15;          // 15% to 40% of passengers get off at each stop
const ALIGHT_RANGE = 0.25;
// Max people boarding at one stop as a share of the bus's seats, by the
// crowd_level in bus_static_info (High buses fill up, Low buses stay light)
const BOARDING_FACTOR = { 'High': 0.5, 'Medium-High': 0.42, 'Medium': 0.32, 'Low': 0.16 };

// ---------------------------------------------------------------
// STATE (also reported by /health so you can see the engine is alive)
// ---------------------------------------------------------------
let buses = [];
let tickCount = 0;
let lastTickAt = null;
let lastError = null;
let tickInProgress = false;

// ---------------------------------------------------------------
// WEB SERVER FOR RENDER
// "/" keeps the original message. "/health" is for uptime pingers.
// ---------------------------------------------------------------
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('✅ SPTIS Live Simulation Engine is Running 24/7!');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    buses: buses.length,
    ticks: tickCount,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    secondsSinceLastTick: lastTickAt ? Math.round((Date.now() - lastTickAt) / 1000) : null,
    lastError
  });
});

app.listen(port, () => {
  console.log(`🌐 Web server listening on port ${port}`);
});

// ---------------------------------------------------------------
// SUPABASE (MASTER service key)
// ---------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_KEY is missing in the environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A missing / null / non-numeric value would turn every timer into NaN,
// and NaN <= 0 is never true, which freezes a bus forever. Clean it up.
const toNumber = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanBus = (row, info) => {
  const totalSeats = toNumber(info && info.total_seats, DEFAULT_SEATS);
  const capacity = Math.round(totalSeats * STANDING_ALLOWANCE);
  return {
    ...row,
    // in-memory only, never written back to the telemetry table
    _capacity: capacity,
    _boardingMax: Math.max(1, Math.round(totalSeats * (BOARDING_FACTOR[info && info.crowd_level] || BOARDING_FACTOR['Medium']))),
    occupied_seats: Math.min(capacity, toNumber(row.occupied_seats, 0)),
    current_stop_index: toNumber(row.current_stop_index, 0),
    eta_seconds: toNumber(row.eta_seconds, 0),
    buffer_active: row.buffer_active === true
  };
};

// Seat counts and crowd levels. If this read fails the engine still runs
// with default values instead of stopping.
async function loadStaticInfo() {
  try {
    const { data, error } = await supabase.from('bus_static_info').select('id,total_seats,crowd_level');
    if (error) throw new Error(error.message);
    const byId = {};
    (data || []).forEach((row) => { byId[row.id] = row; });
    return byId;
  } catch (err) {
    console.error('⚠️ Could not load bus_static_info, using default seat counts:', err.message);
    return {};
  }
}

// Load all buses. If Supabase is unreachable, keep retrying instead of
// giving up (the old version returned once and the simulation never started).
async function loadBuses() {
  while (true) {
    try {
      const { data, error } = await supabase.from('bus_telemetry').select('*');
      if (error) {
        lastError = `Load failed: ${error.message}`;
        console.error('❌ Database Connection Error:', error.message, '(retrying in 5s)');
      } else if (!data || data.length === 0) {
        lastError = 'bus_telemetry returned 0 rows';
        console.error('❌ bus_telemetry returned 0 rows (retrying in 5s)');
      } else {
        const info = await loadStaticInfo();
        return data.map((row) => cleanBus(row, info[row.id]));
      }
    } catch (err) {
      lastError = `Load crashed: ${err.message}`;
      console.error('❌ Load crashed:', err.message, '(retrying in 5s)');
    }
    await sleep(5000);
  }
}

async function pushUpdate(bus) {
  const { error } = await supabase
    .from('bus_telemetry')
    .update({
      occupied_seats: bus.occupied_seats,
      current_stop_index: bus.current_stop_index,
      buffer_active: bus.buffer_active,
      eta_seconds: bus.eta_seconds
    })
    .eq('id', bus.id);

  if (error) {
    lastError = `Update bus ${bus.id}: ${error.message}`;
    console.error(`Error updating bus ${bus.id}:`, error.message);
  }
}

// ---------------------------------------------------------------
// ONE SIMULATION STEP (same rules as before)
// ---------------------------------------------------------------
function stepBus(bus) {
  let stateChanged = false;

  if (bus.buffer_active) {
    // Waiting at the stop (current_stop_index is the stop the bus is at)
    bus.eta_seconds -= TICK_SEC;
    if (bus.eta_seconds <= 0) {
      bus.buffer_active = false;

      // Passenger Math (Boarding/Alighting)
      const alightFraction = ALIGHT_MIN + Math.random() * ALIGHT_RANGE;
      const alighting = Math.floor(bus.occupied_seats * alightFraction);
      const boarding = Math.floor(Math.random() * (bus._boardingMax + 1));
      bus.occupied_seats = Math.max(0, Math.min(bus._capacity, bus.occupied_seats + boarding - alighting));

      // Depart: the bus now drives from this stop toward the next one.
      // The stop index does NOT change yet.
      bus.eta_seconds = DRIVE_SECONDS;
      stateChanged = true;
    }
  } else {
    // Driving toward the next stop
    bus.eta_seconds -= TICK_SEC;
    if (bus.eta_seconds <= 0) {
      // Arrive: only now move to the next stop index, then wait there.
      // (The website draws the bus between stop[index] and stop[index + 1]
      // while driving. Changing the index at departure made it slide toward
      // the next stop and then snap back.)
      bus.current_stop_index = bus.current_stop_index + 1;
      bus.buffer_active = true;
      bus.eta_seconds = WAIT_SECONDS;
      stateChanged = true;
    }
  }

  return stateChanged;
}

async function tick() {
  // Never let two ticks overlap: a slow network call would otherwise
  // make timers count down twice as fast on the next tick.
  if (tickInProgress) {
    console.warn('⚠️ Previous tick still running, skipping this one');
    return;
  }
  tickInProgress = true;

  try {
    const changed = buses.filter(stepBus);

    // Push changes in small parallel batches (faster than one by one)
    for (let i = 0; i < changed.length; i += UPDATE_BATCH_SIZE) {
      await Promise.all(changed.slice(i, i + UPDATE_BATCH_SIZE).map(pushUpdate));
    }

    tickCount += 1;
    lastTickAt = Date.now();

    if (tickCount % 100 === 0) {
      console.log(`💓 Tick #${tickCount} | ${buses.length} buses | ${changed.length} changed this tick`);
    }
  } catch (err) {
    lastError = `Tick crashed: ${err.message}`;
    console.error('❌ Tick crashed:', err.message);
  } finally {
    tickInProgress = false;
  }
}

async function startSimulation() {
  console.log('🚀 Starting SPTIS Fleet Simulation Engine...');

  buses = await loadBuses();
  console.log(`✅ Loaded ${buses.length} buses. Simulation running...`);

  setInterval(tick, TICK_MS);
}

// A stray network error should be logged, not silently kill the engine
process.on('unhandledRejection', (reason) => {
  lastError = `Unhandled rejection: ${reason}`;
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  lastError = `Uncaught exception: ${err.message}`;
  console.error('Uncaught exception:', err);
});

startSimulation();
