// Telegram.gs — hourly trigger: check-in reminder (T-24h), day-of summary, delay/gate change alerts.
// Dedupe via notif_log sheet; live API polling only within [dep-48h, dep+2h] every 3rd hour.

// returns true only when Telegram accepted the message — callers must not
// mark a notification as sent (dedupe) unless this returns true.
function sendTelegram_(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("TELEGRAM_BOT_TOKEN");
  var chatId = props.getProperty("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("telegram not configured");
  var resp = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "post",
    payload: { chat_id: chatId, text: text, parse_mode: "HTML" },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    log_("WARN", "telegram", "HTTP " + resp.getResponseCode() + " " + resp.getContentText().slice(0, 200));
    return false;
  }
  return true;
}

// HTML parse_mode: bare < > & in interpolated values would 400 the whole message
function escHtml_(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function notifSent_(key) {
  var rows = readRows_("notif_log");
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return true;
  return false;
}

function markNotif_(key, preview) {
  writeRow_("notif_log", ["key", "sent_at", "message_preview"], {
    key: key, sent_at: nowIso_(), message_preview: String(preview).slice(0, 120),
  });
}

function fmtLocal_(localIso) {
  return localIso ? String(localIso).replace("T", " ") : "?";
}

// run once by hand: installs the hourly trigger
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "cronHourly") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("cronHourly").timeBased().everyHours(1).create();
  log_("INFO", "triggers", "hourly trigger installed");
}

function cronHourly() {
  try {
    var now = Date.now();
    var flights = listFlights_(false).filter(function (f) {
      return f.status === "planned" || f.status === "ticketed" || f.status === "checked-in";
    });

    flights.forEach(function (f) {
      try { // one bad flight must not kill the whole run
        var dep = parseLocal_(f.dep_time_local, f.dep_tz);
        if (!dep) return;
        var depMs = dep.getTime();
        var title = escHtml_(f.flight_no + " " + f.dep_iata + "→" + f.arr_iata);

        // 1) check-in opens (T-24h; late catch-up window down to T-12h)
        if (now >= depMs - 24 * 3600e3 && now < depMs - 12 * 3600e3 && !notifSent_(f.id + ":checkin")) {
          var msg1 = "✅ <b>Check-in opens</b> — " + title +
            "\nDeparts " + escHtml_(fmtLocal_(f.dep_time_local)) + " (" + escHtml_(f.dep_tz) + ")" +
            (f.pnr ? "\nPNR: <code>" + escHtml_(f.pnr) + "</code>" : "");
          if (sendTelegram_(msg1)) markNotif_(f.id + ":checkin", msg1); // else retry next hour
        }

        // 2) day-of summary (from 07:00 local at departure airport, or T-4h for red-eyes)
        var localNow = Utilities.formatDate(new Date(), f.dep_tz, "yyyy-MM-dd HH");
        var depLocalDate = String(f.dep_time_local).slice(0, 10);
        var dayOfWindow = Number(localNow.slice(11)) >= 7 || depMs - now < 4 * 3600e3;
        if (localNow.slice(0, 10) === depLocalDate && dayOfWindow &&
            now < depMs && !notifSent_(f.id + ":dayof")) {
          var parts = [
            "🛫 <b>Flight day</b> — " + title,
            "Departs " + escHtml_(fmtLocal_(f.dep_time_local)) + " (" + escHtml_(f.dep_tz) + ")",
          ];
          if (f.dep_terminal) parts.push("Terminal " + escHtml_(f.dep_terminal) + (f.dep_gate ? " · Gate " + escHtml_(f.dep_gate) : ""));
          if (f.seat) parts.push("Seat " + escHtml_(f.seat));
          if (f.pnr) parts.push("PNR <code>" + escHtml_(f.pnr) + "</code>");
          var msg2 = parts.join("\n");
          if (sendTelegram_(msg2)) markNotif_(f.id + ":dayof", msg2);
        }

        // 3) change detection: within [dep-48h, dep+2h], every 3rd hour, via cached proxy
        if (now >= depMs - 48 * 3600e3 && now <= depMs + 2 * 3600e3 &&
            new Date().getUTCHours() % 3 === 0) {
          var res = flightInfo_(f.flight_no, depLocalDate, false, f.dep_iata);
          if (res.ok && res.data) applyChanges_(f, res.data, title);
        }
      } catch (errFlight) {
        log_("ERROR", "cronHourly/" + (f && f.id), String(errFlight && errFlight.stack || errFlight));
      }
    });

    setSetting_("LAST_CRON_RUN", nowIso_());
    trimLog_();
  } catch (err) {
    log_("ERROR", "cronHourly", String(err && err.stack || err));
  }
}

function applyChanges_(f, d, title) {
  var changes = [];
  if (d.dep) {
    if (d.dep.gate && d.dep.gate !== f.dep_gate) { changes.push("Gate " + (f.dep_gate || "—") + " → " + d.dep.gate); f.dep_gate = d.dep.gate; }
    if (d.dep.terminal && d.dep.terminal !== f.dep_terminal) { changes.push("Terminal " + (f.dep_terminal || "—") + " → " + d.dep.terminal); f.dep_terminal = d.dep.terminal; }
    if (d.dep.revisedLocal && d.dep.revisedLocal !== f.dep_revised_local && d.dep.revisedLocal !== f.dep_time_local) {
      changes.push("Departure " + fmtLocal_(f.dep_time_local) + " → " + fmtLocal_(d.dep.revisedLocal));
      f.dep_revised_local = d.dep.revisedLocal;
    }
  }
  if (d.arr && d.arr.revisedLocal && d.arr.revisedLocal !== f.arr_revised_local && d.arr.revisedLocal !== f.arr_time_local) {
    changes.push("Arrival " + fmtLocal_(f.arr_time_local) + " → " + fmtLocal_(d.arr.revisedLocal));
    f.arr_revised_local = d.arr.revisedLocal;
  }
  if (d.status && d.status !== f.api_status) { f.api_status = d.status; if (/delay|cancel|divert/i.test(d.status)) changes.push("Status: " + d.status); }
  if (d.aircraft && !f.aircraft) f.aircraft = d.aircraft;

  if (!changes.length) return;
  var key = f.id + ":change:" + shortHash_(changes.join("|"));
  upsertFlight_(f); // persist even if this exact change was already notified
  if (notifSent_(key)) return;
  var msg = "⚠️ <b>Flight update</b> — " + title + "\n" + escHtml_(changes.join("\n"));
  if (sendTelegram_(msg)) markNotif_(key, msg);
  try { if (f.gcal_event_id) syncOne_(f); } catch (e) { log_("WARN", "applyChanges/cal", String(e)); }
}
