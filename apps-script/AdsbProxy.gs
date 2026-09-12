// AdsbProxy.gs — live position proxy over adsb.lol (community ADS-B, no API key).
// Only used to draw the ONE flight you're viewing on a mini-map; poll gently (~60s).
// AeroDataBox's free tier has no live GPS, so this is a separate, unmetered source.

var ADSB_HOST = "https://api.adsb.lol/v2";

function positionLookup_(hex, reg, callsign) {
  var url = null;
  if (hex) url = ADSB_HOST + "/hex/" + encodeURIComponent(String(hex).toLowerCase().trim());
  else if (reg) url = ADSB_HOST + "/reg/" + encodeURIComponent(String(reg).toUpperCase().trim());
  else if (callsign) url = ADSB_HOST + "/callsign/" + encodeURIComponent(String(callsign).toUpperCase().replace(/\s+/g, ""));
  else return { ok: false, error: "no_identifier" };

  var resp;
  try {
    resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    return { ok: false, error: "fetch_failed" };
  }
  if (resp.getResponseCode() !== 200) return { ok: false, error: "http_" + resp.getResponseCode() };

  var body;
  try { body = JSON.parse(resp.getContentText()); } catch (e) { return { ok: false, error: "bad_json" }; }
  var ac = (body && body.ac) || [];
  // pick the first entry that actually has a position fix
  var a = null;
  for (var i = 0; i < ac.length; i++) {
    if (ac[i] && typeof ac[i].lat === "number" && typeof ac[i].lon === "number") { a = ac[i]; break; }
  }
  if (!a) return { ok: true, airborne: false }; // known aircraft but not currently transmitting a position

  return {
    ok: true,
    airborne: true,
    data: {
      lat: a.lat,
      lon: a.lon,
      altFt: (typeof a.alt_baro === "number") ? a.alt_baro : null,
      groundSpeedKt: (typeof a.gs === "number") ? a.gs : null,
      track: (typeof a.track === "number") ? a.track : null,
      callsign: (a.flight || "").trim(),
      reg: a.r || "",
      hex: a.hex || "",
      seenSec: (typeof a.seen_pos === "number") ? a.seen_pos : null,
    },
  };
}
