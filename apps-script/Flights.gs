// Flights.gs — flights sheet CRUD (soft delete, seq bump, header-mapped).

function listFlights_(includeDeleted) {
  var rows = readRows_("flights");
  var out = [];
  rows.forEach(function (r) {
    if (!r.id) return;
    if (!includeDeleted && r.status === "deleted") return;
    var f = {};
    FLIGHT_COLS.forEach(function (c) { f[c] = r[c] == null ? "" : r[c]; });
    out.push(f);
  });
  return out;
}

function findRow_(id) {
  var rows = readRows_("flights");
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

function getFlight_(id) {
  var r = findRow_(id);
  if (!r || r.status === "deleted") return null;
  var f = {};
  FLIGHT_COLS.forEach(function (c) { f[c] = r[c] == null ? "" : r[c]; });
  return f;
}

function upsertFlight_(f) {
  if (!f || !f.id) throw new Error("flight.id required");
  var existing = findRow_(f.id);
  var now = nowIso_();
  var merged = {};
  FLIGHT_COLS.forEach(function (c) {
    merged[c] = f[c] != null ? f[c] : (existing ? existing[c] : "");
  });
  if (existing) {
    merged.seq = Number(existing.seq || 0) + 1;
    merged.created_at = existing.created_at || now;
    if (!f.gcal_event_id) merged.gcal_event_id = existing.gcal_event_id || "";
    merged.updated_at = now;
    writeRow_("flights", FLIGHT_COLS, merged, existing.__row);
  } else {
    merged.seq = Number(f.seq || 0);
    merged.created_at = now;
    merged.updated_at = now;
    writeRow_("flights", FLIGHT_COLS, merged);
  }
  return merged;
}

// history backfill can be hundreds of rows — one sheet read up front, appends batched
// (per-flight readRows_ would blow the 6-minute execution limit)
function bulkUpsert_(flights) {
  var rows = readRows_("flights");
  var byId = {};
  rows.forEach(function (r) { if (r.id) byId[r.id] = r; });
  var now = nowIso_();
  var created = 0, updated = 0, errors = [];
  var appends = [];

  flights.forEach(function (f) {
    try {
      if (!f || !f.id) throw new Error("flight.id required");
      var existing = byId[f.id];
      var merged = {};
      FLIGHT_COLS.forEach(function (c) {
        merged[c] = f[c] != null ? f[c] : (existing ? existing[c] : "");
      });
      if (existing) {
        merged.seq = Number(existing.seq || 0) + 1;
        merged.created_at = existing.created_at || now;
        if (!f.gcal_event_id) merged.gcal_event_id = existing.gcal_event_id || "";
        merged.updated_at = now;
        writeRow_("flights", FLIGHT_COLS, merged, existing.__row);
        updated++;
      } else {
        merged.seq = 0; merged.created_at = now; merged.updated_at = now;
        appends.push(FLIGHT_COLS.map(function (c) { return merged[c] == null ? "" : merged[c]; }));
        byId[f.id] = merged; // duplicates inside one batch update instead of double-append
        created++;
      }
    } catch (e) {
      errors.push({ id: f && f.id, error: String(e) });
    }
  });

  if (appends.length) {
    assertHeader_("flights", FLIGHT_COLS);
    var sh = sheet_("flights");
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, FLIGHT_COLS.length).setValues(appends);
  }
  return { created: created, updated: updated, errors: errors };
}

function softDelete_(id) {
  var r = findRow_(id);
  if (!r) return;
  r.status = "deleted";
  r.seq = Number(r.seq || 0) + 1;
  r.updated_at = nowIso_();
  writeRow_("flights", FLIGHT_COLS, r, r.__row);
}
