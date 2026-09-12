// api.js — data layer. Two modes:
//  - "local": no backend configured → flights live in localStorage only (M1 mode).
//  - "backend": Google Apps Script backend → localStorage acts as mirror + offline queue.
// POST bodies are sent as text/plain (no custom headers) to avoid CORS preflight — see plan.
(function () {
  "use strict";

  var K = {
    settings: "f46_settings",
    flights: "f46_flights",   // local-mode store AND backend-mode mirror
    syncedAt: "f46_synced_at",
    pending: "f46_pending",
    seeded: "f46_seeded",
  };

  function readJson(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJson(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

  // ---------- helpers ----------

  function mkId(f) {
    var d = (f.dep_time_local || "").slice(0, 10).replace(/-/g, "");
    return (String(f.flight_no || "").toUpperCase().replace(/\s+/g, "") + "-" + d + "-" +
      String(f.dep_iata || "").toUpperCase());
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }

  // fill airport names, tz, distance, duration from AIRPORTS table
  function enrich(f) {
    var dep = window.AIRPORTS[f.dep_iata], arr = window.AIRPORTS[f.arr_iata];
    if (dep) { f.dep_airport = dep[0]; f.dep_tz = f.dep_tz || dep[5]; }
    if (arr) { f.arr_airport = arr[0]; f.arr_tz = f.arr_tz || arr[5]; }
    // recompute both or clear both — never leave a previous route's numbers behind
    if (dep && arr) f.distance_km = haversineKm(dep[3], dep[4], arr[3], arr[4]);
    else f.distance_km = "";
    var d1 = window.ICS.zonedToUtc(f.dep_time_local, f.dep_tz);
    var d2 = window.ICS.zonedToUtc(f.arr_time_local, f.arr_tz);
    f.duration_min = (d1 && d2) ? Math.round((d2 - d1) / 60000) : "";
    if (f.airline_iata && !f.airline_name && window.AIRLINES[f.airline_iata])
      f.airline_name = window.AIRLINES[f.airline_iata];
    return f;
  }

  // backend (Sheets) returns every cell as a string — coerce numeric fields back
  function coerceTypes(f) {
    ["distance_km", "duration_min", "seq"].forEach(function (k) {
      if (f[k] === "" || f[k] == null) return;
      var n = Number(f[k]);
      f[k] = isNaN(n) ? "" : n;
    });
    return f;
  }

  // ---------- seed ----------

  var SEED = [
    {
      flight_no: "JX002", airline_iata: "JX", airline_name: "STARLUX Airlines",
      dep_iata: "TPE", arr_iata: "LAX",
      dep_time_local: "2026-11-27T23:40", arr_time_local: "2026-11-27T19:00",
      status: "ticketed", pnr: "ECEO8P", passenger: "Brian Li",
      notes: "Arrival 19:00 per itinerary (one source says 20:00) — confirm on STARLUX site before travel.",
    },
    {
      flight_no: "JL65", airline_iata: "JL", airline_name: "Japan Airlines",
      dep_iata: "SAN", arr_iata: "NRT",
      dep_time_local: "2026-12-06T11:40", arr_time_local: "2026-12-07T16:40",
      status: "planned", passenger: "Brian Li",
      notes: "Not ticketed yet. JAL winter schedule may move 11:40 → 12:40.",
    },
    {
      flight_no: "JX801", airline_iata: "JX", airline_name: "STARLUX Airlines",
      dep_iata: "NRT", arr_iata: "TPE",
      dep_time_local: "2026-12-10T13:45", arr_time_local: "2026-12-10T16:50",
      status: "planned", passenger: "Brian Li", notes: "Not ticketed yet. Two passengers.",
    },
  ];

  function seedIfNeeded() {
    if (localStorage.getItem(K.seeded)) return;
    var flights = readJson(K.flights, []);
    if (flights.length === 0) {
      var now = new Date().toISOString();
      SEED.forEach(function (s) {
        var f = enrich(Object.assign({}, s));
        f.id = mkId(f); f.seq = 0; f.created_at = now; f.updated_at = now;
        flights.push(f);
      });
      writeJson(K.flights, flights);
    }
    localStorage.setItem(K.seeded, "1");
  }

  // ---------- local store ops (also used as mirror ops) ----------

  function localAll() { return readJson(K.flights, []); }
  function localWrite(flights) { writeJson(K.flights, flights); }

  function localUpsert(f) {
    var flights = localAll();
    var i = flights.findIndex(function (x) { return x.id === f.id; });
    var now = new Date().toISOString();
    if (i >= 0) {
      f.seq = (Number(flights[i].seq) || 0) + 1;
      f.created_at = flights[i].created_at || now;
      f.updated_at = now;
      flights[i] = f;
    } else {
      f.seq = 0; f.created_at = now; f.updated_at = now;
      flights.push(f);
    }
    localWrite(flights);
    return f;
  }

  // replace the mirror copy verbatim (backend echo) — no seq bump, no timestamp touch
  function localReplace(f) {
    var flights = localAll();
    var i = flights.findIndex(function (x) { return x.id === f.id; });
    if (i >= 0) flights[i] = f; else flights.push(f);
    localWrite(flights);
  }

  function localDelete(id) {
    var flights = localAll();
    var i = flights.findIndex(function (x) { return x.id === id; });
    if (i >= 0) {
      flights[i].status = "deleted";
      flights[i].seq = (flights[i].seq || 0) + 1;
      flights[i].updated_at = new Date().toISOString();
      localWrite(flights);
    }
  }

  // ---------- backend transport ----------

  function settings() { return readJson(K.settings, {}); }
  function hasBackend() { var s = settings(); return !!(s.backendUrl && s.token); }

  function gget(action, params) {
    var s = settings();
    var q = new URLSearchParams(Object.assign({ action: action, token: s.token }, params || {}));
    return fetch(s.backendUrl + "?" + q.toString()).then(function (r) { return r.json(); });
  }

  function gpost(action, payload) {
    var s = settings();
    var body = JSON.stringify(Object.assign({ action: action, token: s.token }, payload || {}));
    // no Content-Type header on purpose (text/plain avoids CORS preflight)
    return fetch(s.backendUrl, { method: "POST", body: body }).then(function (r) { return r.json(); });
  }

  // ---------- offline queue (backend mode) ----------

  function pendingOps() { return readJson(K.pending, []); }
  function pushPending(op) { var q = pendingOps(); q.push(op); writeJson(K.pending, q); }

  var flushPromise = null;
  function flushPending() {
    if (flushPromise) return flushPromise;
    if (!hasBackend()) return Promise.resolve();
    var q = pendingOps();
    if (!q.length) return Promise.resolve();
    var chain = Promise.resolve();
    q.forEach(function (op) {
      chain = chain.then(function () { return gpost(op.action, op.payload); })
        .then(function (res) {
          // a logical failure ({ok:false}) must NOT clear the queue — that would
          // silently drop offline edits (unauthorized, quota, version skew, …)
          if (!res || !res.ok) throw new Error((res && res.error) || "backend_error");
        });
    });
    flushPromise = chain.then(function () {
      writeJson(K.pending, []);
    }).catch(function () { /* keep queue, retry later */ })
      .then(function () { flushPromise = null; notify(); });
    return flushPromise;
  }

  window.addEventListener("online", function () { flushPending().then(refresh); });

  // ---------- change notification ----------

  var listeners = [];
  function notify() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }

  // ---------- public API ----------

  function visible(flights) {
    return flights.filter(function (f) { return f.status !== "deleted"; });
  }

  function refresh() {
    if (!hasBackend()) return Promise.resolve(visible(localAll()));
    return gget("list").then(function (res) {
      if (!res.ok) throw new Error(res.error || "list failed");
      writeJson(K.flights, res.flights.map(coerceTypes));
      localStorage.setItem(K.syncedAt, new Date().toISOString());
      notify();
      return res.flights;
    });
  }

  window.API = {
    mode: function () { return hasBackend() ? "backend" : "local"; },
    getSettings: settings,
    saveSettings: function (s) { writeJson(K.settings, s); },
    onChange: function (cb) { listeners.push(cb); },
    enrich: enrich,
    mkId: mkId,
    haversineKm: haversineKm,

    flights: function () { return visible(localAll()); },
    allRaw: localAll,
    syncedAt: function () { return localStorage.getItem(K.syncedAt); },
    pendingCount: function () { return pendingOps().length; },
    refresh: refresh,
    flushPending: flushPending,

    upsert: function (f) {
      enrich(f);
      if (!f.id) f.id = mkId(f);
      var saved = localUpsert(f); // optimistic local write in both modes
      if (!hasBackend()) { notify(); return Promise.resolve(saved); }
      return gpost("upsert", { flight: saved }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "upsert failed");
        localReplace(coerceTypes(res.flight)); notify();
        return res.flight;
      }).catch(function (e) {
        if (e instanceof TypeError) { pushPending({ action: "upsert", payload: { flight: saved } }); notify(); return saved; }
        throw e;
      });
    },

    remove: function (id) {
      localDelete(id);
      if (!hasBackend()) { notify(); return Promise.resolve(); }
      return gpost("delete", { id: id }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "delete failed");
        notify();
      }).catch(function (e) {
        if (e instanceof TypeError) { pushPending({ action: "delete", payload: { id: id } }); notify(); return; }
        throw e;
      });
    },

    bulkUpsert: function (flights) {
      var prepared;
      try {
        prepared = flights.map(function (f) { enrich(f); if (!f.id) f.id = mkId(f); return f; });
      } catch (e) { return Promise.reject(e); } // surface bad input to the caller's .catch
      if (!hasBackend()) {
        var created = 0, updated = 0;
        var existing = localAll();
        prepared.forEach(function (f) {
          var isNew = !existing.some(function (x) { return x.id === f.id; });
          localUpsert(f); if (isNew) created++; else updated++;
        });
        notify();
        return Promise.resolve({ ok: true, created: created, updated: updated });
      }
      return gpost("bulkUpsert", { flights: prepared }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "bulk import failed");
        return refresh().then(function () { return res; });
      });
    },

    ping: function () {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      return gget("ping");
    },

    flightinfo: function (flightNo, date, depIata, force) {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      var p = { flightNo: flightNo, date: date };
      if (depIata) p.dep = depIata; // disambiguates multi-leg flight numbers
      if (force) p.force = "1";
      return gget("flightinfo", p);
    },

    syncCalendar: function (idOrAll) {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      var payload = idOrAll === true ? { all: true } : { id: idOrAll };
      return gpost("syncCalendar", payload);
    },

    testTelegram: function () {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      return gpost("testTelegram", {});
    },

    icsFeedUrl: function () {
      if (!hasBackend()) return null;
      var s = settings();
      return s.backendUrl + "?action=ics&token=" + encodeURIComponent(s.token);
    },
  };

  seedIfNeeded();
})();
