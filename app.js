// app.js — SPA core: router, page renders, 4-stage timeline, stats + SVG map.
(function () {
  "use strict";

  var L = window.LABELS;
  var APP_VERSION = "0.1.0";

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- time helpers (component parsing, no Date-string pitfalls) ----------

  function fmtTime(localIso) { return localIso ? localIso.slice(11, 16) : ""; }

  function fmtDate(localIso) {
    if (!localIso) return "";
    var y = +localIso.slice(0, 4), m = +localIso.slice(5, 7), d = +localIso.slice(8, 10);
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }

  function depUtc(f) { return window.ICS.zonedToUtc(f.dep_time_local, f.dep_tz); }
  function arrUtc(f) { return window.ICS.zonedToUtc(f.arr_time_local, f.arr_tz); }

  function fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    function z(n) { return (n < 10 ? "0" : "") + n; }
    if (d > 0) return d + "d " + z(h) + "h " + z(mm) + "m";
    if (h > 0) return h + "h " + z(mm) + "m";
    return mm + "m";
  }

  function durText(min) {
    min = Number(min);
    if (isNaN(min) || min < 0) return "";
    return Math.floor(min / 60) + "h " + (min % 60 < 10 ? "0" : "") + (min % 60) + "m";
  }

  var PLANE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="#4FC3F7"><path d="M21.5 15.5v-2l-8.5-5V3.2c0-.8-.7-1.5-1.5-1.5S10 2.4 10 3.2v5.3l-8.5 5v2L10 13v5.5L7.5 20v1.5l4-1 4 1V20L13 18.5V13l8.5 2.5z"/></svg>';

  // ---------- router ----------

  var PAGES = ["trips", "detail", "stats", "settings"];
  var detailMapTimer = null; // live-map poll; cleared whenever we navigate

  function route() {
    var h = location.hash || "#/trips";
    var m;
    if (h === "#/trips" || h === "#/") show("trips");
    else if (h === "#/stats") show("stats");
    else if (h === "#/settings") show("settings");
    else if (h === "#/new") { show("detail"); renderDetail(null); return; }
    else if ((m = /^#\/flight\/(.+)$/.exec(h))) { show("detail"); renderDetail(decodeURIComponent(m[1])); return; }
    else show("trips");
    render();
  }

  function show(page) {
    if (detailMapTimer) { clearInterval(detailMapTimer); detailMapTimer = null; } // stop live-map poll on any navigation
    PAGES.forEach(function (p) {
      var el = $("#page-" + p);
      if (el) el.classList.toggle("active", p === page);
    });
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.page === page);
    });
    var fab = $("#fab");
    if (fab) fab.classList.toggle("hidden", page !== "trips");
    window.scrollTo(0, 0);
    currentPage = page;
  }

  var currentPage = "trips";

  function render() {
    if (currentPage === "trips") renderTrips();
    else if (currentPage === "stats") renderStats();
    else if (currentPage === "settings") renderSettings();
  }

  // ---------- trips page ----------

  function sortedFlights() {
    return API.flights().slice().sort(function (a, b) {
      return (a.dep_time_local || "").localeCompare(b.dep_time_local || "");
    });
  }

  function cardHtml(f, expanded) {
    var cancelled = f.status === "cancelled";
    var isOther = f.traveler_role === "other";
    var overnight = f.arr_time_local && f.dep_time_local &&
      f.arr_time_local.slice(0, 10) !== f.dep_time_local.slice(0, 10);
    var chips = [];
    if (f.dep_terminal) chips.push("T" + esc(String(f.dep_terminal).replace(/^T/i, "")));
    if (f.dep_gate) chips.push("Gate <b>" + esc(f.dep_gate) + "</b>");
    if (f.seat) chips.push("Seat <b>" + esc(f.seat) + "</b>");
    if (f.pnr) chips.push("PNR <b>" + esc(f.pnr) + "</b>");
    if (f.aircraft) chips.push(esc(f.aircraft));

    // "someone else" flights show a WATCHING badge (+ who) and, when known, a live-status pill
    var topRight = '<span class="pill ' + esc(f.status) + '">' + esc(L.status[f.status] || f.status) + "</span>";
    if (isOther) {
      var who = f.passenger ? " · " + esc(f.passenger) : "";
      var live = f.api_status ? '<span class="pill live">' + esc(f.api_status) + "</span> " : "";
      var cancel = cancelled ? '<span class="pill cancelled">' + esc(L.status.cancelled) + "</span> " : "";
      topRight = cancel + live + '<span class="pill watching">' + esc(L.trips.watchingBadge) + who + "</span>";
    }

    return '<div class="card' + (cancelled ? " cancelled-card" : "") + '" data-id="' + esc(f.id) + '">' +
      '<div class="card-top"><span>' + esc(f.airline_name || f.airline_iata || "") +
      " · " + esc(f.flight_no) + '</span><span class="pill-group">' + topRight + "</span></div>" +
      '<div class="card-body">' +
      '<div class="endpoint dep"><div class="iata">' + esc(f.dep_iata) + '</div>' +
      '<div class="time">' + esc(fmtTime(f.dep_time_local)) + '</div>' +
      '<div class="date">' + esc(fmtDate(f.dep_time_local)) + "</div></div>" +
      '<div class="card-mid"><div class="flight-line">' + PLANE_SVG + "</div>" +
      '<div class="dur">' + esc(durText(f.duration_min)) + "</div></div>" +
      '<div class="endpoint arr"><div class="iata">' + esc(f.arr_iata) + '</div>' +
      '<div class="time">' + esc(fmtTime(f.arr_time_local)) + '</div>' +
      '<div class="date">' + esc(fmtDate(f.arr_time_local)) +
      (overnight ? " <sup>" + L.trips.nextDay + "</sup>" : "") + "</div></div>" +
      "</div>" +
      (chips.length ? '<div class="card-chips"><span class="chip">' + chips.join('</span><span class="chip">') + "</span></div>" : "") +
      (expanded ? '<div class="stepper-wrap" id="stepper-' + esc(f.id) + '"></div>' : "") +
      "</div>";
  }

  function stageTimes(f) {
    var dep = depUtc(f), arr = arrUtc(f);
    if (!dep || !arr) return null;
    return [dep.getTime() - 24 * 3600e3, dep.getTime() - 40 * 60e3, dep.getTime(), arr.getTime()];
  }

  function stepperHtml(f) {
    var st = stageTimes(f);
    if (!st) return "";
    var now = Date.now();
    var stage = 0; // index of next stage not yet reached
    while (stage < 4 && now >= st[stage]) stage++;

    var cdLabel, cdValue;
    if (stage >= 4) { cdLabel = ""; cdValue = L.trips.countdown.landed; }
    else {
      var keys = ["checkin", "boarding", "takeoff", "landing"];
      cdLabel = L.trips.countdown[keys[stage]];
      cdValue = fmtCountdown(st[stage] - now);
    }

    var stageTimeLabels = st.map(function (t) {
      var d = new Date(t);
      return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    });

    var html = '<div class="countdown">' +
      (cdLabel ? '<div class="cd-label">' + esc(cdLabel) + "</div>" : "") +
      '<div class="cd-value">' + esc(cdValue) + "</div></div>" +
      '<div class="stepper">';

    for (var i = 0; i < 4; i++) {
      html += '<div class="step' + (now >= st[i] ? " done" : "") + '">' +
        '<div class="dot"></div><div class="st-label">' + esc(L.trips.stages[i]) + "</div>" +
        '<div class="st-time">' + esc(stageTimeLabels[i]) + "</div></div>";
      if (i < 3) {
        var fillPct = 0, planeHtml = "";
        if (now >= st[i + 1]) fillPct = 100;
        else if (now > st[i]) {
          fillPct = Math.min(100, Math.max(0, (now - st[i]) / (st[i + 1] - st[i]) * 100));
          planeHtml = '<span class="plane" style="left:' + fillPct.toFixed(1) + '%">' + PLANE_SVG + "</span>";
        }
        html += '<div class="seg"><div class="seg-fill" style="width:' + fillPct.toFixed(1) + '%"></div>' + planeHtml + "</div>";
      }
    }
    html += "</div>";
    return html;
  }

  var expandedId = null;

  function renderTrips() {
    var flights = sortedFlights();
    var now = Date.now();
    var upcoming = [], past = [];
    flights.forEach(function (f) {
      var arr = arrUtc(f);
      // no computable arrival (unknown airport/tz) → group by status instead
      var isPast = arr ? arr.getTime() < now : f.status === "flown";
      if (isPast) past.push(f); else upcoming.push(f);
    });
    past.reverse(); // most recent first

    expandedId = null;
    for (var i = 0; i < upcoming.length; i++) {
      if (upcoming[i].status !== "cancelled" && stageTimes(upcoming[i])) { expandedId = upcoming[i].id; break; }
    }

    var html = "";
    if (!flights.length) {
      html = '<div class="empty-state">' + esc(L.trips.empty) + "</div>";
    } else {
      if (upcoming.length) {
        html += '<div class="section-label">' + esc(L.trips.upcoming) + "</div>";
        upcoming.forEach(function (f) { html += cardHtml(f, f.id === expandedId); });
      }
      if (past.length) {
        html += '<div class="section-label">' + esc(L.trips.past) + "</div>";
        past.forEach(function (f) { html += cardHtml(f, false); });
      }
    }
    $("#trips-list").innerHTML = html;

    if (expandedId) {
      var f = flights.find(function (x) { return x.id === expandedId; });
      var wrap = $("#stepper-" + CSS.escape(expandedId));
      if (wrap && f) wrap.innerHTML = stepperHtml(f);
    }

    document.querySelectorAll("#trips-list .card").forEach(function (el) {
      el.addEventListener("click", function () {
        location.hash = "#/flight/" + encodeURIComponent(el.dataset.id);
      });
    });
  }

  // periodic stepper refresh (30 s) without re-rendering the whole page
  setInterval(function () {
    if (currentPage !== "trips" || !expandedId) return;
    var f = API.flights().find(function (x) { return x.id === expandedId; });
    var wrap = document.getElementById("stepper-" + expandedId);
    if (f && wrap) wrap.innerHTML = stepperHtml(f);
  }, 30000);

  // ---------- flight detail / edit ----------

  function field(id, label, inputHtml, full, hint) {
    return '<div class="field' + (full ? " full" : "") + '"><label for="' + id + '">' + esc(label) +
      "</label>" + inputHtml + '<div class="hint" id="' + id + '-hint">' + esc(hint || "") + "</div></div>";
  }

  function inp(id, value, ph, type) {
    return '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(value || "") +
      '" placeholder="' + esc(ph || "") + '" autocomplete="off">';
  }

  function renderDetail(id) {
    var isNew = !id;
    var f = isNew ? {
      flight_no: "", airline_iata: "", airline_name: "", dep_iata: "", arr_iata: "",
      dep_time_local: "", arr_time_local: "", status: "planned",
      traveler_role: "self", passenger: "Brian Li",
    } : API.allRaw().find(function (x) { return x.id === id; });
    if (!f || f.status === "deleted") { location.hash = "#/trips"; return; }
    if (!f.traveler_role) f.traveler_role = "self";

    // notify_prefs: "" = all on, "none" = all off, else comma list of enabled keys
    function jsPrefOn(prefs, key) {
      prefs = (prefs || "").trim();
      if (!prefs) return true;
      if (prefs === "none") return false;
      return ("," + prefs + ",").indexOf("," + key + ",") >= 0;
    }

    var depDate = (f.dep_time_local || "").slice(0, 10);
    var depTime = (f.dep_time_local || "").slice(11, 16);
    var arrDate = (f.arr_time_local || "").slice(0, 10);
    var arrTime = (f.arr_time_local || "").slice(11, 16);
    var isOther0 = f.traveler_role === "other";

    var statusOpts = ["planned", "ticketed", "checked-in", "flown", "cancelled"].map(function (s) {
      return '<option value="' + s + '"' + (f.status === s ? " selected" : "") + ">" + esc(L.status[s]) + "</option>";
    }).join("");

    var cabinOpts = ["", "economy", "premium", "business", "first"].map(function (c) {
      return '<option value="' + c + '"' + ((f.cabin || "") === c ? " selected" : "") + ">" + esc(L.detail.cabins[c]) + "</option>";
    }).join("");

    var html =
      '<div class="page-title"><a class="back-link" href="#/trips">‹ ' + esc(L.tabs.trips) + "</a><span>" +
      esc(isNew ? L.detail.newTitle : f.flight_no) + '</span><span style="width:48px"></span></div>' +

      // ---- lazy lookup: flight number + date -> auto-fill everything ----
      '<div class="lookup-card">' +
      '<div class="form-grid">' +
      field("f-no", L.detail.flightNo, inp("f-no", f.flight_no, L.detail.flightNoPh)) +
      field("f-depdate", L.detail.date, inp("f-depdate", depDate, "", "date")) +
      "</div>" +
      '<button class="btn small primary" id="btn-lookup">' + esc(L.detail.lookup) + "</button>" +
      '<div class="hint" id="lookup-hint">' + esc(L.detail.lookupHint) + "</div>" +
      "</div>" +

      // ---- who is flying ----
      '<div class="field full"><label>' + esc(L.detail.travelerRole) + "</label>" +
      '<div class="role-row">' +
      '<label class="role-opt' + (isOther0 ? "" : " active") + '" data-role="self"><input type="radio" name="role" value="self"' + (isOther0 ? "" : " checked") + ">" + esc(L.detail.travelerRoles.self) + "</label>" +
      '<label class="role-opt' + (isOther0 ? " active" : "") + '" data-role="other"><input type="radio" name="role" value="other"' + (isOther0 ? " checked" : "") + ">" + esc(L.detail.travelerRoles.other) + "</label>" +
      "</div></div>" +
      '<div class="field full' + (isOther0 ? "" : " hidden") + '" id="who-field"><label for="f-who">' + esc(L.detail.whoFlying) + "</label>" +
      inp("f-who", isOther0 ? f.passenger : "", L.detail.whoFlyingPh) + "</div>" +

      // ---- the rest (editable fallback / details) ----
      '<div class="form-grid">' +
      field("f-airline", L.detail.airline, inp("f-airline", f.airline_name)) +
      field("f-dep", L.detail.from, inp("f-dep", f.dep_iata, "TPE")) +
      field("f-arr", L.detail.to, inp("f-arr", f.arr_iata, "LAX")) +
      field("f-deptime", L.detail.depTime, inp("f-deptime", depTime, "", "time")) +
      field("f-arrdate", L.detail.arrDate, inp("f-arrdate", arrDate, "", "date")) +
      field("f-arrtime", L.detail.arrTime, inp("f-arrtime", arrTime, "", "time")) +
      field("f-status", L.detail.status, '<select id="f-status">' + statusOpts + "</select>") +
      field("f-pnr", L.detail.pnr, inp("f-pnr", f.pnr)) +
      field("f-seat", L.detail.seat, inp("f-seat", f.seat)) +
      field("f-cabin", L.detail.cabin, '<select id="f-cabin">' + cabinOpts + "</select>") +
      field("f-depterm", L.detail.depTerminal, inp("f-depterm", f.dep_terminal)) +
      field("f-depgate", L.detail.depGate, inp("f-depgate", f.dep_gate)) +
      field("f-arrterm", L.detail.arrTerminal, inp("f-arrterm", f.arr_terminal)) +
      field("f-arrgate", L.detail.arrGate, inp("f-arrgate", f.arr_gate)) +
      field("f-aircraft", L.detail.aircraft, inp("f-aircraft", f.aircraft)) +
      field("f-notes", L.detail.notes, '<textarea id="f-notes" rows="2">' + esc(f.notes || "") + "</textarea>", true) +
      "</div>" +
      // ---- Telegram alert preferences (+ optional pickup contact) ----
      '<div class="section-label">' + esc(L.detail.notifySection) + "</div>" +
      '<div class="notify-grid">' +
      ["delay", "gate", "baggage", "landed"].map(function (k) {
        return '<label class="notify-opt"><input type="checkbox" class="f-notify" value="' + k + '"' +
          (jsPrefOn(f.notify_prefs, k) ? " checked" : "") + "> " + esc(L.detail.notify[k]) + "</label>";
      }).join("") +
      "</div>" +
      '<div class="field full"><label for="f-chat">' + esc(L.detail.notifyChat) + "</label>" +
      inp("f-chat", f.notify_chat_id, L.detail.notifyChatPh) +
      '<div class="hint">' + esc(L.detail.notifyChatHint) + "</div></div>" +
      '<div class="msg" id="detail-msg"></div>' +
      '<button class="btn primary" id="btn-save">' + esc(L.detail.save) + "</button>" +
      (isNew ? "" :
        '<div class="section-label">' + esc(L.detail.infoSection) + "</div>" +
        '<button class="btn" id="btn-ontime">' + esc(L.detail.ontimeBtn) + "</button>" +
        '<button class="btn" id="btn-inbound">' + esc(L.detail.inboundBtn) + "</button>" +
        '<button class="btn" id="btn-map">' + esc(L.detail.mapBtn) + "</button>" +
        '<div id="mini-map"></div>' +
        '<div class="msg" id="insight-msg"></div>' +
        '<div style="height:8px"></div>' +
        '<button class="btn" id="btn-ics">' + esc(L.detail.exportIcs) + "</button>" +
        '<button class="btn" id="btn-gcal">' + esc(L.detail.syncCalendar) + "</button>" +
        '<button class="btn danger" id="btn-del">' + esc(L.detail.delete) + "</button>");

    $("#page-detail").innerHTML = html;

    // role radio → toggle "who's flying" field
    document.querySelectorAll(".role-opt").forEach(function (opt) {
      opt.addEventListener("click", function () {
        document.querySelectorAll(".role-opt").forEach(function (o) { o.classList.remove("active"); });
        opt.classList.add("active");
        opt.querySelector("input").checked = true;
        $("#who-field").classList.toggle("hidden", opt.dataset.role !== "other");
      });
    });
    function currentRole() {
      var el = document.querySelector('input[name="role"]:checked');
      return el ? el.value : "self";
    }

    // IATA hints + airline autofill
    function bindIata(inputId) {
      var el = $("#" + inputId);
      function update() {
        el.value = el.value.toUpperCase().trim();
        var a = window.AIRPORTS[el.value];
        $("#" + inputId + "-hint").textContent =
          a ? a[0] + " · " + a[5] : (el.value.length === 3 ? L.detail.unknownAirport : "");
      }
      el.addEventListener("input", update); update();
    }
    bindIata("f-dep"); bindIata("f-arr");

    $("#f-no").addEventListener("input", function () {
      this.value = this.value.toUpperCase().replace(/\s+/g, "");
      var m = /^([A-Z0-9]{2})\d/.exec(this.value);
      if (m && window.AIRLINES[m[1]] && !$("#f-airline").value)
        $("#f-airline").value = window.AIRLINES[m[1]];
    });

    // default arrival date = departure date
    $("#f-depdate").addEventListener("change", function () {
      if (!$("#f-arrdate").value) $("#f-arrdate").value = this.value;
    });

    function msg(text, cls) {
      var el = $("#detail-msg");
      el.textContent = text; el.className = "msg " + (cls || "dim");
    }

    // fill the whole form from a flightinfo payload; also stashes reg + live status on f
    function applyFlightInfo(d) {
      if (!d) return;
      if (d.airlineName && !$("#f-airline").value) $("#f-airline").value = d.airlineName;
      if (d.aircraft) $("#f-aircraft").value = d.aircraft;
      if (d.aircraftReg) f.aircraft_reg = d.aircraftReg;
      if (d.status) f.api_status = d.status;
      if (d.dep) {
        if (d.dep.iata) { $("#f-dep").value = d.dep.iata; }
        if (d.dep.terminal) $("#f-depterm").value = d.dep.terminal;
        if (d.dep.gate) $("#f-depgate").value = d.dep.gate;
        var td = d.dep.revisedLocal || d.dep.schedLocal;
        if (td) { $("#f-depdate").value = td.slice(0, 10); $("#f-deptime").value = td.slice(11, 16); }
      }
      if (d.arr) {
        if (d.arr.iata) { $("#f-arr").value = d.arr.iata; }
        if (d.arr.terminal) $("#f-arrterm").value = d.arr.terminal;
        if (d.arr.gate) $("#f-arrgate").value = d.arr.gate;
        var ta = d.arr.revisedLocal || d.arr.schedLocal;
        if (ta) { $("#f-arrdate").value = ta.slice(0, 10); $("#f-arrtime").value = ta.slice(11, 16); }
      }
      // refresh the airport-name hints without re-adding input listeners
      $("#f-dep").dispatchEvent(new Event("input"));
      $("#f-arr").dispatchEvent(new Event("input"));
    }

    function doLookup() {
      if (API.mode() !== "backend") { msg(L.detail.fetchNoBackend, "err"); return; }
      var flightNo = $("#f-no").value.trim().toUpperCase();
      var date = $("#f-depdate").value;
      if (!flightNo || !date) { msg(L.detail.invalid, "err"); return; }
      msg(L.detail.lookingUp);
      var depIata = $("#f-dep").value.trim().toUpperCase();
      API.flightinfo(flightNo, date, depIata).then(function (res) {
        if (!res.ok) {
          if (res.error === "not_found") msg(L.detail.lookupManual, "dim");
          else if (res.error === "monthly_quota" || res.error === "daily_cap") msg(L.detail.fetchQuota, "dim");
          else msg(L.common.error + ": " + (res.error || ""), "err");
          return;
        }
        applyFlightInfo(res.data || {});
        msg(L.detail.lookupFilled, "ok");
      }).catch(function (e) { msg(L.common.error + ": " + e.message, "err"); });
    }
    $("#btn-lookup").addEventListener("click", function () { doLookup(); });

    function collect() {
      var flightNo = $("#f-no").value.trim().toUpperCase();
      var depIata = $("#f-dep").value.trim().toUpperCase();
      var arrIata = $("#f-arr").value.trim().toUpperCase();
      var depDate = $("#f-depdate").value, depTime = $("#f-deptime").value;
      var arrDate = $("#f-arrdate").value || depDate, arrTime = $("#f-arrtime").value;
      if (!flightNo || !depIata || !arrIata || !depDate || !depTime || !arrTime) return null;
      var role = currentRole();
      var passenger = role === "other" ? $("#f-who").value.trim() : (f.passenger && f.traveler_role === "self" ? f.passenger : "Brian Li");
      // notify prefs: all 4 checked -> "" (default all-on); none -> "none"; else comma list
      var checked = Array.prototype.slice.call(document.querySelectorAll(".f-notify:checked")).map(function (c) { return c.value; });
      var notifyPrefs = checked.length === 4 ? "" : (checked.length === 0 ? "none" : checked.join(","));
      var m = /^([A-Z0-9]{2})\d/.exec(flightNo);
      var out = Object.assign({}, f, {
        flight_no: flightNo,
        airline_iata: m ? m[1] : (f.airline_iata || ""),
        airline_name: $("#f-airline").value.trim(),
        dep_iata: depIata, arr_iata: arrIata,
        dep_time_local: depDate + "T" + depTime,
        arr_time_local: arrDate + "T" + arrTime,
        // no fallback to the previous airport's tz — unknown IATA means unknown tz
        dep_tz: (window.AIRPORTS[depIata] || [])[5] || "",
        arr_tz: (window.AIRPORTS[arrIata] || [])[5] || "",
        status: $("#f-status").value,
        pnr: $("#f-pnr").value.trim(), seat: $("#f-seat").value.trim(),
        cabin: $("#f-cabin").value,
        dep_terminal: $("#f-depterm").value.trim(), dep_gate: $("#f-depgate").value.trim(),
        arr_terminal: $("#f-arrterm").value.trim(), arr_gate: $("#f-arrgate").value.trim(),
        aircraft: $("#f-aircraft").value.trim(),
        traveler_role: role,
        passenger: passenger,
        notify_prefs: notifyPrefs,
        notify_chat_id: $("#f-chat").value.trim(),
        notes: $("#f-notes").value.trim(),
      });
      return out;
    }

    $("#btn-save").addEventListener("click", function () {
      var out = collect();
      if (!out) { msg(L.detail.invalid, "err"); return; }
      if (out.traveler_role === "other" && !out.passenger) { msg(L.detail.whoRequired, "err"); return; }
      var d1 = window.ICS.zonedToUtc(out.dep_time_local, out.dep_tz);
      var d2 = window.ICS.zonedToUtc(out.arr_time_local, out.arr_tz);
      if (d1 && d2 && d2 <= d1) { msg(L.detail.invalidTimes, "err"); return; }
      API.upsert(out).then(function () { location.hash = "#/trips"; })
        .catch(function (e) { msg(String(e.message || e), "err"); });
    });

    if (!isNew) {
      $("#btn-ics").addEventListener("click", function (ev) {
        ev.stopPropagation();
        var out = collect() || f;
        window.ICS.exportFlight(API.enrich(out));
      });

      $("#btn-del").addEventListener("click", function () {
        if (!confirm(L.detail.deleteConfirm)) return;
        API.remove(f.id).then(function () { location.hash = "#/trips"; });
      });

      $("#btn-gcal").addEventListener("click", function () {
        if (API.mode() !== "backend") { msg(L.detail.fetchNoBackend, "err"); return; }
        msg(L.common.loading);
        API.syncCalendar(f.id).then(function (res) {
          if (res.ok) msg(L.detail.synced, "ok");
          else msg(L.detail.syncFailed + ": " + (res.error || ""), "err");
        }).catch(function (e) { msg(L.detail.syncFailed + ": " + e.message, "err"); });
      });

      // ---- insights: on-time history + inbound aircraft ----
      function imsg(text, cls) {
        var el = $("#insight-msg"); el.textContent = text; el.className = "msg " + (cls || "dim");
      }
      function fmtMedian(m) {
        if (m == null) return "—";
        if (m === 0) return L.detail.ontimeOnDot;
        return m < 0 ? L.detail.ontimeEarly.replace("{m}", -m) : L.detail.ontimeLate.replace("{m}", m);
      }
      $("#btn-ontime").addEventListener("click", function () {
        if (API.mode() !== "backend") { imsg(L.detail.fetchNoBackend, "err"); return; }
        imsg(L.detail.loading);
        API.ontime($("#f-no").value.trim().toUpperCase()).then(function (res) {
          if (!res.ok) {
            if (res.error === "not_found") imsg(L.detail.ontimeNone, "dim");
            else if (res.error === "monthly_quota" || res.error === "daily_cap") imsg(L.detail.fetchQuota, "dim");
            else imsg(L.common.error + ": " + (res.error || ""), "err");
            return;
          }
          var d = res.data || {};
          var med = fmtMedian(d.medianDelayMin);
          var txt = d.onTimePct != null
            ? L.detail.ontimeResult.replace("{median}", med).replace("{pct}", d.onTimePct).replace("{n}", d.samples)
            : L.detail.ontimeResultNoPct.replace("{median}", med).replace("{n}", d.samples);
          imsg(txt, "ok");
        }).catch(function (e) { imsg(L.common.error + ": " + e.message, "err"); });
      });
      $("#btn-inbound").addEventListener("click", function () {
        if (API.mode() !== "backend") { imsg(L.detail.fetchNoBackend, "err"); return; }
        if (!f.aircraft_reg) { imsg(L.detail.inboundNoReg, "dim"); return; }
        imsg(L.detail.loading);
        var date = (f.dep_time_local || "").slice(0, 10);
        API.inbound(f.aircraft_reg, date, f.dep_iata, f.dep_time_local).then(function (res) {
          if (!res.ok) {
            if (res.error === "no_inbound") imsg(L.detail.inboundNone, "dim");
            else if (res.error === "no_reg") imsg(L.detail.inboundNoReg, "dim");
            else if (res.error === "monthly_quota" || res.error === "daily_cap") imsg(L.detail.fetchQuota, "dim");
            else imsg(L.common.error + ": " + (res.error || ""), "err");
            return;
          }
          var d = res.data || {};
          var arr = d.revisedArrLocal || d.schedArrLocal || "";
          var arrShown = arr ? arr.slice(11, 16) : "?";
          var txt = d.bufferMin != null
            ? L.detail.inboundResult.replace("{flight}", d.flightNo).replace("{from}", d.fromIata)
                .replace("{arr}", arrShown).replace("{status}", d.status || "?").replace("{buffer}", durText(d.bufferMin) || (d.bufferMin + "m"))
            : L.detail.inboundNoBuffer.replace("{flight}", d.flightNo).replace("{from}", d.fromIata)
                .replace("{arr}", arrShown).replace("{status}", d.status || "?");
          imsg(txt, d.bufferMin != null && d.bufferMin < 90 ? "err" : "ok");
        }).catch(function (e) { imsg(L.common.error + ": " + e.message, "err"); });
      });

      // ---- live map (adsb.lol via backend), polls while the detail page is open ----
      function renderPosition(pos) {
        var dep = window.AIRPORTS[f.dep_iata], arr = window.AIRPORTS[f.arr_iata];
        $("#mini-map").innerHTML = '<div class="map-card">' + miniMapSvg(dep, arr, pos) + "</div>";
      }
      function pollPosition() {
        API.position(f.aircraft_reg, f.flight_no).then(function (res) {
          if (!res.ok) { imsg(L.common.error + ": " + (res.error || ""), "err"); return; }
          if (!res.airborne) { imsg(L.detail.mapNotAirborne, "dim"); renderPosition(null); return; }
          var d = res.data;
          renderPosition(d);
          imsg(L.detail.mapInfo.replace("{alt}", d.altFt != null ? d.altFt.toLocaleString() : "—")
            .replace("{gs}", d.groundSpeedKt != null ? Math.round(d.groundSpeedKt) : "—")
            .replace("{sec}", d.seenSec != null ? Math.round(d.seenSec) : "—"), "ok");
        }).catch(function (e) { imsg(L.common.error + ": " + e.message, "err"); });
      }
      $("#btn-map").addEventListener("click", function () {
        if (API.mode() !== "backend") { imsg(L.detail.fetchNoBackend, "err"); return; }
        if (!f.aircraft_reg && !f.flight_no) { imsg(L.detail.mapNoId, "dim"); return; }
        imsg(L.detail.mapLoading);
        pollPosition();
        if (detailMapTimer) clearInterval(detailMapTimer);
        detailMapTimer = setInterval(pollPosition, 60000); // gentle poll; cleared on navigation
      });
    }
  }

  // ---------- stats page ----------

  var includeUpcoming = null; // adaptive default, see renderStats

  function statFlights() {
    // stats only count flights I'm actually on (traveler_role=self); "someone else" flights excluded
    var all = API.flights().filter(function (f) {
      return f.status !== "cancelled" && (f.traveler_role || "self") === "self";
    });
    var flown = all.filter(function (f) { return f.status === "flown"; });
    if (includeUpcoming === null) includeUpcoming = flown.length === 0;
    return includeUpcoming ? all : flown;
  }

  function renderStats() {
    var flights = statFlights();
    var km = 0, min = 0;
    var airports = {}, airlines = {}, countries = {}, routes = {}, aircraft = {}, perYear = {};
    var longest = null;
    flights.forEach(function (f) {
      var dist = Number(f.distance_km) || 0, dur = Number(f.duration_min) || 0;
      km += dist; min += dur;
      [f.dep_iata, f.arr_iata].forEach(function (ia) {
        if (!ia) return;
        airports[ia] = (airports[ia] || 0) + 1;
        var a = window.AIRPORTS[ia];
        if (a) countries[a[2]] = true;
      });
      var al = f.airline_name || f.airline_iata;
      if (al) airlines[al] = (airlines[al] || 0) + 1;
      if (f.aircraft) aircraft[f.aircraft] = (aircraft[f.aircraft] || 0) + 1;
      if (f.dep_iata && f.arr_iata) routes[f.dep_iata + " → " + f.arr_iata] = (routes[f.dep_iata + " → " + f.arr_iata] || 0) + 1;
      if (dist && (!longest || dist > longest.km)) longest = { km: dist, route: f.dep_iata + "–" + f.arr_iata };
      // year-in-review buckets (by departure year)
      var yr = (f.dep_time_local || "").slice(0, 4);
      if (yr) {
        var y = perYear[yr] || (perYear[yr] = { n: 0, km: 0, min: 0, countries: {} });
        y.n++; y.km += dist; y.min += dur;
        [f.dep_iata, f.arr_iata].forEach(function (ia) { var a = window.AIRPORTS[ia]; if (a) y.countries[a[2]] = true; });
      }
    });

    function tile(num, label, sub) {
      return '<div class="tile"><div class="t-num">' + num + '</div><div class="t-label">' +
        esc(label) + "</div>" + (sub ? '<div class="t-sub">' + esc(sub) + "</div>" : "") + "</div>";
    }

    var hours = (min / 60).toFixed(1);
    var around = (km / 40075).toFixed(2);

    var html =
      '<div class="toggle-row"><input type="checkbox" id="stats-upcoming"' + (includeUpcoming ? " checked" : "") +
      '><label for="stats-upcoming">' + esc(L.stats.includeUpcoming) + "</label></div>" +
      '<div class="tiles">' +
      tile(flights.length, L.stats.flights) +
      tile(hours, L.stats.hours) +
      tile(km.toLocaleString("en-US"), L.stats.km, around + " " + L.stats.aroundWorld) +
      tile(Object.keys(airports).length, L.stats.airports) +
      tile(Object.keys(airlines).length, L.stats.airlines) +
      tile(Object.keys(countries).length, L.stats.countries) +
      (longest ? tile(longest.km.toLocaleString("en-US"), L.stats.longest, longest.route) : "") +
      "</div>" +
      '<div class="map-card">' + mapSvg(airports, flights, countries) + "</div>" +
      yearReviewSection(perYear) +
      rankSection(L.stats.topAirlines, airlines) +
      rankSection(L.stats.topAirports, airports) +
      rankSection(L.stats.topRoutes, routes) +
      rankSection(L.stats.topAircraft, aircraft);

    $("#stats-body").innerHTML = API.flights().length ? html
      : '<div class="empty-state">' + esc(L.stats.empty) + "</div>";

    var cb = $("#stats-upcoming");
    if (cb) cb.addEventListener("change", function () { includeUpcoming = cb.checked; renderStats(); });
  }

  function rankSection(title, counts) {
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 5);
    if (!top.length) return "";
    return '<div class="section-label">' + esc(title) + "</div>" +
      top.map(function (k) {
        return '<div class="rank-row"><span>' + esc(k) + '</span><span class="rr-count">' + counts[k] + "</span></div>";
      }).join("");
  }

  // Flighty-style year-in-review: one row per year (newest first)
  function yearReviewSection(perYear) {
    var years = Object.keys(perYear).sort(function (a, b) { return b - a; });
    if (!years.length) return "";
    return '<div class="section-label">' + esc(L.stats.yearReview) + "</div>" +
      years.map(function (yr) {
        var y = perYear[yr];
        var parts = [
          y.n + " " + (y.n === 1 ? L.stats.flightOne : L.stats.flights.toLowerCase()),
          (y.min / 60).toFixed(0) + "h",
          y.km.toLocaleString("en-US") + " km",
          Object.keys(y.countries).length + " " + L.stats.countries.toLowerCase(),
        ];
        return '<div class="rank-row"><span class="rr-count">' + esc(yr) + '</span><span style="text-align:right;font-size:13px">' +
          esc(parts.join(" · ")) + "</span></div>";
      }).join("");
  }

  function project(lat, lon) {
    return { x: (lon + 180) / 360 * 2000, y: (90 - lat) / 180 * 1000 };
  }

  // single-flight mini-map: dep/arr = [name,city,cc,lat,lon,tz]; pos = {lat,lon,track} or null.
  // Handles the antimeridian: if the points span >180° lon, unwrap x by +2000 and tile the
  // world map so trans-Pacific routes draw the short way instead of across the whole globe.
  function miniMapSvg(dep, arr, pos) {
    var raw = [];
    if (dep) raw.push(project(dep[3], dep[4]));
    if (arr) raw.push(project(arr[3], arr[4]));
    if (pos) raw.push(project(pos.lat, pos.lon));
    if (!raw.length) return "";

    var xsRaw = raw.map(function (p) { return p.x; });
    var wrap = (Math.max.apply(null, xsRaw) - Math.min.apply(null, xsRaw)) > 1000; // > 180°
    function ux(x) { return wrap && x < 1000 ? x + 2000 : x; } // unwrap left points to the right

    var P = {};
    if (dep) { var d = project(dep[3], dep[4]); P.dep = { x: ux(d.x), y: d.y }; }
    if (arr) { var a = project(arr[3], arr[4]); P.arr = { x: ux(a.x), y: a.y }; }
    if (pos) { var p = project(pos.lat, pos.lon); P.pos = { x: ux(p.x), y: p.y }; }

    var upts = [P.dep, P.arr, P.pos].filter(Boolean);
    var xs = upts.map(function (q) { return q.x; }), ys = upts.map(function (q) { return q.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var padX = Math.max((maxX - minX) * 0.35, 40), padY = Math.max((maxY - minY) * 0.35, 30);
    var vbX = minX - padX, vbY = minY - padY, vbW = (maxX - minX) + 2 * padX, vbH = (maxY - minY) + 2 * padY;
    var targetAR = 1.6, ar = vbW / vbH;
    if (ar > targetAR) { var nh = vbW / targetAR; vbY -= (nh - vbH) / 2; vbH = nh; }
    else if (ar < targetAR) { var nw = vbH * targetAR; vbX -= (nw - vbW) / 2; vbW = nw; }

    var body = Object.keys(window.WORLD_PATHS).map(function (cc) {
      return '<path d="' + window.WORLD_PATHS[cc] + '" fill="#1B2440" stroke="rgba(255,255,255,.06)" stroke-width="0.5"/>';
    }).join("");
    // draw the world once, plus a copy shifted +2000 so the map is continuous across the seam
    var paths = '<g>' + body + "</g>" + (wrap ? '<g transform="translate(2000,0)">' + body + "</g>" : "");

    var arc = "";
    if (P.dep && P.arr) {
      var mx = (P.dep.x + P.arr.x) / 2, my = (P.dep.y + P.arr.y) / 2 - Math.abs(P.arr.x - P.dep.x) * 0.12 - 8;
      arc = '<path d="M' + P.dep.x.toFixed(1) + "," + P.dep.y.toFixed(1) + " Q" + mx.toFixed(1) + "," + my.toFixed(1) +
        " " + P.arr.x.toFixed(1) + "," + P.arr.y.toFixed(1) + '" fill="none" stroke="rgba(79,195,247,.5)" stroke-width="1.5" stroke-dasharray="4 3"/>';
    }
    var dots = "";
    if (P.dep) dots += '<circle cx="' + P.dep.x.toFixed(1) + '" cy="' + P.dep.y.toFixed(1) + '" r="4" fill="#8A93A8"/>';
    if (P.arr) dots += '<circle cx="' + P.arr.x.toFixed(1) + '" cy="' + P.arr.y.toFixed(1) + '" r="4" fill="#8A93A8"/>';
    var plane = "";
    if (P.pos) {
      plane = '<g transform="translate(' + P.pos.x.toFixed(1) + "," + P.pos.y.toFixed(1) + ") rotate(" + (pos.track || 0).toFixed(0) + ')">' +
        '<circle r="7" fill="rgba(79,195,247,.25)"/>' +
        '<path d="M0,-7 L4,5 L0,2 L-4,5 Z" fill="#4FC3F7"/></g>';
    }
    return '<svg viewBox="' + vbX.toFixed(1) + " " + vbY.toFixed(1) + " " + vbW.toFixed(1) + " " + vbH.toFixed(1) +
      '" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' +
      paths + arc + dots + plane + "</svg>";
  }

  function mapSvg(airportCounts, flights, visitedCountries) {
    var paths = [];
    Object.keys(window.WORLD_PATHS).forEach(function (cc) {
      var visited = visitedCountries[cc];
      paths.push('<path d="' + window.WORLD_PATHS[cc] + '" fill="' +
        (visited ? "rgba(79,195,247,.35)" : "#1B2440") + '" stroke="' +
        (visited ? "#4FC3F7" : "rgba(255,255,255,.05)") + '" stroke-width="' + (visited ? 1.5 : 0.5) + '"/>');
    });

    var lines = [];
    flights.forEach(function (f) {
      var a = window.AIRPORTS[f.dep_iata], b = window.AIRPORTS[f.arr_iata];
      if (!a || !b) return;
      var p1 = project(a[3], a[4]), p2 = project(b[3], b[4]);
      // simple curved arc (quadratic, lifted midpoint)
      var mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 - Math.abs(p2.x - p1.x) * 0.12 - 12;
      lines.push('<path d="M' + p1.x.toFixed(1) + "," + p1.y.toFixed(1) + " Q" + mx.toFixed(1) + "," +
        my.toFixed(1) + " " + p2.x.toFixed(1) + "," + p2.y.toFixed(1) +
        '" fill="none" stroke="rgba(79,195,247,.5)" stroke-width="1.5"/>');
    });

    var dots = [];
    Object.keys(airportCounts).forEach(function (ia) {
      var a = window.AIRPORTS[ia];
      if (!a) return;
      var p = project(a[3], a[4]);
      dots.push('<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
        '" r="5" fill="#4FC3F7"><title>' + esc(ia) + "</title></circle>");
    });

    // crop to 0..830 vertically (drop most of Antarctica) for a tighter view
    return '<svg viewBox="0 55 2000 780" xmlns="http://www.w3.org/2000/svg">' +
      paths.join("") + lines.join("") + dots.join("") + "</svg>";
  }

  // ---------- settings page ----------

  function renderSettings() {
    var s = API.getSettings();
    var mode = API.mode();
    var pending = API.pendingCount();

    var html =
      '<div class="settings-card"><div class="section-label" style="margin-top:0">' + esc(L.settings.backendSection) +
      (mode === "local" ? '<span class="badge">' + esc(L.settings.localMode) + "</span>" : "") +
      (pending ? '<span class="badge">' + esc(L.settings.pendingBadge.replace("{n}", pending)) + "</span>" : "") +
      "</div>" +
      field("set-url", L.settings.backendUrl, inp("set-url", s.backendUrl, "https://script.google.com/macros/s/…/exec")) +
      field("set-token", L.settings.token, inp("set-token", s.token, "", "password")) +
      '<button class="btn small" id="btn-test">' + esc(L.settings.testConnection) + "</button> " +
      '<button class="btn small primary" id="btn-savebe">' + esc(L.settings.saveBackend) + "</button>" +
      '<div class="msg" id="be-msg"></div></div>' +

      '<div class="settings-card"><div class="section-label" style="margin-top:0">' + esc(L.settings.calendarSection) + "</div>" +
      '<p class="help">' + esc(L.settings.calendarHint) + "</p>" +
      '<button class="btn" id="btn-syncall">' + esc(L.settings.syncAll) + "</button>" +
      '<button class="btn" id="btn-feed">' + esc(L.settings.copyFeed) + "</button>" +
      '<button class="btn" id="btn-exportall">' + esc(L.settings.exportAll) + "</button>" +
      '<div class="msg" id="cal-msg"></div></div>' +

      '<div class="settings-card"><div class="section-label" style="margin-top:0">' + esc(L.settings.importSection) + "</div>" +
      '<input type="file" id="ics-file" accept=".ics,text/calendar" class="hidden">' +
      '<button class="btn" id="btn-importics">' + esc(L.settings.importIcs) + "</button>" +
      '<div class="field full" style="margin-top:10px"><label>' + esc(L.settings.importJson) + "</label>" +
      '<textarea id="json-import" rows="3" placeholder="' + esc(L.settings.importJsonPh) + '"></textarea></div>' +
      '<button class="btn small" id="btn-previewjson">' + esc(L.settings.importPreview) + "</button>" +
      '<div id="import-preview"></div><div class="msg" id="imp-msg"></div></div>' +

      '<div class="settings-card"><div class="section-label" style="margin-top:0">' + esc(L.settings.telegramSection) + "</div>" +
      '<button class="btn" id="btn-tg">' + esc(L.settings.testTelegram) + "</button>" +
      '<div class="msg" id="tg-msg"></div></div>' +

      '<div class="settings-card"><div class="section-label" style="margin-top:0">' + esc(L.settings.aboutSection) + "</div>" +
      '<p class="help">' + esc(L.settings.version) + " " + APP_VERSION +
      (API.syncedAt() ? " · synced " + new Date(API.syncedAt()).toLocaleString() : "") + "</p>" +
      '<button class="btn small" id="btn-update">' + esc(L.settings.checkUpdate) + "</button>" +
      '<div class="msg" id="about-msg"></div></div>';

    $("#settings-body").innerHTML = html;

    function m(id, text, cls) { var el = $(id); el.textContent = text; el.className = "msg " + (cls || "dim"); }

    $("#btn-test").addEventListener("click", function () {
      var url = $("#set-url").value.trim(), token = $("#set-token").value.trim();
      if (!url || !token) { m("#be-msg", L.settings.testOkLocal); return; }
      m("#be-msg", L.settings.testing);
      fetch(url + "?action=ping").then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "ping failed");
        return fetch(url + "?" + new URLSearchParams({ action: "list", token: token })).then(function (r) { return r.json(); });
      }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "auth failed");
        m("#be-msg", L.settings.testOk.replace("{n}", res.flights.length), "ok");
      }).catch(function (e) { m("#be-msg", L.settings.testFail + ": " + e.message, "err"); });
    });

    $("#btn-savebe").addEventListener("click", function () {
      // capture local flights BEFORE refresh overwrites the mirror, so a first
      // connection to an empty backend migrates them up instead of wiping them
      var localFlights = API.flights();
      API.saveSettings({ backendUrl: $("#set-url").value.trim(), token: $("#set-token").value.trim() });
      m("#be-msg", L.common.loading);
      API.flushPending()
        .then(function () { return API.refresh(); })
        .then(function (backendFlights) {
          if ((!backendFlights || !backendFlights.length) && localFlights.length)
            return API.bulkUpsert(localFlights).then(function () { return API.refresh(); });
        })
        .then(function () {
          renderSettings(); // rebuilds the DOM — write the outcome message afterwards
          m("#be-msg", L.common.ok, "ok");
        })
        .catch(function (e) { m("#be-msg", L.settings.testFail + ": " + e.message, "err"); });
    });

    $("#btn-syncall").addEventListener("click", function () {
      if (API.mode() !== "backend") { m("#cal-msg", L.detail.fetchNoBackend, "err"); return; }
      m("#cal-msg", L.common.loading);
      API.syncCalendar(true).then(function (res) {
        if (res.ok) m("#cal-msg", L.detail.synced + " (" + res.synced + ")", "ok");
        else m("#cal-msg", L.detail.syncFailed + ": " + (res.error || ""), "err");
      }).catch(function (e) { m("#cal-msg", L.detail.syncFailed + ": " + e.message, "err"); });
    });

    $("#btn-feed").addEventListener("click", function () {
      var url = API.icsFeedUrl();
      if (!url) { m("#cal-msg", L.detail.fetchNoBackend, "err"); return; }
      navigator.clipboard.writeText(url).then(function () { m("#cal-msg", L.settings.feedCopied, "ok"); })
        .catch(function () { prompt("ICS feed URL:", url); });
    });

    $("#btn-exportall").addEventListener("click", function () {
      window.ICS.exportAll(API.flights());
    });

    $("#btn-importics").addEventListener("click", function () { $("#ics-file").click(); });
    $("#ics-file").addEventListener("change", function () {
      var file = this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { icsImportPreview(String(reader.result)); };
      reader.readAsText(file);
    });

    $("#btn-previewjson").addEventListener("click", function () {
      var raw = $("#json-import").value.trim();
      if (!raw) return;
      try {
        var arr = JSON.parse(raw);
        if (!Array.isArray(arr)) throw new Error("expected a JSON array");
        showImportPreview(arr);
      } catch (e) { m("#imp-msg", String(e.message || e), "err"); }
    });

    $("#btn-tg").addEventListener("click", function () {
      if (API.mode() !== "backend") { m("#tg-msg", L.detail.fetchNoBackend, "err"); return; }
      m("#tg-msg", L.common.loading);
      API.testTelegram().then(function (res) {
        if (res.ok) m("#tg-msg", L.settings.telegramSent, "ok");
        else m("#tg-msg", L.common.error + ": " + (res.error || ""), "err");
      }).catch(function (e) { m("#tg-msg", L.common.error + ": " + e.message, "err"); });
    });

    $("#btn-update").addEventListener("click", function () {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg) reg.update();
          m("#about-msg", L.common.ok, "ok");
        });
      }
    });
  }

  // ---------- .ics import ----------

  function icsImportPreview(text) {
    var flights = [];
    try {
      var jcal = window.ICAL.parse(text);
      var comp = new window.ICAL.Component(jcal);
      comp.getAllSubcomponents("vevent").forEach(function (ve) {
        var ev = new window.ICAL.Event(ve);
        var summary = ev.summary || "";
        var fm = /\b([A-Z]{1,2}[0-9]{1,2}?[A-Z]?\s?\d{1,4})\b/.exec(summary.replace(/\s+/g, ""));
        var rm = /([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})/.exec(summary);
        var depIata = rm ? rm[1] : "", arrIata = rm ? rm[2] : "";
        var depTz = (window.AIRPORTS[depIata] || [])[5];
        var arrTz = (window.AIRPORTS[arrIata] || [])[5];
        var depJs = ev.startDate ? ev.startDate.toJSDate() : null;
        var arrJs = ev.endDate ? ev.endDate.toJSDate() : null;
        flights.push({
          flight_no: fm ? fm[1].replace(/\s+/g, "") : "",
          dep_iata: depIata, arr_iata: arrIata,
          dep_time_local: depJs && depTz ? wallIso(depJs, depTz) : (depJs ? isoLocal(depJs) : ""),
          arr_time_local: arrJs && arrTz ? wallIso(arrJs, arrTz) : (arrJs ? isoLocal(arrJs) : ""),
          status: "flown",
          notes: "Imported from .ics" + (summary ? " — " + summary : ""),
        });
      });
    } catch (e) {
      $("#imp-msg").textContent = String(e.message || e);
      $("#imp-msg").className = "msg err";
      return;
    }
    flights = flights.filter(function (f) { return f.dep_time_local; });
    if (!flights.length) {
      $("#imp-msg").textContent = L.settings.importNone;
      $("#imp-msg").className = "msg dim";
      return;
    }
    showImportPreview(flights);
  }

  function wallIso(jsDate, tz) {
    var dtf = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return dtf.format(jsDate).replace(" ", "T");
  }
  function isoLocal(d) {
    function z(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + "T" + z(d.getHours()) + ":" + z(d.getMinutes());
  }

  function showImportPreview(flights) {
    var rows = flights.map(function (f) {
      return "<tr><td>" + esc(f.flight_no || "?") + "</td><td>" + esc(f.dep_iata || "?") + "→" + esc(f.arr_iata || "?") +
        "</td><td>" + esc(f.dep_time_local || "") + "</td><td>" + esc(f.status || "") + "</td></tr>";
    }).join("");
    $("#import-preview").innerHTML =
      '<div class="preview-wrap"><table class="preview-table"><tr><th>Flight</th><th>Route</th><th>Departs</th><th>Status</th></tr>' +
      rows + "</table></div>" +
      '<button class="btn primary" id="btn-doimport">' +
      esc(L.settings.importConfirm.replace("{n}", flights.length)) + "</button>";
    $("#btn-doimport").addEventListener("click", function () {
      var valid = flights.filter(function (f) { return f.flight_no && f.dep_iata && f.arr_iata && f.dep_time_local; });
      API.bulkUpsert(valid).then(function (res) {
        $("#imp-msg").textContent = L.settings.importDone
          .replace("{c}", res.created != null ? res.created : "?")
          .replace("{u}", res.updated != null ? res.updated : "?");
        $("#imp-msg").className = "msg ok";
        $("#import-preview").innerHTML = "";
      }).catch(function (e) {
        $("#imp-msg").textContent = String(e.message || e);
        $("#imp-msg").className = "msg err";
      });
    });
  }

  // ---------- service worker + update banner ----------

  function initSw() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      function watch(worker) {
        worker.addEventListener("statechange", function () {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(reg);
        });
      }
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
      if (reg.installing) watch(reg.installing);
      reg.addEventListener("updatefound", function () { if (reg.installing) watch(reg.installing); });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && navigator.serviceWorker.getRegistration)
        navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); });
    });
    var refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshed) return; refreshed = true; location.reload();
    });
  }

  function showUpdateBanner(reg) {
    var b = $("#update-banner");
    b.classList.remove("hidden");
    b.onclick = function () { if (reg.waiting) reg.waiting.postMessage("skipWaiting"); };
  }

  // ---------- offline badge ----------

  function updateOfflineBadge() {
    var b = $("#offline-banner");
    if (!navigator.onLine && API.mode() === "backend") {
      var t = API.syncedAt();
      b.textContent = L.settings.offlineBadge.replace("{t}", t ? new Date(t).toLocaleString() : "—");
      b.classList.remove("hidden");
    } else b.classList.add("hidden");
  }
  window.addEventListener("online", updateOfflineBadge);
  window.addEventListener("offline", updateOfflineBadge);

  // ---------- boot ----------

  document.addEventListener("DOMContentLoaded", function () {
    // static labels
    document.title = L.appName;
    $("#tab-trips-label").textContent = L.tabs.trips;
    $("#tab-stats-label").textContent = L.tabs.stats;
    $("#tab-settings-label").textContent = L.tabs.settings;
    $("#trips-title").textContent = L.appName;
    $("#stats-title").textContent = L.stats.title;
    $("#settings-title").textContent = L.settings.title;
    $("#update-banner").textContent = L.settings.updateBanner;
    $("#fab").addEventListener("click", function () { location.hash = "#/new"; });

    API.onChange(render);
    window.addEventListener("hashchange", route);
    route();
    updateOfflineBadge();
    initSw();

    if (API.mode() === "backend") {
      API.flushPending().then(function () { return API.refresh(); }).catch(function () {});
    }
  });
})();
