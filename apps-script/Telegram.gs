// Telegram.gs — hourly trigger: check-in reminder (T-24h), day-of summary, delay/gate change alerts.
// Dedupe via notif_log sheet; live API polling only within [dep-48h, dep+2h] every 3rd hour.

// returns true only when Telegram accepted the message — callers must not
// mark a notification as sent (dedupe) unless this returns true.
// chatId optional: route a flight's alerts to a pickup contact instead of the owner.
function sendTelegram_(text, chatId) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("TELEGRAM_BOT_TOKEN");
  chatId = chatId || props.getProperty("TELEGRAM_CHAT_ID");
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

// per-flight notification delivery target (blank -> owner default)
function notifyTarget_(f) { return (f.notify_chat_id && String(f.notify_chat_id).trim()) || null; }

// notify_prefs: "" = all on (default), "none" = all off, else comma list of enabled keys
function prefOn_(f, key) {
  var p = (f.notify_prefs || "").trim();
  if (!p) return true;
  if (p === "none") return false;
  return ("," + p + ",").indexOf("," + key + ",") >= 0;
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
        var arr = parseLocal_(f.arr_time_local, f.arr_tz);
        var arrMs = arr ? arr.getTime() : depMs + 3 * 3600e3;
        var isOther = (f.traveler_role || "self") === "other";
        var title = escHtml_(f.flight_no + " " + f.dep_iata + "→" + f.arr_iata);

        // check-in + day-of are only meaningful for flights I'm on (you don't check in for others)
        if (!isOther) {
          // 1) check-in opens (T-24h; late catch-up window down to T-12h) — always on for self
          if (now >= depMs - 24 * 3600e3 && now < depMs - 12 * 3600e3 && !notifSent_(f.id + ":checkin")) {
            var msg1 = "✅ <b>Check-in opens</b> — " + title +
              "\nDeparts " + escHtml_(fmtLocal_(f.dep_time_local)) + " (" + escHtml_(f.dep_tz) + ")" +
              (f.pnr ? "\nPNR: <code>" + escHtml_(f.pnr) + "</code>" : "");
            if (sendTelegram_(msg1)) markNotif_(f.id + ":checkin", msg1); // else retry next hour
          }
          // 2) day-of summary (from 07:00 local at departure airport, or T-4h for red-eyes)
          var localNow = Utilities.formatDate(new Date(), f.dep_tz, "yyyy-MM-dd HH");
          var dayOfWindow = Number(localNow.slice(11)) >= 7 || depMs - now < 4 * 3600e3;
          if (localNow.slice(0, 10) === String(f.dep_time_local).slice(0, 10) && dayOfWindow &&
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
        }

        // 3) change detection + baggage + landed: within [dep-48h, arr+2h], every 3rd hour
        if (now >= depMs - 48 * 3600e3 && now <= arrMs + 2 * 3600e3 &&
            new Date().getUTCHours() % 3 === 0) {
          var res = flightInfo_(f.flight_no, String(f.dep_time_local).slice(0, 10), false, f.dep_iata);
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
  var target = notifyTarget_(f); // pickup contact or owner default

  // 1) DETECT changes without mutating f yet (so a failed send can be retried next poll)
  var nu = {}; // pending new values for notified fields
  var gateChanges = [], delayChanges = [];
  if (d.dep) {
    if (d.dep.gate && d.dep.gate !== f.dep_gate) { gateChanges.push("Gate " + (f.dep_gate || "—") + " → " + d.dep.gate); nu.dep_gate = d.dep.gate; }
    if (d.dep.terminal && d.dep.terminal !== f.dep_terminal) { gateChanges.push("Terminal " + (f.dep_terminal || "—") + " → " + d.dep.terminal); nu.dep_terminal = d.dep.terminal; }
    if (d.dep.revisedLocal && d.dep.revisedLocal !== f.dep_revised_local && d.dep.revisedLocal !== f.dep_time_local) {
      delayChanges.push("Departure " + fmtLocal_(f.dep_time_local) + " → " + fmtLocal_(d.dep.revisedLocal));
      nu.dep_revised_local = d.dep.revisedLocal;
    }
  }
  if (d.arr && d.arr.revisedLocal && d.arr.revisedLocal !== f.arr_revised_local && d.arr.revisedLocal !== f.arr_time_local) {
    delayChanges.push("Arrival " + fmtLocal_(f.arr_time_local) + " → " + fmtLocal_(d.arr.revisedLocal));
    nu.arr_revised_local = d.arr.revisedLocal;
  }
  if (d.status && d.status !== f.api_status) {
    if (/delay|cancel|divert/i.test(d.status)) delayChanges.push("Status: " + d.status);
    nu.api_status = d.status;
  }

  // 2) NOTIFY (per prefs), then decide what may be committed
  var msgParts = [];
  if (prefOn_(f, "delay")) msgParts = msgParts.concat(delayChanges);
  if (prefOn_(f, "gate")) msgParts = msgParts.concat(gateChanges);
  var notifiedOk = true; // true when the change alert was delivered, already sent, or not needed
  if (msgParts.length) {
    var key = f.id + ":change:" + shortHash_(msgParts.join("|"));
    if (!notifSent_(key)) {
      var msg = "⚠️ <b>Flight update</b> — " + title + "\n" + escHtml_(msgParts.join("\n"));
      notifiedOk = sendTelegram_(msg, target);
      if (notifiedOk) markNotif_(key, msg);
    }
  }

  // 3) PERSIST: display-only fields always; notified fields only if delivered
  //    (if the alert failed, leave those stale so the next poll re-detects and retries)
  var dirty = false;
  if (d.aircraft && !f.aircraft) { f.aircraft = d.aircraft; dirty = true; }
  if (d.aircraftReg && !f.aircraft_reg) { f.aircraft_reg = d.aircraftReg; dirty = true; }
  if (notifiedOk) {
    Object.keys(nu).forEach(function (k) { f[k] = nu[k]; dirty = true; });
  }
  if (dirty) upsertFlight_(f);

  // baggage belt: notify once per belt value (no stored column needed)
  if (prefOn_(f, "baggage") && d.arr && d.arr.baggageBelt) {
    var bkey = f.id + ":belt:" + d.arr.baggageBelt;
    if (!notifSent_(bkey)) {
      var bmsg = "🧳 <b>Baggage</b> — " + title + "\nBelt " + escHtml_(d.arr.baggageBelt) + " at " + escHtml_(f.arr_iata);
      if (sendTelegram_(bmsg, target)) markNotif_(bkey, bmsg);
    }
  }

  // landed: the pickup cue for "someone else" flights
  if (prefOn_(f, "landed") && d.status && /arriv|land/i.test(d.status)) {
    var lkey = f.id + ":landed";
    if (!notifSent_(lkey)) {
      var arrShown = fmtLocal_(f.arr_revised_local || f.arr_time_local);
      var lmsg = "🛬 <b>Landed</b> — " + title + "\nArrived " + escHtml_(f.arr_iata) + " · " + escHtml_(arrShown);
      if (sendTelegram_(lmsg, target)) markNotif_(lkey, lmsg);
    }
  }

  try { if (dirty && f.gcal_event_id) syncOne_(f); } catch (e) { log_("WARN", "applyChanges/cal", String(e)); }
}
