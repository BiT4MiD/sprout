# Decluttering the popup

You asked for all four groups to move off the popup: Labs, AI config, site
rules, and analytics. This is the line-by-line mapping, so the second pass
is mechanical rather than a judgement call each time.

## The principle

The popup is what you touch **during** a work session — one hand, five
seconds, no reading. The dashboard is where you **think about** your focus —
configuration, history, anything with more than one input.

If a control isn't something you'd reach for mid-sprint, it moves.

---

## What stays in the popup

The popup drops from three tabs and ~40 controls to one screen with about eight.

| Control | Why it stays |
| --- | --- |
| Start / End Deep Work | The whole point of the popup |
| Sprint length presets (25 / 45 / 60 / 90) | Chosen per session, not configured |
| Intention field | Written at the moment you start |
| Today's four numbers — focus, streak, blocks, sessions | Glanceable, no interaction |
| Daily goal bar | Read-only |
| Focus checklist | Ticked during the sprint |
| "+ Guard this site" for the current tab | Reactive; the moment you notice a distraction |
| Theme + light/dark | Small, visual, per-browser, and people like fiddling with it |
| Account status + "Open dashboard" | The way out to everything else |

**Removed entirely:** the Analytics tab and the Settings tab.

---

## What moves, and where it lands

### → Dashboard · Sites & rules
| Popup control | Storage key | Note |
| --- | --- | --- |
| Site Blocking Mode | `blockMode` | Also mirrored in the popup as read-only text |
| Hardcore Lock Mode | `hardcore` | |
| Whitelist mode | `whitelist` | Moves under Labs on the dashboard |
| Guarded sites list + add field | `blacklist` | Becomes the `rules` table — per-rule notes, sources and stats |
| Quick-add link chips | — | Replaced by bulk paste |
| YouTube Shorts / comments / recommendations | `ytHideShorts` `ytHideComments` `ytHideRecs` | Become `shield` rules |
| Auto theater mode | `ytAutoTheater` | |
| Clean X/Twitter, clean Reddit | `cleanTwitter` `cleanReddit` | |
| Emergency hall pass duration | *(hard-coded 5 min)* | Becomes configurable |

### → Dashboard · Schedules
| Popup control | Storage key | Note |
| --- | --- | --- |
| Schedule enabled | `scheduleEnabled` | |
| Start / end time | `scheduleStart` `scheduleEnd` | One global window becomes **named schedules with day-of-week masks**, attachable per rule |

### → Dashboard · Focus & goals
| Popup control | Storage key |
| --- | --- |
| Default sprint length | `pomodoro` |
| Break length | `breakMinutes` |
| Daily goal minutes | `dailyGoalMin` |
| Auto-start break | `autoBreak` |
| Mindful pause gate | `mindfulPauseGate` |
| Suggested Flow Settings card (4 toggles) | — → becomes a one-time onboarding step |

### → Dashboard · AI coach
| Popup control | Storage key | Note |
| --- | --- | --- |
| Gemini API key + test button | `apiKey` | Write-only over the API; a real form field instead of a 400 px password box |
| Coaching personality | `personality` | With a voice preview |
| AI recommendation cards | `dismissed_recommendations` | Gains the evidence behind each suggestion |

### → Dashboard · Labs
`betaMusicPlayer`, `betaInPageDimmer`, `betaBreakCoach`, `betaBadges`,
`autoMusic`, `whitelist`, plus the YouTube soundscape importer
(`customSoundscapes`) — which is a URL field and a list, i.e. exactly the
kind of thing a popup is worst at.

### → Dashboard · Analytics
The entire Analytics tab: time-horizon selector, heatmap, category donut,
weekly velocity, trend chart, top sites table, milestone badges, CSV/JSON
export. All of it gets *more* detail than the popup version, because the
server can aggregate rows the extension can only store as a blob.

### → Dashboard · Account
Reset today's stats, factory reset, and the new items: password change,
device list, audit log, full data export, account deletion.

---

## New on the dashboard — things the popup could never do

These are the reason the web app is worth having, not just a bigger settings page.

1. **Hour-of-day analysis.** When you actually focus, and when you reach for
   Reddit — from measured events, not the browser-history guess the extension
   makes today.
2. **A session log.** Every sprint with its intention, planned vs actual
   duration, outcome and alignment score. The extension keeps a count.
3. **Per-domain trends.** Time on each domain this window vs last, so you can
   see a habit forming instead of only today's total.
4. **Per-rule effectiveness.** How many times each guarded site actually
   stopped you — which rules earn their place and which are noise.
5. **Cross-browser truth.** Work laptop and home desktop roll into one
   picture, with one rule set.
6. **Named schedules per rule.** "Block Reddit during work hours but not
   evenings" is impossible with one global window.
7. **History beyond what a popup can hold.** `chrome.storage.local` has a
   practical ceiling and no query language; SQLite has neither problem.

---

## Popup shape after the move

```
┌─────────────────────────────────┐
│ 🌱 Sprout            ● Synced   │
├─────────────────────────────────┤
│                                 │
│         ⏱  24:31                │
│      Ship the theme system      │
│                                 │
│   [ 25 ][ 45 ][ 60 ][ 90 ]      │
│   ┌───────────────────────────┐ │
│   │   ⏹  End Deep Work        │ │
│   └───────────────────────────┘ │
├─────────────────────────────────┤
│ 1h 37m   6      12      14      │
│ focus  streak  blocks  sprints  │
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░  1h37m / 2h    │
├─────────────────────────────────┤
│ ☑ Finish the theme system       │
│ ☐ Ship v1.3                     │
│ + add                           │
├─────────────────────────────────┤
│ reddit.com      [+ Guard site]  │
├─────────────────────────────────┤
│ 🎨 ●●●●●●   ☀ 🌙 🖥            │
│ Open dashboard  ↗               │
└─────────────────────────────────┘
```

---

## Migration path for existing users

The extension must not lose anyone's data when they first pair.

1. On first successful pair, the extension pushes its **entire** local
   state — `blacklist`, every setting, all of `timeStats` and `focusStats`,
   `blockAttempts`, `tasks` — as a one-off full upload.
2. The server treats an empty account as "adopt whatever the first device
   sends"; a non-empty account merges (rules union, usage `MAX` per
   date/domain, settings server-wins).
3. Nothing is deleted from `chrome.storage.local`. Unpairing returns the
   extension to exactly its current standalone behaviour.
4. Settings that moved to the dashboard keep working locally for anyone who
   never signs in — the popup just stops showing the controls, and the
   `chrome.storage.local` defaults still apply. **Signing in is optional.**
