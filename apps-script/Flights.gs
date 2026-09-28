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

// baseSeq (client saves only): the seq the device last saw. If the row has moved on since —
// another device or the hourly cron changed it — the save is refused instead of silently
// overwriting the newer data with the device's stale copy. -1 = "new flight"; re-adding a
// previously deleted flight is allowed. Internal callers (cron, calendar) pass no baseSeq.
function upsertFlight_(f, baseSeq) {
  if (!f || !f.id) throw new Error("flight.id required");
  var existing = findRow_(f.id);
  if (existing && baseSeq != null && baseSeq !== "") {
    var base = Number(baseSeq);
    var reAdd = base === -1 && existing.status === "deleted";
    if (!reAdd && Number(existing.seq || 0) > base) return { __conflict: true, current: rowToFlight_(existing) };
  }
  var now = nowIso_();
  var merged = {};
  FLIGHT_COLS.forEach(function (c) {
    merged[c] = f[c] != null ? f[c] : (existing ? existing[c] : "");
  });
  if (existing) {
    logHistory_("upsert", existing);
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

function rowToFlight_(r) {
  var f = {};
  FLIGHT_COLS.forEach(function (c) { f[c] = r[c] == null ? "" : r[c]; });
  return f;
}

// safety net: every overwrite/delete first appends the previous row to the "history" sheet
// (created on first use), so any clobbered value can be copied back by hand.
var HISTORY_COLS_ = ["ts", "action", "id", "seq", "row_json"];
function logHistory_(action, row) {
  try {
    var sh = sheet_("history");
    if (!sh) {
      sh = ss_().insertSheet("history");
      sh.getRange(1, 1, sh.getMaxRows(), HISTORY_COLS_.length).setNumberFormat("@");
      sh.getRange(1, 1, 1, HISTORY_COLS_.length).setValues([HISTORY_COLS_]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    sh.getRange(sh.getLastRow() + 1, 1, 1, HISTORY_COLS_.length).setNumberFormat("@")
      .setValues([[nowIso_(), action, String(row.id), String(row.seq || 0), JSON.stringify(rowToFlight_(row))]]);
  } catch (e) {
    log_("WARN", "history", String(e)); // never block the write itself
  }
}

// history backfill can be hundreds of rows — one sheet read up front, appends batched
// (per-flight readRows_ would blow the 6-minute execution limit)
// onlyNew: skip every id that already has a row (including soft-deleted ones) — used when a
// device connects and uploads flights the Sheet has never seen; it must never overwrite or
// resurrect anything.
function bulkUpsert_(flights, onlyNew) {
  var rows = readRows_("flights");
  var byId = {};
  rows.forEach(function (r) { if (r.id) byId[r.id] = r; });
  var now = nowIso_();
  var created = 0, updated = 0, skipped = 0, errors = [];
  var appends = [];

  flights.forEach(function (f) {
    try {
      if (!f || !f.id) throw new Error("flight.id required");
      var existing = byId[f.id];
      if (existing && onlyNew) { skipped++; return; }
      var merged = {};
      FLIGHT_COLS.forEach(function (c) {
        merged[c] = f[c] != null ? f[c] : (existing ? existing[c] : "");
      });
      if (existing) {
        if (existing.__row) logHistory_("bulkUpsert", existing); // (batch-appended rows have no __row yet)
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
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, FLIGHT_COLS.length)
      .setNumberFormat("@").setValues(appends); // plain text — see writeRow_

  }
  return { created: created, updated: updated, skipped: skipped, errors: errors };
}

function softDelete_(id) {
  var r = findRow_(id);
  if (!r) return;
  logHistory_("delete", r);
  r.status = "deleted";
  r.seq = Number(r.seq || 0) + 1;
  r.updated_at = nowIso_();
  writeRow_("flights", FLIGHT_COLS, r, r.__row);
}
