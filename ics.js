// ics.js — iCalendar generation (RFC 5545). Format contract shared with apps-script/Ics.gs:
// same UID rule ({id}@app00046), METHOD:PUBLISH, UTC times (no VTIMEZONE), SEQUENCE from flight.seq.
(function () {
  "use strict";

  // ---- timezone: local wall time + IANA zone -> UTC Date ----
  function wallTimeInZone(epochMs, tz) {
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    var p = {};
    dtf.formatToParts(epochMs).forEach(function (x) { if (x.type !== "literal") p[x.type] = x.value; });
    var hh = p.hour === "24" ? 0 : +p.hour;
    return Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute);
  }

  // localIso "YYYY-MM-DDTHH:mm", tz "Asia/Taipei" -> Date (UTC instant).
  // Returns null on missing/invalid tz — callers must treat null as "no absolute time",
  // never silently fall back to the device timezone.
  function zonedToUtc(localIso, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localIso || "");
    if (!m || !tz) return null;
    var want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    var utc = want;
    try {
      for (var i = 0; i < 3; i++) {
        var shown = wallTimeInZone(utc, tz);
        if (shown === want) break;
        utc += want - shown;
      }
    } catch (e) { return null; } // unknown IANA name
    return new Date(utc);
  }

  function icsUtc(d) {
    function z(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) +
      "T" + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds()) + "Z";
  }

  // ---- RFC 5545 text escaping & 75-octet folding ----
  function escText(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  var enc = new TextEncoder();
  function foldLine(line) {
    var bytes = enc.encode(line);
    if (bytes.length <= 75) return line;
    var out = [], cur = "", curLen = 0;
    // for...of iterates code points, so surrogate pairs (emoji) are never split mid-character
    for (var ch of line) {
      var chLen = enc.encode(ch).length;
      if (curLen + chLen > 75) {
        out.push(cur);
        cur = " " + ch; curLen = 1 + chLen;
      } else {
        cur += ch; curLen += chLen;
      }
    }
    if (cur) out.push(cur);
    return out.join("\r\n");
  }

  function airportLabel(iata) {
    var a = window.AIRPORTS && window.AIRPORTS[iata];
    return a ? a[0] : iata;
  }

  // ---- VEVENT for one flight ----
  function flightToVevent(f) {
    var dep = zonedToUtc(f.dep_time_local, f.dep_tz);
    var arr = zonedToUtc(f.arr_time_local, f.arr_tz);
    if (!dep || !arr) return null;

    // "[passenger] FLIGHTNO DEP-ARR" — mirrors the backend flightTitle_
    var summary = (f.passenger ? "[" + f.passenger + "] " : "") + f.flight_no + " " + f.dep_iata + "-" + f.arr_iata;
    var locParts = [f.dep_iata];
    if (f.dep_terminal) locParts.push("T" + String(f.dep_terminal).replace(/^T/i, ""));
    var location = locParts.join(" ") + " — " + airportLabel(f.dep_iata);

    var descLines = [];
    if (f.airline_name || f.airline_iata) descLines.push("Airline: " + (f.airline_name || f.airline_iata));
    if (f.status) descLines.push("Status: " + f.status);
    if (f.pnr) descLines.push("PNR: " + f.pnr);
    if (f.seat) descLines.push("Seat: " + f.seat);
    if (f.cabin) descLines.push("Cabin: " + f.cabin);
    if (f.dep_gate) descLines.push("Gate: " + f.dep_gate);
    if (f.arr_terminal || f.arr_gate)
      descLines.push("Arrival: " + [f.arr_terminal ? "T" + String(f.arr_terminal).replace(/^T/i, "") : "", f.arr_gate ? "Gate " + f.arr_gate : ""].filter(Boolean).join(" "));
    if (f.aircraft) descLines.push("Aircraft: " + f.aircraft);
    if (f.notes) descLines.push("Notes: " + f.notes);
    descLines.push("Arrives: " + airportLabel(f.arr_iata));

    var lines = [
      "BEGIN:VEVENT",
      "UID:" + f.id + "@app00046",
      "DTSTAMP:" + icsUtc(f.updated_at ? new Date(f.updated_at) : new Date()),
      "DTSTART:" + icsUtc(dep),
      "DTEND:" + icsUtc(arr),
      "SUMMARY:" + escText(summary),
      "LOCATION:" + escText(location),
      "DESCRIPTION:" + escText(descLines.join("\n")),
      "SEQUENCE:" + (Number(f.seq) || 0),
    ];
    if (f.status === "cancelled") lines.push("STATUS:CANCELLED");
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + escText("Check-in opens — " + summary),
      "TRIGGER:-PT24H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + escText("Departure soon — " + summary),
      "TRIGGER:-PT3H",
      "END:VALARM",
      "END:VEVENT"
    );
    return lines;
  }

  function buildCalendar(flights) {
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
      var ev = flightToVevent(f);
      if (ev) lines = lines.concat(ev);
    });
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
  }

  window.ICS = {
    zonedToUtc: zonedToUtc,
    buildCalendar: buildCalendar,
    exportFlight: function (f) { download(f.id + ".ics", buildCalendar([f])); },
    exportAll: function (flights) { download("flights-app00046.ics", buildCalendar(flights)); },
  };
})();
