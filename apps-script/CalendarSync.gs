// CalendarSync.gs — upsert flights into a dedicated "Flights" Google Calendar.
// Primary path for the auto-updating subscription: the user subscribes to this calendar itself.

function flightsCal_() {
  var id = getSetting_("CAL_ID");
  if (id) {
    var cal = CalendarApp.getCalendarById(id);
    if (cal) return cal;
  }
  var created = CalendarApp.createCalendar("Flights", { color: CalendarApp.Color.PALE_BLUE });
  setSetting_("CAL_ID", created.getId());
  log_("INFO", "calendar", "created Flights calendar " + created.getId());
  return created;
}

function eventTitle_(f) { return f.flight_no + " · " + f.dep_iata + " → " + f.arr_iata; }

function eventDesc_(f) {
  var lines = [];
  if (f.airline_name) lines.push("Airline: " + f.airline_name);
  if (f.status) lines.push("Status: " + f.status);
  if (f.pnr) lines.push("PNR: " + f.pnr);
  if (f.seat) lines.push("Seat: " + f.seat);
  if (f.cabin) lines.push("Cabin: " + f.cabin);
  if (f.dep_terminal || f.dep_gate)
    lines.push("Departure: " + [f.dep_terminal ? "T" + String(f.dep_terminal).replace(/^T/i, "") : "", f.dep_gate ? "Gate " + f.dep_gate : ""].filter(String).join(" "));
  if (f.arr_terminal || f.arr_gate)
    lines.push("Arrival: " + [f.arr_terminal ? "T" + String(f.arr_terminal).replace(/^T/i, "") : "", f.arr_gate ? "Gate " + f.arr_gate : ""].filter(String).join(" "));
  if (f.aircraft) lines.push("Aircraft: " + f.aircraft);
  if (f.notes) lines.push("Notes: " + f.notes);
  lines.push("", "app00046_uid: " + f.id);
  return lines.join("\n");
}

// returns "created" | "updated" | "removed" | "skipped"
function syncOne_(f) {
  var cal = flightsCal_();

  if (f.status === "deleted" || f.status === "cancelled") {
    if (f.gcal_event_id) {
      var ev0 = cal.getEventById(f.gcal_event_id);
      if (ev0) ev0.deleteEvent();
      f.gcal_event_id = "";
      upsertFlight_(f);
      return "removed";
    }
    return "skipped";
  }

  var start = parseLocal_(f.dep_time_local, f.dep_tz);
  var end = parseLocal_(f.arr_time_local, f.arr_tz);
  if (!start || !end) return "skipped";

  var location = f.dep_iata +
    (f.dep_terminal ? " T" + String(f.dep_terminal).replace(/^T/i, "") : "") +
    (f.dep_airport ? " — " + f.dep_airport : "");

  var ev = f.gcal_event_id ? cal.getEventById(f.gcal_event_id) : null;
  var result;
  if (ev) {
    ev.setTitle(eventTitle_(f));
    ev.setTime(start, end);
    ev.setDescription(eventDesc_(f));
    ev.setLocation(location);
    result = "updated";
  } else {
    ev = cal.createEvent(eventTitle_(f), start, end, { description: eventDesc_(f), location: location });
    ev.setTag("app00046_uid", f.id);
    f.gcal_event_id = ev.getId();
    upsertFlight_(f);
    result = "created";
  }
  ev.removeAllReminders();
  ev.addPopupReminder(24 * 60); // check-in opens
  ev.addPopupReminder(180);     // 3 h before departure
  return result;
}

function syncCalendarById_(id) {
  var f = findRow_(id);
  if (!f) return { ok: false, error: "not_found" };
  var r = syncOne_(f);
  return { ok: true, synced: r === "skipped" ? 0 : 1, result: r, calendarId: getSetting_("CAL_ID") };
}

function syncAllCalendar_() {
  var flights = listFlights_(true); // include deleted so their events get removed
  var synced = 0, deleted = 0;
  flights.forEach(function (f) {
    var r = syncOne_(f);
    if (r === "created" || r === "updated") synced++;
    if (r === "removed") deleted++;
  });
  return { ok: true, synced: synced, deleted: deleted, calendarId: getSetting_("CAL_ID") };
}

function removeCalendarEvent_(id) {
  var f = findRow_(id);
  if (f && f.gcal_event_id) {
    var cal = flightsCal_();
    var ev = cal.getEventById(f.gcal_event_id);
    if (ev) ev.deleteEvent();
    f.gcal_event_id = "";
    writeRow_("flights", FLIGHT_COLS, f, f.__row);
  }
}
