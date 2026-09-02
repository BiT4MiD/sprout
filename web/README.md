# Sprout Control Centre

The web dashboard and sync server for the Sprout browser extension.

> **Status: built.** Auth, pairing, sync, analytics and the dashboard are
> implemented and covered by 19 tests, including a full extension-to-server
> round trip driven through a real Chromium.

**Zero npm dependencies.** `node:sqlite` (Node 22+) for storage, `node:http`
for the server, `node:crypto` for hashing. There is nothing to install.

## Run it

```bash
cd web
cp .env.example .env          # then set SESSION_SECRET
npm run seed                  # demo account with 90 days of history
npm start                     # http://localhost:8787
```

Sign in as `demo@sprout.local` / `sprout demo account` to see every screen
populated, or create your own account and pair a browser.

```bash
npm test             # 19 tests, ~1s
npm run migrate      # apply src/db/schema.sql to an empty database
npm run sync-theme   # re-copy themes.css from the extension after a change
```

## Pairing a browser

1. Load the extension (`chrome://extensions` → Load unpacked → the parent folder).
2. On the dashboard: **Devices → Pair a browser**. A code appears, good for 10 minutes.
3. In the extension: **Settings → Control Centre**, paste the code, Connect.

The extension immediately uploads everything it has stored locally, so nobody
loses their history by signing up. From then on it syncs every 5 minutes and
right after each finished sprint.

## Layout

```
web/
├── docs/
│   ├── API.md               ← the contract. Read this first.
│   └── POPUP-MIGRATION.md   ← what leaves the popup and where it lands
├── src/
│   ├── index.js             ← HTTP entry (real, runnable)
│   ├── config.js            ← env loading and tuning knobs
│   ├── db/
│   │   ├── schema.sql       ← 13 tables (real, validated)
│   │   ├── index.js         ← connection + transaction helper
│   │   ├── migrate.js
│   │   └── seed.js
│   ├── auth/                ← scrypt passwords, opaque sessions, guards
│   ├── routes/              ← thin: validate → service → respond
│   ├── services/            ← all the logic and SQL
│   └── lib/                 ← router, static files, errors, validation, rate limits
├── public/
│   ├── index.html           ← sign in / create account
│   ├── app.html             ← dashboard, 11 sections (real markup)
│   └── assets/
│       ├── themes.css       ← copied from the extension — one palette for both
│       ├── theme.js         ← same runtime, adapted for the web
│       ├── api.js           ← fetch client (real)
│       ├── app.js           ← dashboard controller
│       └── auth-page.js
└── test/
```

## How it fits together

```
┌────────────────┐   pairing code (once)    ┌──────────────────┐
│   Dashboard    │─────────────────────────>│    Extension     │
│  (browser,     │                          │ (browser profile,│
│   session      │                          │  bearer token)   │
│   cookie)      │                          │                  │
└───────┬────────┘                          └────────┬─────────┘
        │ REST, cookie + CSRF                        │ POST /api/sync
        │                                            │ every 5 min
        v                                            v
┌───────────────────────────────────────────────────────────────┐
│                    Node + SQLite server                       │
│  settings · rules · schedules │ usage · sessions · blocks      │
└───────────────────────────────────────────────────────────────┘
```

Configuration flows **down** (the dashboard is authoritative). Telemetry and
this-browser preferences flow **up**. `docs/API.md` → "Sync" has the five
rules the protocol depends on.

## Design decisions worth knowing

**Why per-row telemetry.** The extension stores usage as
`timeStats[dateString][domain]` — one opaque blob that cannot be queried.
Every "more detailed information" feature you asked for (hour-of-day
patterns, per-domain trends, per-rule effectiveness, a session log) needs a
`GROUP BY`. That is the whole reason the dashboard can show more than the
popup, and it is why `usage_daily` is one row per user/day/domain.

**Why opaque session tokens, not JWTs.** "Sign out my other browsers" has to
take effect immediately. A database lookup per request costs nothing against
a local SQLite file, and revocation is a single UPDATE.

**Why a pairing code.** The extension never sees your password. A short-lived
single-use code trades for a long-lived device token that you can revoke
individually from the Devices page.

**Why settings are key/value.** The extension has ~50 storage keys and gains
more with each release. `SETTINGS_CATALOGUE` in
`src/services/settings.service.js` is the one place that defines a setting's
type, bounds, default, scope and where its control is rendered — adding a
setting is one entry there, not a migration.

**Signing in is optional.** An unpaired extension behaves exactly as it does
today, entirely offline. Sync is an enhancement; every failure path falls
back to local operation.

## Security posture

- scrypt (N=2^15) password hashing, cost parameters stored with each hash
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, plus a
  double-submit CSRF token on every unsafe request
- Only SHA-256 hashes of session secrets and device tokens are stored
- Rate limits on login, signup, pairing redemption and sync
- Neutral responses for signup and password reset — the API never reveals
  whether an email exists
- CORS reflects an allow-list; never `*` with credentials
- The Gemini API key is write-only over the API: `GET /api/settings` returns
  `hasApiKey: true`, never the value

## Charts

`public/assets/charts.js` is hand-rolled SVG — no chart library, because each
chart is under 60 lines and a library would be bigger than all of them together.

Chart colour is deliberately **not** the UI theme. Identity and magnitude
encoding has to survive a theme change, and Graphite in particular sits below
the chroma floor a categorical palette needs. The values in `app.css` under
`.viz` were validated against both surfaces: the categorical trio clears
all-pairs CVD ΔE 9.2 light / 9.4 dark with a normal-vision floor of 24.0 / 20.9,
and the heatmap ramp is one hue with monotone lightness and a light end at
2.07:1. Every chart also ships a legend and labelled values, so nothing is
carried by colour alone.

Two measures with different units are never put on one plot. "When you actually
focus" is two stacked small multiples sharing an x axis, not a dual-axis chart.

## Tests

```
npm test
```

`test/smoke.test.js` checks routing, the schema, and that every route except
signup/login/redeem/health has a guard. `test/api.test.js` drives the real HTTP
surface: signup and login, rate limiting, CSRF, catalogue validation, bulk-add
normalisation, one-time pairing codes, an idempotent sync round trip, the
MAX-merge rule, cross-account isolation, and immediate token revocation.
