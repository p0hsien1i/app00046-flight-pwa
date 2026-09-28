// Util.gs — sheet helpers (header-mapped), time conversion, settings kv, logging.

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function sheet_(name) { return ss_().getSheetByName(name); }

// read a sheet into [{col: value, __row: n}] using the header row.
// Local wall-clock columns (*_time_local / *_revised_local) must never go through a Date:
// if Sheets ever coerced one into a date cell (row appended outside the "@"-formatted grid,
// hand edit), getValues() hands back an instant whose meaning depends on the spreadsheet vs
// script timezone — that round trip shifted every calendar event by the UTC offset of
// America/Los_Angeles (-7 h in summer, -8 h in winter). Read the text the sheet *displays*
// instead: that is exactly what the user sees and what AeroDataBox returned.
var LOCAL_TIME_COL_RE_ = /(_time_local|_revised_local)$/;

function readRows_(name) {
  var sh = sheet_(name);
  var range = sh.getDataRange();
  var values = range.getValues();
  if (values.length < 2) return [];
  var head = values[0].map(String);
  var display = null; // fetched lazily — only needed when a Date cell shows up
  var ssTz = null;
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = { __row: r + 1 };
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = values[r][c];
      if (LOCAL_TIME_COL_RE_.test(head[c])) {
        if (v instanceof Date) {
          display = display || range.getDisplayValues();
          var shown = normLocal_(display[r][c]);
          if (!shown) { // exotic display format — last resort, spreadsheet timezone
            ssTz = ssTz || ss_().getSpreadsheetTimeZone();
            shown = Utilities.formatDate(v, ssTz, "yyyy-MM-dd'T'HH:mm");
          }
          v = shown;
        } else if (v !== "") {
          v = normLocal_(v) || String(v);
        }
      } else if (v instanceof Date) {
        v = v.toISOString();
      }
      o[head[c]] = v === "" ? "" : v;
    }
    out.push(o);
  }
  return out;
}

// "2026-09-23 1:05" / "2026/9/23 01:05:00" / "2026-09-23T01:05" -> "2026-09-23T01:05"; else null.
function normLocal_(s) {
  var m = /^\s*(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T]+(\d{1,2}):(\d{2})/.exec(String(s == null ? "" : s));
  if (!m) return null;
  function z(n) { return ("0" + Number(n)).slice(-2); }
  return m[1] + "-" + z(m[2]) + "-" + z(m[3]) + "T" + z(m[4]) + ":" + m[5];
}

// header check (once per execution per sheet): writeRow_ writes by column POSITION,
// so a hand-reordered header would silently scramble every field — fail loudly instead.
var headerChecked_ = {};
function assertHeader_(name, cols) {
  if (headerChecked_[name]) return;
  var sh = sheet_(name);
  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0].map(String);
  for (var i = 0; i < cols.length; i++) {
    if (head[i] !== cols[i])
      throw new Error("sheet '" + name + "' header mismatch at column " + (i + 1) +
        " (expected '" + cols[i] + "', found '" + head[i] + "') — do not reorder columns; re-run setup()");
  }
  headerChecked_[name] = true;
}

function writeRow_(name, cols, obj, rowIndex) {
  assertHeader_(name, cols);
  var sh = sheet_(name);
  var row = cols.map(function (c) { return obj[c] == null ? "" : obj[c]; });
  // force plain text on the target row every time: setup()'s "@" format only covers the grid
  // that existed back then, and appendRow() past it lets Sheets coerce "2026-09-20T14:05"
  // into a date cell (the root of the calendar timezone shift — see readRows_).
  var at = rowIndex || sh.getLastRow() + 1;
  sh.getRange(at, 1, 1, cols.length).setNumberFormat("@").setValues([row]);
}

// "2026-11-27T23:40" + "Asia/Taipei" -> Date (absolute instant).
// Returns null on empty OR unparseable input — one bad hand-edited cell must not
// take down the whole ICS feed / notification run.
// A missing tz also returns null — never guess UTC (that silently shifts the event).
function parseLocal_(localIso, tz) {
  var norm = normLocal_(localIso);
  if (!norm || !tz) return null;
  try {
    return Utilities.parseDate(norm.replace("T", " "), tz, "yyyy-MM-dd HH:mm");
  } catch (e) { return null; }
}

function icsUtc_(d) { return Utilities.formatDate(d, "UTC", "yyyyMMdd'T'HHmmss'Z'"); }

function nowIso_() { return new Date().toISOString(); }

// shared flight title. Prefix the passenger only for flights someone ELSE is on
// ("[Mom] TG343 BKK-AMD"); my own flights are just "JX002 TPE-LAX".
function flightTitle_(f) {
  var route = f.flight_no + " " + f.dep_iata + "-" + f.arr_iata;
  return (f.traveler_role === "other" && f.passenger) ? "[" + f.passenger + "] " + route : route;
}

// settings sheet as kv store
function getSetting_(key) {
  var rows = readRows_("settings");
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i].value;
  return null;
}

function setSetting_(key, value) {
  var rows = readRows_("settings");
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      writeRow_("settings", ["key", "value", "updated_at"], { key: key, value: String(value), updated_at: nowIso_() }, rows[i].__row);
      return;
    }
  }
  writeRow_("settings", ["key", "value", "updated_at"], { key: key, value: String(value), updated_at: nowIso_() });
}

function bumpCounter_(key, delta) {
  var cur = Number(getSetting_(key) || 0) + delta;
  setSetting_(key, cur);
  return cur;
}

function shortHash_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s));
  return raw.slice(0, 4).map(function (b) { return ("0" + ((b + 256) % 256).toString(16)).slice(-2); }).join("");
}

function log_(level, source, msg) {
  try {
    sheet_("log").appendRow([nowIso_(), level, source, String(msg).slice(0, 800)]);
  } catch (e) { /* never let logging break the request */ }
}

function trimLog_() {
  var sh = sheet_("log");
  var n = sh.getLastRow();
  if (n > 501) sh.deleteRows(2, n - 501);
}
