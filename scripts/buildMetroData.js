/**
 * buildMetroData.js
 * Turns the HMRL / Open Data Telangana GTFS feed into one compact JSON file
 * that both the website and the chatbot read.
 *
 *   1) unzip Telangana_opendata_gtfs_hmrl_*.zip -d ./gtfs
 *   2) node scripts/buildMetroData.js ./gtfs ../sptis-frontend/public/data/metro.json
 *
 * No npm packages needed.
 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || './gtfs';
const OUT = process.argv[3] || './metro.json';

// --- tiny CSV reader (GTFS is plain, comma separated, may quote fields) ---
function readCsv(file) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const head = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i]; });
    return row;
  });
}
function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const hhmmssToSec = (t) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

const metres = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const p1 = a.lat * rad, p2 = b.lat * rad;
  const dp = (b.lat - a.lat) * rad, dl = (b.lon - a.lon) * rad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// ---------------------------------------------------------------- load
const stopRows = readCsv('stops.txt');
const routeRows = readCsv('routes.txt');
const tripRows = readCsv('trips.txt');
const stopTimeRows = readCsv('stop_times.txt');
const fareAttr = readCsv('fare_attributes.txt');
const fareRules = readCsv('fare_rules.txt');
const calendarRows = readCsv('calendar.txt');
const feedInfo = readCsv('feed_info.txt')[0] || {};

const stopById = {};
stopRows.forEach((r) => { stopById[r.stop_id] = r; });
// GTFS models each platform separately; we route on the parent station.
const parentOf = (id) => stopById[id].parent_station || id;

const stations = stopRows
  .filter((r) => r.location_type === '1')
  .map((r) => ({
    id: r.stop_id,
    name: r.stop_name,
    lat: +(+r.stop_lat).toFixed(6),
    lon: +(+r.stop_lon).toFixed(6),
    lines: []
  }));
const stationById = {};
stations.forEach((s) => { stationById[s.id] = s; });

// ---------------------------------------------------------------- trips
const tripById = {};
tripRows.forEach((r) => { tripById[r.trip_id] = r; });

const stopsOfTrip = {};
stopTimeRows.forEach((r) => {
  (stopsOfTrip[r.trip_id] || (stopsOfTrip[r.trip_id] = [])).push(r);
});

// A "pattern" is a line + direction + the exact station sequence it serves
// (a handful of trips short-turn, so the sequences are not all identical).
// A "profile" is a pattern plus the run times from the trip's own start,
// rounded to 30 s. 2,895 trips collapse into ~130 profiles, so each trip
// only has to store [profileIndex, startTimeInSeconds].
const patternKeys = new Map();   // key -> index
const patterns = [];
const profileKeys = new Map();
const profiles = [];
const trips = {};

Object.keys(stopsOfTrip).forEach((tripId) => {
  const t = tripById[tripId];
  if (!t) return;
  const rows = stopsOfTrip[tripId].sort((a, b) => +a.stop_sequence - +b.stop_sequence);
  const stationSeq = rows.map((r) => parentOf(r.stop_id));
  const pKey = `${t.route_id}|${t.direction_id}|${stationSeq.join(',')}`;
  let pIdx = patternKeys.get(pKey);
  if (pIdx === undefined) {
    pIdx = patterns.length;
    patternKeys.set(pKey, pIdx);
    patterns.push({ line: t.route_id, dir: +t.direction_id, stations: stationSeq });
  }
  const start = hhmmssToSec(rows[0].departure_time);
  const arr = rows.map((r) => Math.round((hhmmssToSec(r.arrival_time) - start) / 30) * 30);
  const dep = rows.map((r) => Math.round((hhmmssToSec(r.departure_time) - start) / 30) * 30);
  const fKey = `${pIdx}|${arr.join(',')}|${dep.join(',')}`;
  let fIdx = profileKeys.get(fKey);
  if (fIdx === undefined) {
    fIdx = profiles.length;
    profileKeys.set(fKey, fIdx);
    profiles.push({ p: pIdx, arr, dep });
  }
  (trips[t.service_id] || (trips[t.service_id] = [])).push([fIdx, start]);
});
Object.values(trips).forEach((list) => list.sort((a, b) => a[1] - b[1]));

// ---------------------------------------------------------------- lines
const lines = routeRows
  .sort((a, b) => (+a.route_sort_order || 0) - (+b.route_sort_order || 0))
  .map((r) => {
    // longest dir-0 pattern = the full station list for the line
    const full = patterns
      .filter((p) => p.line === r.route_id && p.dir === 0)
      .sort((a, b) => b.stations.length - a.stations.length)[0];
    const seq = full ? full.stations : [];
    seq.forEach((id) => {
      if (stationById[id] && !stationById[id].lines.includes(r.route_id)) {
        stationById[id].lines.push(r.route_id);
      }
    });
    return {
      id: r.route_id,
      shortName: r.route_short_name,
      name: r.route_long_name,
      color: '#' + r.route_color,
      textColor: '#' + r.route_text_color,
      stations: seq
    };
  });

// ---------------------------------------------------------------- transfers
// Same-station interchanges (Ameerpet, MG Bus Station) need no entry: they are
// one node. Parade Ground (Blue) and JBS Parade Ground (Green) are ~140 m
// apart in the feed, so they get a short walking link.
const WALK_M_PER_SEC = 1.25;
const transfers = [];
for (let i = 0; i < stations.length; i++) {
  for (let j = i + 1; j < stations.length; j++) {
    const a = stations[i], b = stations[j];
    const sharesLine = a.lines.some((l) => b.lines.includes(l));
    const d = metres(a, b);
    if (!sharesLine && d < 350) {
      const sec = Math.round(d / WALK_M_PER_SEC) + 60; // + exit/entry time
      transfers.push({ from: a.id, to: b.id, m: Math.round(d), sec });
      transfers.push({ from: b.id, to: a.id, m: Math.round(d), sec });
    }
  }
}

// ---------------------------------------------------------------- fares
const priceOf = {};
fareAttr.forEach((f) => { priceOf[f.fare_id] = +f.price; });
const fares = {};
fareRules.forEach((r) => {
  const p = priceOf[r.fare_id];
  if (p !== undefined) fares[`${r.origin_id}>${r.destination_id}`] = p;
});

// ---------------------------------------------------------------- write
const data = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  source: {
    publisher: feedInfo.feed_publisher_name || 'Open Data Telangana',
    url: feedInfo.feed_publisher_url || 'https://data.telangana.gov.in/',
    validFrom: feedInfo.feed_start_date || '',
    validTo: feedInfo.feed_end_date || ''
  },
  calendar: calendarRows.reduce((acc, c) => {
    acc[c.service_id] = [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].map(Number);
    return acc;
  }, {}),
  lines,
  stations,
  transfers,
  patterns,
  profiles,
  trips,
  // Smart card / QR discount advertised by HMRL. Verify before the demo.
  smartCardDiscount: 0.1
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`metro.json written to ${OUT} (${kb} KB)`);
console.log(`  ${lines.length} lines, ${stations.length} stations, ${patterns.length} patterns, ` +
  `${profiles.length} time profiles, ${Object.values(trips).reduce((n, l) => n + l.length, 0)} trips, ` +
  `${Object.keys(fares).length} fare pairs, ${transfers.length / 2} walking interchanges`);

// fares are the biggest block; keep them in a sibling file so the planner can
// load the network first and the fare table lazily.
const fareOut = OUT.replace(/\.json$/, '.fares.json');
fs.writeFileSync(fareOut, JSON.stringify(fares));
console.log(`metro.fares.json written to ${fareOut} (${(fs.statSync(fareOut).size / 1024).toFixed(0)} KB)`);
