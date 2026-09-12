# Flight in the Air (app00046)

Personal flight assistant PWA — an homage to the discontinued *App in the Air*, with the PRO
features built in: calendar import/export, auto-updating calendar subscription, Google Calendar
sync, flight stats with a world map, and Telegram reminders.

- **Front end**: static PWA (vanilla JS, no build step) — host on GitHub Pages, install from
  Safari via *Add to Home Screen*.
- **Back end**: Google Apps Script Web App + Google Sheet (data source of truth), AeroDataBox
  proxy (RapidAPI key stays server-side), Google Calendar sync, ICS feed, Telegram notifications.
- Works fully **on-device with no backend** (localStorage) until you configure one in Settings.

## Repo layout

| Path | Role |
|---|---|
| `index.html` `app.js` `api.js` `ics.js` `labels.js` `styles.css` | SPA (all UI strings live in `labels.js`) |
| `airports.js` | IATA → name/city/country/lat/lon/IANA-tz (OpenFlights, ODbL) + airline names |
| `vendor/worldmap.js` | equirectangular country SVG paths (Natural Earth derived) |
| `vendor/ical.js` | ical.js 1.5.0 (parsing imported .ics only) |
| `sw.js` `manifest.webmanifest` `icons/` | PWA shell (bump `CACHE_NAME` in `sw.js` each release) |
| `apps-script/*.gs` | backend source — paste into script.google.com (not served by Pages) |

## Deployment

### 1. GitHub Pages (front end)

1. Create a public repo (e.g. `app00046-flight-pwa`), push this folder.
2. Repo **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. Your app URL: `https://<user>.github.io/app00046-flight-pwa/`.

### 2. Google Sheet + Apps Script (back end)

1. Create a Google Spreadsheet named `app00046-flights-db`; copy its ID from the URL.
2. Go to [script.google.com](https://script.google.com) → New project → create one file per
   `apps-script/*.gs` and paste the contents (7 files).
3. In `Code.gs`, set `SPREADSHEET_ID`.
4. Run `setup()` once from the editor. Approve the OAuth consent
   (*unverified app → Advanced → continue*). Scopes: Sheets, Calendar, external requests, triggers.
5. **Project Settings → Script Properties** — add:
   | Key | Value |
   |---|---|
   | `API_TOKEN` | long random string (≥24 chars) — also entered in the app's Settings |
   | `RAPIDAPI_KEY` | from RapidAPI → AeroDataBox (free tier, 600 units/mo) |
   | `TELEGRAM_BOT_TOKEN` | your bot token |
   | `TELEGRAM_CHAT_ID` | your chat id |
6. **Deploy → New deployment → Web app** — *Execute as: Me*, *Who has access: Anyone*.
   Copy the `/exec` URL.
7. Run `setupTriggers()` once (installs the hourly notification cron).
8. ⚠️ **After every later code change**: Deploy → **Manage deployments → ✏️ → Version: New**.
   (Editing code without a new version is the #1 "why didn't it change" trap.)

### 3. Connect the app

Open the app → **Settings** → paste the `/exec` URL and your `API_TOKEN` → *Test connection* →
*Save & sync*. Local flights are mirrored; the Sheet becomes the source of truth.

### 4. iPhone install + calendar subscription

- **Install**: open the Pages URL in Safari → Share → *Add to Home Screen*.
- **Calendar (primary path)**: in the app press *Sync all flights to Google Calendar* once —
  this creates a dedicated **Flights** calendar. On iPhone, enable your Google account's
  calendars (Settings → Calendar → Accounts); if *Flights* doesn't appear, open
  [calendar.google.com/calendar/syncselect](https://calendar.google.com/calendar/syncselect)
  and tick it. It updates automatically whenever the backend syncs.
- **ICS feed (experimental)**: *Copy ICS feed URL* → Google Calendar → *Other calendars → From
  URL*, or iOS *Settings → Calendar → Accounts → Add Subscribed Calendar*. Note: Apps Script
  serves the feed via a 302 redirect; some clients refuse it — the Flights-calendar path above
  has no such issue. Refresh cadence is controlled by Google/Apple (8–24 h).
- **.ics file**: every flight (and *Export all*) downloads a standards-compliant .ics with a
  stable UID — re-importing updates events instead of duplicating them.

## Data model

Sheet `flights` — one row per flight, `id = {FLIGHTNO}-{YYYYMMDD}-{DEPIATA}` (never changes;
keys the ICS UID and the Calendar event). Soft delete: `status=deleted` (rows are never removed).
Other sheets: `settings` (calendar id, quota counters), `api_cache`, `notif_log` (dedupe), `log`.

## Quota guards (AeroDataBox free tier)

- Cache TTL: >48 h to departure → cached forever (`force=1` to override); 48–6 h → 6 h; <6 h → 30 min.
- Hard stops: 500 units/month, 20 live calls/day → returns stale cache + `monthly_quota`/`daily_cap`.
- Hourly cron polls live status only inside [T-48 h, T+2 h] and only every 3rd hour.

## Development

```
python -m http.server 8046   # from the repo root, then open http://localhost:8046
```

Release: bump `CACHE_NAME` in `sw.js`, commit, push — installed PWAs show an update banner
(may need one full app restart on iOS).
