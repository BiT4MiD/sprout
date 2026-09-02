# Sprout Control Centre — API contract

Base URL `http://localhost:8787` in development. All bodies are JSON.
All timestamps are UTC epoch milliseconds. All `local_date` values are
`YYYY-MM-DD` **computed on the client**, in the user's own timezone.

There are two callers and they authenticate differently:

| Caller | Credential | Sent as |
| --- | --- | --- |
| Dashboard (browser) | Session cookie `sprout_sid`, `HttpOnly; SameSite=Lax; Secure` in production | Cookie, plus `X-CSRF-Token` on writes |
| Extension | Device token, issued once at pairing, never expires until revoked | `Authorization: Bearer <token>` |

A route is marked **[S]** for session-only, **[D]** for device-only, **[SD]** for either.

---

## Errors

Every failure returns the same shape, so the client has one code path:

```json
{ "error": { "code": "invalid_credentials", "message": "Email or password is incorrect." } }
```

| HTTP | `code` values |
| --- | --- |
| 400 | `validation_failed` (adds `fields: {name: reason}`) |
| 401 | `not_authenticated`, `invalid_credentials`, `invalid_token` |
| 403 | `csrf_failed`, `forbidden` |
| 404 | `not_found` |
| 409 | `email_taken`, `sync_conflict` |
| 410 | `pairing_code_expired` |
| 429 | `rate_limited` (adds `retry_after_ms`) |
| 500 | `internal_error` |

Never leak whether an email exists: signup with a taken address and a
password reset for an unknown address both return 200 with a neutral message.

---

## Auth

### `POST /api/auth/signup`
```json
{ "email": "you@example.com", "password": "…", "displayName": "Bit", "timezone": "America/New_York" }
```
→ `201` `{ "user": { "id", "email", "displayName", "timezone" } }`, sets the session cookie.
Password rules: ≥ 10 characters, checked against a small common-password list. Hashed with scrypt (N=2^15, r=8, p=1).

### `POST /api/auth/login`
`{ "email", "password" }` → `200` `{ "user" }` + cookie.
Rate limited to 5 attempts / 15 min / IP+email pair; failures are constant-time.

### `POST /api/auth/logout` **[S]**
Revokes the current session. → `204`

### `GET /api/auth/me` **[S]**
→ `{ "user": { … }, "csrfToken": "…" }`. The dashboard calls this on boot; a 401 means show the login screen.

### `POST /api/auth/password` **[S]**
`{ "currentPassword", "newPassword" }` → `204`. Revokes every *other* session.

---

## Devices & pairing

The extension never sees the user's password. Pairing is a one-time code.

```
Dashboard                     Server                     Extension
    │  POST /api/devices/pair-code │                          │
    │─────────────────────────────>│                          │
    │  { code: "K7M2-9QXB",        │                          │
    │    expiresAt }               │                          │
    │<─────────────────────────────│                          │
    │                              │                          │
    │        user types the code into the extension ─────────>│
    │                              │  POST /api/devices/redeem│
    │                              │<─────────────────────────│
    │                              │  { token, deviceId }     │
    │                              │─────────────────────────>│
```

### `POST /api/devices/pair-code` **[S]**
→ `{ "code": "K7M29QXB", "expiresAt": 1788… }`. Valid 10 minutes, single use. Only one live code per user; requesting a new one invalidates the previous.

### `POST /api/devices/redeem` *(no auth)*
```json
{ "code": "K7M29QXB", "name": "Chrome on bitmid", "platform": "Windows", "extensionVersion": "1.3.0" }
```
→ `201` `{ "token": "spr_dev_…", "deviceId": 3, "user": { "email", "displayName" } }`
The token is shown **once**; only its SHA-256 is stored. Rate limited to 10 attempts / hour / IP to make code guessing pointless (8 Crockford-base32 chars ≈ 10¹² space).

### `GET /api/devices` **[S]**
→ `{ "devices": [ { "id", "name", "platform", "extensionVersion", "lastSyncAt", "createdAt", "current": false } ] }`

### `DELETE /api/devices/:id` **[S]**
Revokes the token. The extension's next sync gets `401 invalid_token` and falls back to local-only mode. → `204`

---

## Sync — the one endpoint the extension lives on

One round trip carries telemetry up and configuration down. Called by a
`chrome.alarms` tick (default every 5 minutes) and immediately after a
session ends.

### `POST /api/sync` **[D]**

```json
{
  "sinceVersion": 41,
  "timezone": "America/New_York",
  "push": {
    "usage":    [ { "localDate": "2026-09-02", "domain": "reddit.com", "seconds": 840, "category": "distracting" } ],
    "sessions": [ { "clientUuid": "…", "localDate": "2026-09-02", "startedAt": 1788…, "endedAt": 1788…,
                    "plannedMin": 25, "actualSeconds": 1500, "intention": "Ship the theme system",
                    "outcome": "accomplished", "alignmentScore": 100 } ],
    "blocks":   [ { "clientUuid": "…", "domain": "reddit.com", "localDate": "2026-09-02",
                    "localHour": 14, "occurredAt": 1788…, "outcome": "blocked" } ],
    "tasks":    [ { "clientUuid": "…", "text": "Ship v1.3", "done": true, "sortOrder": 1,
                    "createdAt": 1788…, "completedAt": 1788…, "deletedAt": null } ],
    "deviceSettings": { "theme": "ocean", "appearance": "dark" }
  }
}
```

