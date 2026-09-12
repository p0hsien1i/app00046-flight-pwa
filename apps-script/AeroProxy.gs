// AeroProxy.gs — AeroDataBox (RapidAPI) proxy with cache + quota guards.
// Free tier: 600 units/month; flight-status endpoint costs 2 units per call.
// Guards: monthly cap 500 units, daily cap 20 live calls, cache TTL by time-to-departure.

var AERO_HOST = "aerodatabox.p.rapidapi.com";
var MONTHLY_UNIT_CAP = 500;
var DAILY_CALL_CAP = 20;

function cacheKey_(flightNo, dateStr, depIata) {
  return String(flightNo).toUpperCase() + "-" + dateStr + (depIata ? "-" + String(depIata).toUpperCase() : "");
}

function monthKey_() { return "UNITS_" + Utilities.formatDate(new Date(), "UTC", "yyyy-MM"); }
function dayKey_() { return "LIVE_CALLS_" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd"); }

function readCache_(key) {
  var rows = readRows_("api_cache");
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i];
  return null;
}

function writeCache_(key, payloadJson, units) {
  var existing = readCache_(key);
  var row = { key: key, fetched_at: nowIso_(), units_spent: units, payload_json: payloadJson };
  writeRow_("api_cache", ["key", "fetched_at", "units_spent", "payload_json"], row, existing ? existing.__row : null);
}

// TTL by proximity to departure: >48h out → cache is authoritative; 48–6h → 6h; <6h → 30min
function cacheTtlMs_(depMs) {
  var untilDep = depMs - Date.now();
  if (untilDep > 48 * 3600e3) return Infinity;
  if (untilDep > 6 * 3600e3) return 6 * 3600e3;
  return 30 * 60e3;
}

function flightInfo_(flightNo, dateStr, force, depIata) {
  if (!flightNo || !dateStr) return { ok: false, error: "missing_params" };
  var key = cacheKey_(flightNo, dateStr, depIata);
  var cached = readCache_(key);
  var payload = cached && cached.payload_json ? JSON.parse(cached.payload_json) : null;

  if (cached && !force) {
    if (payload && payload.__negative) {
      if (Date.now() - new Date(cached.fetched_at).getTime() < 3600e3)
        return { ok: false, error: "not_found", cached: true };
    } else if (payload) {
      var depMs = payload.depUtcMs || (Date.now() + 100 * 24 * 3600e3);
      if (Date.now() - new Date(cached.fetched_at).getTime() < cacheTtlMs_(depMs))
        return { ok: true, cached: true, fetched_at: cached.fetched_at, data: payload };
    }
  }

  // quota guards (before any live call)
  var units = Number(getSetting_(monthKey_()) || 0);
  if (units >= MONTHLY_UNIT_CAP)
    return payload && !payload.__negative
      ? { ok: true, cached: true, stale: true, error: "monthly_quota", data: payload }
      : { ok: false, error: "monthly_quota" };
  var calls = Number(getSetting_(dayKey_()) || 0);
  if (calls >= DAILY_CALL_CAP)
    return payload && !payload.__negative
      ? { ok: true, cached: true, stale: true, error: "daily_cap", data: payload }
      : { ok: false, error: "daily_cap" };

  var apiKey = PropertiesService.getScriptProperties().getProperty("RAPIDAPI_KEY");
  if (!apiKey) return { ok: false, error: "no_api_key" };

  var url = "https://" + AERO_HOST + "/flights/number/" +
    encodeURIComponent(String(flightNo).toUpperCase()) + "/" + encodeURIComponent(dateStr) +
    "?dateLocalRole=Departure&withAircraftImage=false&withLocation=false";
  var resp = UrlFetchApp.fetch(url, {
    headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": AERO_HOST },
    muteHttpExceptions: true,
  });
  bumpCounter_(dayKey_(), 1);
  bumpCounter_(monthKey_(), 2); // flight-status endpoint = 2 units

  var code = resp.getResponseCode();
  if (code === 404 || code === 204) {
    writeCache_(key, JSON.stringify({ __negative: true }), 2);
    return { ok: false, error: "not_found" };
  }
  if (code !== 200) {
    log_("WARN", "aero", "HTTP " + code + " " + resp.getContentText().slice(0, 200));
    return { ok: false, error: "http_" + code };
  }

  var data = normalizeAero_(JSON.parse(resp.getContentText()), dateStr, depIata);
  if (!data) {
    writeCache_(key, JSON.stringify({ __negative: true }), 2);
    return { ok: false, error: "not_found" };
  }
  writeCache_(key, JSON.stringify(data), 2);
  return { ok: true, cached: false, fetched_at: nowIso_(), data: data };
}

