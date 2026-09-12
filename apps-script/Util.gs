// Util.gs — sheet helpers (header-mapped), time conversion, settings kv, logging.

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function sheet_(name) { return ss_().getSheetByName(name); }

// read a sheet into [{col: value, __row: n}] using the header row
function readRows_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(String);
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = { __row: r + 1 };
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = values[r][c];
      o[head[c]] = v === "" ? "" : (v instanceof Date ? v.toISOString() : v);
    }
    out.push(o);
  }
  return out;
}

function writeRow_(name, cols, obj, rowIndex) {
  var sh = sheet_(name);
  var row = cols.map(function (c) { return obj[c] == null ? "" : obj[c]; });
  if (rowIndex) sh.getRange(rowIndex, 1, 1, cols.length).setValues([row]);
  else sh.appendRow(row);
}

// "2026-11-27T23:40" + "Asia/Taipei" -> Date (absolute instant)
function parseLocal_(localIso, tz) {
  if (!localIso) return null;
  return Utilities.parseDate(String(localIso).replace("T", " ").slice(0, 16), tz || "UTC", "yyyy-MM-dd HH:mm");
}

function icsUtc_(d) { return Utilities.formatDate(d, "UTC", "yyyyMMdd'T'HHmmss'Z'"); }

function nowIso_() { return new Date().toISOString(); }

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
