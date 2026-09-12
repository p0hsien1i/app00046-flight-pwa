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
    airlineName: item.airline && item.airline.name || "",
    airlineIata: item.airline && item.airline.iata || "",
    dep: dep,
    arr: arrv,
    distanceKm: item.greatCircleDistance && Math.round(item.greatCircleDistance.km) || null,
    depUtcMs: depUtc ? new Date(String(depUtc).replace(" ", "T")).getTime() : null,
  };
}