// pick the right leg: same flight number can have multiple legs (A→B→C) on one date,
// so match departure airport first, then date, then fall back to the first entry
function normalizeAero_(arr, dateStr, depIata) {
  if (!arr || !arr.length) return null;
  var item = null;
  var want = depIata ? String(depIata).toUpperCase() : null;
  for (var i = 0; i < arr.length && want; i++) {
    var ap = arr[i].departure && arr[i].departure.airport && arr[i].departure.airport.iata;
    var sched0 = arr[i].departure && arr[i].departure.scheduledTime && arr[i].departure.scheduledTime.local;
    if (ap && String(ap).toUpperCase() === want &&
        (!sched0 || String(sched0).slice(0, 10) === dateStr)) { item = arr[i]; break; }
  }
  for (var j = 0; j < arr.length && !item; j++) {
    var sched = arr[j].departure && arr[j].departure.scheduledTime && arr[j].departure.scheduledTime.local;
    if (sched && String(sched).slice(0, 10) === dateStr) { item = arr[j]; }
  }
  if (!item) item = arr[0];

  function t(x) { return x ? String(x).slice(0, 16).replace(" ", "T") : ""; }
  function side(s) {
    if (!s) return {};
    return {
      iata: s.airport && s.airport.iata || "",
      terminal: s.terminal || "",
      gate: s.gate || "",
      baggageBelt: s.baggageBelt || "",
      schedLocal: t(s.scheduledTime && s.scheduledTime.local),
      revisedLocal: t(s.revisedTime && s.revisedTime.local),
    };
  }
  var dep = side(item.departure), arrv = side(item.arrival);
  var depUtc = item.departure && item.departure.scheduledTime && item.departure.scheduledTime.utc;
  return {
    status: item.status || "",
    aircraft: item.aircraft && item.aircraft.model || "",
    aircraftReg: item.aircraft && (item.aircraft.reg || item.aircraft.registration) || "",
    aircraftModeS: item.aircraft && item.aircraft.modeS || "", // ICAO 24-bit hex, for ADS-B lookup
    airlineName: item.airline && item.airline.name || "",
    airlineIata: item.airline && item.airline.iata || "",
    dep: dep,
    arr: arrv,
    distanceKm: item.greatCircleDistance && Math.round(item.greatCircleDistance.km) || null,
    depUtcMs: depUtc ? new Date(String(depUtc).replace(" ", "T")).getTime() : null,
  };
}

// ---------- shared helpers for the statistics/registration endpoints ----------

function apiKey_() { return PropertiesService.getScriptProperties().getProperty("RAPIDAPI_KEY"); }

// returns an error object if a live call of `cost` units must be blocked, else null
function quotaBlock_(cost) {
  if (Number(getSetting_(monthKey_()) || 0) + cost > MONTHLY_UNIT_CAP) return { ok: false, error: "monthly_quota" };
  if (Number(getSetting_(dayKey_()) || 0) >= DAILY_CALL_CAP) return { ok: false, error: "daily_cap" };
  return null;
}

function aeroGet_(path, cost) {
  var key = apiKey_();
  if (!key) return { code: 0, err: "no_api_key" };
  var resp = UrlFetchApp.fetch("https://" + AERO_HOST + path, {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": AERO_HOST },
    muteHttpExceptions: true,
  });
  bumpCounter_(dayKey_(), 1);
  bumpCounter_(monthKey_(), cost);
  return { code: resp.getResponseCode(), text: resp.getContentText() };
}

// "[-]hh:mm:ss" time-span -> minutes (negative = early)
function spanToMin_(s) {
  if (!s) return null;
  var neg = String(s).charAt(0) === "-";
  var m = /(\d+):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  var min = (+m[1]) * 60 + (+m[2]) + (+m[3]) / 60;
  return neg ? -min : min;
}

// ---------- on-time / delay history: /flights/{number}/delays (TIER 3 = 6 units) ----------
var DELAY_COST = 6;

function flightDelays_(flightNo, force) {
  if (!flightNo) return { ok: false, error: "missing_params" };
  var key = "delays:" + String(flightNo).toUpperCase();
  var cached = readCache_(key);
  var payload = cached && cached.payload_json ? JSON.parse(cached.payload_json) : null;
  // long TTL: historical stats change slowly
  if (cached && !force) {
    if (payload && payload.__negative) {
      if (Date.now() - new Date(cached.fetched_at).getTime() < 24 * 3600e3)
        return { ok: false, error: "not_found", cached: true };
    } else if (payload && Date.now() - new Date(cached.fetched_at).getTime() < 7 * 24 * 3600e3) {
      return { ok: true, cached: true, fetched_at: cached.fetched_at, data: payload };
    }
  }
  var blk = quotaBlock_(DELAY_COST);
  if (blk) return payload && !payload.__negative ? { ok: true, cached: true, stale: true, error: blk.error, data: payload } : blk;

  var r = aeroGet_("/flights/" + encodeURIComponent(String(flightNo).toUpperCase()) + "/delays", DELAY_COST);
  if (r.err) return { ok: false, error: r.err };
  if (r.code === 404 || r.code === 204) { writeCache_(key, JSON.stringify({ __negative: true }), DELAY_COST); return { ok: false, error: "not_found" }; }
  if (r.code !== 200) { log_("WARN", "aero/delays", "HTTP " + r.code + " " + r.text.slice(0, 150)); return { ok: false, error: "http_" + r.code }; }

  var data = normalizeDelays_(JSON.parse(r.text));
  if (!data) { writeCache_(key, JSON.stringify({ __negative: true }), DELAY_COST); return { ok: false, error: "not_found" }; }
  writeCache_(key, JSON.stringify(data), DELAY_COST);
  return { ok: true, cached: false, fetched_at: nowIso_(), data: data };
}

