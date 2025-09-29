# Virtual Line • Fresh Project (based on updated full)

This is a clean fork of your updated-full build, ready to push to a new GitHub repo and deploy on Render.

## What’s included
- Full app code from your previous build
- `.env.example` with all the expected variables
- `render.yaml` preconfigured for Node 20 and SQLite by default
- Keeps product choices: Soybean Meal, Soy Hulls, Soyhull Pellets
- Geofence defaults (250 m radius, 5 min pings)

## Quick Start
```bash
# 1) install deps
npm ci

# 2) copy env file
cp .env.example .env
# fill the secrets in .env

# 3) run dev
npm run dev  # or: node index.js
```

## Deploy to Render
- Create a new GitHub repo and push this project.
- Create a new Web Service from Render.
- Render auto-detects `render.yaml`. Fill secrets in the dashboard.
- If you choose Postgres, set `DATABASE_URL` and remove/ignore `SQLITE_DB`.

## Environment Variables
- NODE_ENV, PORT, BASE_URL
- SESSION_SECRET
- SQLITE_DB or DATABASE_URL
- TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM
- GOOGLE_MAPS_API_KEY
- GEOFENCE_RADIUS_M, GEO_PING_INTERVAL_MIN
- PRODUCT_CHOICES

---
Generated on 2025-09-28T22:09:07


## Postgres wiring (Render)
- Set `DATABASE_URL` on Render (add a Render PostgreSQL instance and copy the Internal Connection URL).
- `render.yaml` now runs `node server/migrate-pg.js` on build to initialize tables.
- App auto-detects Postgres if `DATABASE_URL` is present; otherwise falls back to SQLite (local dev).
- Service name is **VirtualLineCargill**.

Updated on 2025-09-28T22:30:55


## Public Dashboard
- Page: `/line.html` (no auth)
- API: `GET /api/public/:site/line` → { en_route_count, queued:[{masked phone, arrival time, product, load#}], en_route_eta: [...] }

## Driver En Route declaration
- `POST /api/queue/enroute` with `{ site, phone, eta_minutes? }`  
  Sets status to **EN_ROUTE**, stamps `enroute_at`, and optionally stores ETA.

## Multi-day History & Analytics
- `GET /api/admin/history/:site?start=YYYY-MM-DD&end=YYYY-MM-DD` → includes `analytics` (avg wait & total minutes)
- `GET /api/admin/history/:site/export.csv?start=...&end=...` → CSV for range
- Wait time = `loading_at - arrived_at`; Total time = `departed_at - arrived_at`

## Admin ETA assist
- On `/admin-queue.html`, **En Route + ETA** button prompts minutes, updates status and ETA on the truck.


## Anomaly alerts & Daily Digest
- **Scheduler** runs every minute:
  - ETA passed ⇒ SMS to driver with a link to `/driver-eta.html?truck=<id>` to confirm **Arrived**, set **new ETA**, or **Cancel**.
  - Long wait (ARRIVED→not LOADING for `ALERT_WAIT_MIN`, default 90) ⇒ SMS to `ALERT_SMS_TO` (or `ADMIN_PHONE`).
  - Daily digest at `DIGEST_HOUR_LOCAL` (default 18): per-site counts + average wait/total times via Email/SMS.
- **Env:** `ALERT_WAIT_MIN`, `DIGEST_HOUR_LOCAL`, `BASE_URL`, Twilio creds, and SMTP creds (`SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, DIGEST_TO`, optional).

## New Pages
- Public dashboard: `/line.html`
- Driver ETA: `/driver-eta.html?truck=<id>`
- Admin history UI: `/admin-history.html`


## Inbound SMS (Twilio webhook)
- **Webhook:** `POST /twilio/sms` (set this as your Messaging webhook in Twilio)
- **Supported commands:**  
  `ARRIVED` • `LOADING` • `DEPARTED` • `ETA <minutes>` • `CANCEL` • `HELP`  
  Optional: include site code keyword (e.g., `CIF` or `CCR`) if the number has no active record today.
- If no record exists for the phone today, a new **EN_ROUTE** record is created (uses the first site or the site code hint if present).
- **Response:** TwiML `<Message>` confirms the update.

> Security: for production, consider verifying `X-Twilio-Signature` against your webhook URL + params using your Twilio auth token.


## Separate Delivery Line
- New `line_type` on `trucks`: `'LOAD'` (default) or `'DELIVER'`.
- **Admin Queue**: Line selector (Loading vs Delivery) — labels switch to **Unloading** for delivery line.
- **Public Dashboard**: Line selector; API accepts `?type=LOAD|DELIVER`.
- **Driver Check-in (Delivery)**: `/driver-checkin-delivery.html` posts `line_type=DELIVER` to reuse same flow.
- **History APIs**: optional `?type=LOAD|DELIVER|ALL` filter; analytics still compute using `arrived_at`→`loading_at` (labeled Unloading in UI for delivery).
- **Inbound SMS**: recognize `UNLOADING` and keywords `DELIVER`/`UNLOAD` to create a delivery-line record if none exists.



## Public + Driver Hub
- **Page:** `/hub.html` — combines public queues for **both lines** at a site and provides driver buttons:
  - **I'm picking up** → `/driver-checkin.html?site=<SITE>`
  - **I'm delivering** → `/driver-checkin-delivery.html?site=<SITE>`
- **API:** `GET /api/public/:site/lines` returns `{ lines: { load:{...}, deliver:{...} }, total_en_route }`.
- Legacy `/line.html` now redirects to `/hub.html`.


## FINAL build
- Includes delivery line, inbound SMS, public hub, QR landing with hours, and auto-sync of CCR delivery hours.
