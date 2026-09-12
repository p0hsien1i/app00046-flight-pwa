// Code.gs — router, auth, JSON envelope, setup().
// Deploy: Web app, Execute as Me, Access: Anyone. After ANY code change: Deploy > Manage deployments > edit > New version.

var SPREADSHEET_ID = "PASTE_SPREADSHEET_ID_HERE"; // app00046-flights-db

var FLIGHT_COLS = [
  "id", "flight_no", "airline_iata", "airline_name",
  "dep_iata", "dep_airport", "arr_iata", "arr_airport",
  "dep_time_local", "arr_time_local", "dep_tz", "arr_tz",
  "dep_terminal", "dep_gate", "arr_terminal", "arr_gate",
  "status", "pnr", "seat", "cabin", "passenger", "aircraft", "notes",
  "distance_km", "duration_min", "seq", "gcal_event_id",
  "api_status", "dep_revised_local", "arr_revised_local",
  "created_at", "updated_at",
];

function doGet(e) {
  try {
    var p = e.parameter || {};
    var action = p.action || "";
    if (action === "ping")
      return json_({ ok: true, version: "1.0", time: new Date().toISOString() });
    if (!checkToken_(p.token)) return json_({ ok: false, error: "unauthorized" });

    if (action === "list") return json_({ ok: true, flights: listFlights_(false) });
    if (action === "get") {
      var f = getFlight_(p.id);
      return f ? json_({ ok: true, flight: f }) : json_({ ok: false, error: "not_found" });
    }
    if (action === "ics")
      return ContentService.createTextOutput(buildIcs_(listFlights_(false)))
        .setMimeType(ContentService.MimeType.ICAL);
    if (action === "flightinfo")
      return json_(flightInfo_(p.flightNo, p.date, p.force === "1"));
    return json_({ ok: false, error: "unknown_action" });
  } catch (err) {
    log_("ERROR", "doGet", String(err && err.stack || err));
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    if (!checkToken_(body.token)) return json_({ ok: false, error: "unauthorized" });
    lock.waitLock(10000);

    var action = body.action || "";
    if (action === "upsert") {
      var saved = upsertFlight_(body.flight);
      return json_({ ok: true, flight: saved });
    }
    if (action === "bulkUpsert") {
      var res = bulkUpsert_(body.flights || []);
      return json_({ ok: true, created: res.created, updated: res.updated, errors: res.errors });
    }
    if (action === "delete") {
      softDelete_(body.id);
      try { removeCalendarEvent_(body.id); } catch (err2) { log_("WARN", "delete/cal", String(err2)); }
      return json_({ ok: true });
    }
    if (action === "syncCalendar") {
      var out = body.all ? syncAllCalendar_() : syncCalendarById_(body.id);
      return json_(out);
    }
    if (action === "testTelegram") {
      sendTelegram_("✈️ app00046 test message — backend is alive (" + new Date().toISOString() + ")");
      return json_({ ok: true });
    }
    return json_({ ok: false, error: "unknown_action" });
  } catch (err) {
    log_("ERROR", "doPost", String(err && err.stack || err));
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function checkToken_(token) {
  var want = PropertiesService.getScriptProperties().getProperty("API_TOKEN");
  return want && token === want;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run once by hand after pasting the code: creates all sheets + headers, forces plain-text format.
function setup() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var specs = {
    flights: FLIGHT_COLS,
    settings: ["key", "value", "updated_at"],
    api_cache: ["key", "fetched_at", "units_spent", "payload_json"],
    notif_log: ["key", "sent_at", "message_preview"],
    log: ["ts", "level", "source", "msg"],
  };
  Object.keys(specs).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange("A:AZ").setNumberFormat("@"); // keep ISO strings as strings
    sh.getRange(1, 1, 1, specs[name].length).setValues([specs[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  });
  var sheet1 = ss.getSheetByName("Sheet1") || ss.getSheetByName("工作表1");
  if (sheet1 && ss.getSheets().length > 5) ss.deleteSheet(sheet1);
  log_("INFO", "setup", "sheets initialised");
}