// prefer arrival-side stats (what makes you late); fall back to departure
function normalizeDelays_(leg) {
  if (!leg) return null;
  var arr = leg.destinations && leg.destinations[0];
  var dep = leg.origins && leg.origins[0];
  var c = arr || dep;
  if (!c) return null;
  var basis = arr ? "arrival" : "departure";
  var median = spanToMin_(c.medianDelay);
  // on-time = share of flights delayed < 15 min (industry standard), from the brackets
  var onTimePct = null, total = c.numConsideredFlights || 0;
  if (total && c.numFlightsDelayedBrackets) {
    var onTime = 0, ok = true;
    c.numFlightsDelayedBrackets.forEach(function (b) {
      var to = spanToMin_(b.delayedTo);
      // brackets fully at/under +15 min (or early) count as on-time; open-ended top bracket => not on-time
      if (b.delayedTo != null && to != null && to <= 15) onTime += (b.num || 0);
    });
    onTimePct = Math.round(onTime / total * 100);
    if (isNaN(onTimePct)) { onTimePct = null; ok = false; }
  }
  return {
    basis: basis,
    medianDelayMin: median == null ? null : Math.round(median),
    onTimePct: onTimePct,
    samples: total,
  };
}

// ---------- inbound aircraft: which flight brings the plane in (needs registration) ----------
var INBOUND_COST = 2;

function inbound_(reg, dateStr, depIata, depLocalIso, force) {
  if (!reg) return { ok: false, error: "no_reg" };
  if (!dateStr || !depIata) return { ok: false, error: "missing_params" };
  var key = "inbound:" + String(reg).toUpperCase() + "-" + dateStr + "-" + String(depIata).toUpperCase();
  var cached = readCache_(key);
  var payload = cached && cached.payload_json ? JSON.parse(cached.payload_json) : null;
  if (cached && !force && payload) {
    if (payload.__negative && Date.now() - new Date(cached.fetched_at).getTime() < 3600e3)
      return { ok: false, error: "no_inbound", cached: true };
    if (!payload.__negative && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 60e3)
      return { ok: true, cached: true, data: payload };
  }
  var blk = quotaBlock_(INBOUND_COST);
  if (blk) return payload && !payload.__negative ? { ok: true, cached: true, stale: true, error: blk.error, data: payload } : blk;

  var r = aeroGet_("/flights/reg/" + encodeURIComponent(String(reg).toUpperCase()) + "/" + encodeURIComponent(dateStr) +
    "?withAircraftImage=false&withLocation=false", INBOUND_COST);
  if (r.err) return { ok: false, error: r.err };
  if (r.code === 404 || r.code === 204) { writeCache_(key, JSON.stringify({ __negative: true }), INBOUND_COST); return { ok: false, error: "no_inbound" }; }
  if (r.code !== 200) { log_("WARN", "aero/reg", "HTTP " + r.code + " " + r.text.slice(0, 150)); return { ok: false, error: "http_" + r.code }; }

  var legs = JSON.parse(r.text);
  if (!legs || !legs.length) { writeCache_(key, JSON.stringify({ __negative: true }), INBOUND_COST); return { ok: false, error: "no_inbound" }; }

  var depMs = depLocalIso ? new Date(String(depLocalIso).replace(" ", "T")).getTime() : null;
  var want = String(depIata).toUpperCase();
  var best = null, bestArrMs = -1;
  legs.forEach(function (lg) {
    var aIata = lg.arrival && lg.arrival.airport && lg.arrival.airport.iata;
    if (!aIata || String(aIata).toUpperCase() !== want) return; // must arrive at our departure airport
    var aLocal = lg.arrival && lg.arrival.scheduledTime && (lg.arrival.scheduledTime.local || lg.arrival.scheduledTime.utc);
    var aMs = aLocal ? new Date(String(aLocal).replace(" ", "T")).getTime() : null;
    if (aMs == null) return;
    if (depMs != null && aMs > depMs) return;         // must land before our departure
    if (aMs > bestArrMs) { bestArrMs = aMs; best = lg; } // latest such arrival = the immediate inbound
  });
  if (!best) { writeCache_(key, JSON.stringify({ __negative: true }), INBOUND_COST); return { ok: false, error: "no_inbound" }; }

  function t(x) { return x ? String(x).slice(0, 16).replace(" ", "T") : ""; }
  var data = {
    flightNo: best.number || "",
    fromIata: best.departure && best.departure.airport && best.departure.airport.iata || "",
    schedArrLocal: t(best.arrival && best.arrival.scheduledTime && best.arrival.scheduledTime.local),
    revisedArrLocal: t(best.arrival && best.arrival.revisedTime && best.arrival.revisedTime.local),
    status: best.status || "",
    bufferMin: depMs != null && bestArrMs > 0 ? Math.round((depMs - bestArrMs) / 60000) : null,
  };
  writeCache_(key, JSON.stringify(data), INBOUND_COST);
  return { ok: true, cached: false, data: data };
}
