// Ics.gs — ICS feed (action=ics). Format contract mirrors front-end ics.js:
// UID {id}@app00046, METHOD:PUBLISH, UTC times, SEQUENCE, CRLF, 75-octet folding.
// Known caveat: Apps Script serves via a 302 to script.googleusercontent.com — some
// calendar clients may not follow it. Primary subscription path is the Flights calendar itself.

function icsEsc_(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function foldIcsLine_(line) {
  if (Utilities.newBlob(line).getBytes().length <= 75) return line;
  var out = [], cur = "", curLen = 0;
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i);
    var chLen = Utilities.newBlob(ch).getBytes().length;
    if (curLen + chLen > 75) { out.push(cur); cur = " " + ch; curLen = 1 + chLen; }
    else { cur += ch; curLen += chLen; }
  }
  if (cur) out.push(cur);
  return out.join("\r\n");
}

function buildIcs_(flights) {
  var lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//app00046//Flight in the Air//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Flights",
  ];
  flights.forEach(function (f) {
    if (f.status === "deleted") return;
    var dep = parseLocal_(f.dep_time_local, f.dep_tz);
    var arr = parseLocal_(f.arr_time_local, f.arr_tz);
    if (!dep || !arr) return;
    var summary = f.flight_no + " · " + f.dep_iata + " → " + f.arr_iata;
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + f.id + "@app00046",
      "DTSTAMP:" + icsUtc_(f.updated_at ? new Date(f.updated_at) : new Date()),
      "DTSTART:" + icsUtc_(dep),
      "DTEND:" + icsUtc_(arr),
      "SUMMARY:" + icsEsc_(summary),
      "LOCATION:" + icsEsc_(f.dep_iata + (f.dep_airport ? " — " + f.dep_airport : "")),
      "DESCRIPTION:" + icsEsc_(eventDesc_(f)),
      "SEQUENCE:" + (Number(f.seq) || 0)
    );
    if (f.status === "cancelled") lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine_).join("\r\n") + "\r\n";
}
