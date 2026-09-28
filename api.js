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
    if (!f.traveler_role) f.traveler_role = "self"; // legacy/local rows default to "I'm flying"
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

  // ---------- legacy demo data ----------

  // Versions up to 0.2.0 pre-filled three demo flights into on-device storage. On a device that
  // never connected they would be uploaded as real flights on first connect (and resurrect ones
  // deleted in the Sheet), so remove them once while still untouched (seq 0, local mode).
  var LEGACY_DEMO_IDS = ["JX002-20261127-TPE", "JL65-20261206-SAN", "JX801-20261210-NRT"];

  function purgeLegacyDemo() {
    if (!localStorage.getItem(K.seeded)) return;
    if (!hasBackend()) {
      writeJson(K.flights, readJson(K.flights, []).filter(function (f) {
        return !(LEGACY_DEMO_IDS.indexOf(f.id) >= 0 && !Number(f.seq));
      }));
    }
    localStorage.removeItem(K.seeded);
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
    var conflicts = 0;
    var chain = Promise.resolve();
    q.forEach(function (op) {
      chain = chain.then(function () { return gpost(op.action, op.payload); })
        .then(function (res) {
          if (res && !res.ok && res.error === "conflict") {
            conflicts++; // the flight changed elsewhere while this device was offline — newer data wins
          } else if (!res || !res.ok) {
            // a logical failure ({ok:false}) must NOT clear the queue — that would
            // silently drop offline edits (unauthorized, quota, version skew, …)
            throw new Error((res && res.error) || "backend_error");
          }
          writeJson(K.pending, pendingOps().slice(1)); // done with this op: never re-send it
        });
    });
    flushPromise = chain.catch(function () { /* keep the rest of the queue, retry later */ })
      .then(function () {
        flushPromise = null;
        if (conflicts) window.dispatchEvent(new CustomEvent("f46-conflict", { detail: conflicts }));
        notify();
      });
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
      // version this edit is based on: the Sheet refuses the save if it has moved on since
      var prev = localAll().find(function (x) { return x.id === f.id; });
      var base = prev ? (Number(prev.seq) || 0) : -1;
      var saved = localUpsert(f); // optimistic local write in both modes
      if (!hasBackend()) { notify(); return Promise.resolve(saved); }
      return gpost("upsert", { flight: saved, base_seq: base }).then(function (res) {
        if (!res.ok && res.error === "conflict") {
          // someone else's newer version stays; reload it and let the user redo the edit on top
          return refresh().catch(function () {}).then(function () {
            var err = new Error("conflict"); err.code = "conflict"; throw err;
          });
        }
        if (!res.ok) throw new Error(res.error || "upsert failed");
        localReplace(coerceTypes(res.flight)); notify();
        return res.flight;
      }).catch(function (e) {
        if (e instanceof TypeError) { pushPending({ action: "upsert", payload: { flight: saved, base_seq: base } }); notify(); return saved; }
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

    // first connect of a device (Save & sync, connect link): flights that exist only on this device
    // are uploaded BEFORE the local copy is replaced by the Sheet — and only ids the Sheet has never
    // had (onlyNew), so nothing in the Sheet is overwritten or brought back from deleted.
    connectAndMerge: function () {
      var local = visible(localAll());
      return flushPending().then(function () { return gget("list"); }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "list failed");
        var inSheet = {};
        res.flights.forEach(function (f) { inSheet[f.id] = true; });
        var extra = local.filter(function (f) { return !inSheet[f.id]; });
        if (!extra.length) return 0;
        return gpost("bulkUpsert", { flights: extra, onlyNew: true }).then(function (r) {
          if (!r.ok) throw new Error(r.error || "upload failed");
          return r.created || 0;
        });
      }).then(function (uploaded) { return refresh().then(function () { return uploaded; }); });
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

    ontime: function (flightNo, force) {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      var p = { flightNo: flightNo };
      if (force) p.force = "1";
      return gget("ontime", p);
    },

    inbound: function (reg, date, depIata, depLocal, force) {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      if (!reg) return Promise.resolve({ ok: false, error: "no_reg" });
      var p = { reg: reg, date: date, dep: depIata };
      if (depLocal) p.depLocal = depLocal; // omit when empty so it never serializes as "undefined"
      if (force) p.force = "1";
      return gget("inbound", p);
    },

    position: function (reg, callsign, hex) {
      if (!hasBackend()) return Promise.resolve({ ok: false, error: "no_backend" });
      if (!reg && !callsign && !hex) return Promise.resolve({ ok: false, error: "no_identifier" });
      var p = {};
      if (hex) p.hex = hex;
      if (reg) p.reg = reg;
      if (callsign) p.callsign = callsign;
      return gget("position", p);
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

  purgeLegacyDemo();
})();