→

```json
{
  "version": 43,
  "changed": true,
  "settings": { "pomodoro": 25, "dailyGoalMin": 120, "blockMode": "deep_work", "…": "…" },
  "rules":   [ { "pattern": "reddit.com", "kind": "block", "shieldType": null, "enabled": true, "scheduleId": null } ],
  "schedules": [ { "id": 1, "name": "Work hours", "daysMask": 62, "startMin": 540, "endMin": 1020, "enabled": true } ],
  "tasks":   [ { "clientUuid": "…", "text": "Ship v1.3", "done": true, "sortOrder": 1 } ],
  "serverTime": 1788…
}
```

**Rules of the protocol**

1. *Push is idempotent.* Sessions, blocks and tasks carry a `clientUuid`; the
   server upserts on `(user_id, client_uuid)`. A retried request after a
   flaky network cannot double-count a sprint.
2. *Usage is absolute, not a delta.* The extension sends the running total for
   the day, and the server takes `MAX(existing, incoming)` per
   `(date, domain, device)`. A lost request self-heals on the next tick;
   a replayed one changes nothing.
3. *Config flows one way — server wins.* Anything on the dashboard
   (rules, schedules, goals, AI config, Labs) is authoritative. The
   extension applies what it receives. This is what stops two browsers
   fighting over the block list.
4. *Device-scoped settings flow the other way.* `theme`, `appearance`,
   `floatingWidget`, `audioVolume`, `soundscapeId` belong to one browser
   and are pushed, never pulled.
5. *`sinceVersion` keeps it cheap.* If `sinceVersion` equals the user's
   current `sync_version`, the reply is `{ version, changed: false }` and
   nothing else — the normal case, a few hundred bytes.
6. *Offline is the default assumption.* Every sync failure is non-fatal;
   the extension keeps working entirely from `chrome.storage.local` and
   drains its queue when the server comes back.

---

## Dashboard data

All **[S]**. These are what make the web app worth opening — none of it
is computable from what the extension stores today.

### `GET /api/stats/summary?range=24h|7d|30d|year|all`
```json
{
  "range": "7d",
  "focusSeconds": 34200, "focusSecondsPrev": 28800, "deltaPct": 18.75,
  "sessions": 14, "sessionsCompleted": 11, "completionRate": 0.79,
  "blocks": 62, "streak": 6, "longestStreak": 11,
  "goalMinutes": 120, "goalHitDays": 4, "goalDays": 7,
  "categories": { "productive": 18000, "research": 7200, "neutral": 3600, "distracting": 5400 }
}
```

### `GET /api/stats/timeseries?range=30d&bucket=day|hour`
`{ "points": [ { "date": "2026-08-04", "focusSeconds": 4200, "distractingSeconds": 900, "blocks": 3 } ] }`
Feeds the heatmap and the trend chart.

### `GET /api/stats/domains?range=7d&limit=50&category=distracting`
`{ "domains": [ { "domain", "seconds", "category", "sharePct", "blocked": true, "trendPct": -12 } ] }`

### `GET /api/stats/hourly?range=30d`
`{ "hours": [ { "hour": 0, "focusSeconds": 0, "distractionEvents": 2 }, … ] }`
Answers "when am I actually sharp?" and "when do I reach for Reddit?" — the peak-hour figure the extension guesses from browser history, computed from real data.

### `GET /api/stats/sessions?range=30d&cursor=…`
Paginated session log with intention, outcome, alignment score and duration — a scrollable history instead of a single counter.

### `GET /api/stats/export?format=csv|json&range=all`
Streams the full dataset. `Content-Disposition: attachment`.

---

## Settings & rules

### `GET /api/settings` **[SD]**
`{ "version": 43, "settings": { … }, "scopes": { "theme": "device", "pomodoro": "account" } }`

### `PATCH /api/settings` **[S]**
`{ "pomodoro": 45, "dailyGoalMin": 180 }` → `{ "version": 44, "settings": { … } }`
Partial merge. Unknown keys are rejected with `validation_failed` rather than stored, so a typo can't quietly create a dead setting.

### `GET /api/rules` **[S]**
`{ "rules": [ … ], "schedules": [ … ] }`

### `POST /api/rules` **[S]** — `{ "pattern", "kind", "shieldType?", "scheduleId?", "note?" }`
### `PATCH /api/rules/:id` **[S]** — any subset of the above plus `enabled`
### `DELETE /api/rules/:id` **[S]**
### `POST /api/rules/bulk` **[S]** — `{ "patterns": "reddit.com\nnews.ycombinator.com", "kind": "block" }`
  Parses a pasted list, normalises each domain, skips never-blockable hosts, returns `{ "added": [...], "skipped": [...] }`.

### `GET|POST /api/schedules`, `PATCH|DELETE /api/schedules/:id` **[S]**

---

## Account

### `GET /api/account/audit?limit=50` **[S]**
Recent logins, pairings and revocations, so an unexpected entry is visible.

### `POST /api/account/export` **[S]** — full data export as one JSON file.
### `DELETE /api/account` **[S]** — `{ "password" }`, cascades to every table.
