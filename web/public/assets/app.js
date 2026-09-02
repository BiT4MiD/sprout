/* ============================================================
   SPROUT CONTROL CENTRE — dashboard controller
   ------------------------------------------------------------
   Each section loads its own data the first time it is opened,
   so signing in costs one request rather than eleven.
   ============================================================ */
(function () {
  "use strict";

  const banner = document.getElementById("appBanner");
  const views = Array.from(document.querySelectorAll(".view"));
  const navLinks = Array.from(document.querySelectorAll(".nav-link[data-view]"));

  const state = {
    user: null,
    settings: {},
    meta: { scopes: {}, homes: {} },
    range: "7d",
    loaded: new Set()
  };

  function notify(message, kind = "error") {
    banner.textContent = message || "";
    banner.className = "banner " + kind;
    banner.hidden = !message;
    if (message && kind !== "error") setTimeout(() => { banner.hidden = true; }, 3200);
  }

  function fail(err) {
    if (err && err.status === 401) { location.href = "/"; return; }
    notify((err && err.message) || "Something went wrong.");
    console.error(err);
  }

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- routing
  const LOADERS = {
    viewOverview: loadOverview,
    viewAnalytics: loadAnalytics,
    viewSessions: loadSessions,
    viewRules: loadRules,
    viewSchedules: loadSchedules,
    viewDevices: loadDevices,
    viewAccount: loadAccount
  };

  function showView(id, { reload = false } = {}) {
    views.forEach((v) => v.classList.toggle("active", v.id === id));
    navLinks.forEach((b) => {
      if (b.dataset.view === id) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
    charts.hideTip();

    if (LOADERS[id] && (reload || !state.loaded.has(id))) {
      state.loaded.add(id);
      Promise.resolve(LOADERS[id]()).catch(fail);
    }
  }

  navLinks.forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (document.getElementById(id)) showView(id);
  });

  // ------------------------------------------------------------- appearance
  function buildAppearanceControls() {
    if (typeof SproutTheme === "undefined") return;
    const grid = $("themeGrid");
    const segment = $("appearanceSegment");

    SproutTheme.THEMES.forEach((theme) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "card";
      btn.style.cssText = "display:flex;align-items:center;gap:11px;cursor:pointer;font-family:inherit;text-align:left;border-width:1.5px;";
      btn.dataset.theme = theme.id;
      btn.setAttribute("role", "radio");

      const dot = document.createElement("span");
      dot.style.cssText = `width:28px;height:28px;border-radius:50%;flex:none;background:linear-gradient(135deg,${theme.swatch},${theme.swatchDark});`;

      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.style.fontSize = "13.5px";
      name.textContent = theme.label;
      const hint = document.createElement("span");
      hint.style.cssText = "font-size:11.5px;color:var(--text-tertiary);display:block;";
      hint.textContent = theme.hint;
      text.append(name, hint);

      btn.append(dot, text);
      btn.addEventListener("click", () => SproutTheme.save(theme.id, SproutTheme.get().appearance));
      grid.appendChild(btn);
    });

    SproutTheme.APPEARANCES.forEach((mode) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-quiet";
      btn.dataset.appearance = mode.id;
      btn.textContent = `${mode.icon} ${mode.label}`;
      btn.addEventListener("click", () => SproutTheme.save(SproutTheme.get().theme, mode.id));
      segment.appendChild(btn);
    });

    paintAppearance(SproutTheme.get());
    SproutTheme.onChange((next) => {
      paintAppearance(next);
      // Charts read their colours from CSS custom properties, so a theme change
      // means redrawing whatever is on screen.
      const active = views.find((v) => v.classList.contains("active"));
      if (active && LOADERS[active.id]) Promise.resolve(LOADERS[active.id]()).catch(() => {});
    });

    // theme.js calls this whenever the user picks something.
    window.onSproutThemeSave = (next) => {
      api.patchSettings({ theme: next.theme, appearance: next.appearance }).catch(fail);
    };
  }

  function paintAppearance(current) {
    document.querySelectorAll("#themeGrid [data-theme]").forEach((b) => {
      const on = b.dataset.theme === current.theme;
      b.style.borderColor = on ? "var(--accent)" : "var(--glass-border)";
      b.style.background = on ? "var(--accent-subtle)" : "var(--card)";
      b.setAttribute("aria-checked", String(on));
    });
    document.querySelectorAll("#appearanceSegment [data-appearance]").forEach((b) => {
      const on = b.dataset.appearance === current.appearance;
      b.style.background = on ? "var(--accent)" : "var(--surface-2)";
      b.style.color = on ? "#fff" : "var(--text-primary)";
      b.setAttribute("aria-checked", String(on));
    });
  }

  // --------------------------------------------------------------- settings
  let settingTimer = null;
  const pendingPatch = {};

  function bindSettings() {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.setting;
        const value = input.type === "checkbox" ? input.checked
          : input.type === "number" ? Number(input.value)
          : input.value === "true" ? true
          : input.value === "false" ? false
          : input.value;

        pendingPatch[key] = value;
        // Debounced so dragging a number field doesn't fire a request per keystroke.
        clearTimeout(settingTimer);
        settingTimer = setTimeout(flushSettings, 400);
      });
    });
  }

  async function flushSettings() {
    const patch = Object.assign({}, pendingPatch);
    for (const key of Object.keys(pendingPatch)) delete pendingPatch[key];
    if (!Object.keys(patch).length) return;
    try {
      const result = await api.patchSettings(patch);
      state.settings = result.settings;
      notify("Saved.", "info");
    } catch (err) {
      // Put the controls back to the server's truth rather than leaving a lie
      // on screen.
      await loadSettings();
      if (err.fields) {
        const first = Object.values(err.fields)[0];
        notify(first || err.message);
      } else fail(err);
    }
  }

  async function loadSettings() {
    const result = await api.getSettings();
    state.settings = result.settings;
    state.meta = { scopes: result.scopes || {}, homes: result.homes || {} };
    paintSettings();
  }

  function paintSettings() {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      const value = state.settings[input.dataset.setting];
      if (value === undefined) return;
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = String(value);
    });
    const keyState = $("apiKeyState");
    if (keyState) {
      keyState.textContent = state.settings.hasApiKey ? "key saved" : "not set";
      keyState.className = "pill " + (state.settings.hasApiKey ? "ok" : "");
    }
  }

  // --------------------------------------------------------------- overview
  function paintStat(name, value, deltaPct, unit) {
    const valueEl = document.querySelector(`[data-stat="${name}"]`);
    const deltaEl = document.querySelector(`[data-delta="${name}"]`);
    if (valueEl) valueEl.textContent = value;
    if (!deltaEl) return;
    if (deltaPct === null || deltaPct === undefined) { deltaEl.textContent = ""; return; }
    const up = deltaPct > 0;
    deltaEl.textContent = `${up ? "▲" : deltaPct < 0 ? "▼" : "—"} ${Math.abs(deltaPct)}% ${unit || "vs previous"}`;
    deltaEl.className = "delta " + (deltaPct === 0 ? "" : up ? "up" : "down");
  }

  async function loadOverview() {
    const range = $("overviewRange").value;
    state.range = range;

    const [summary, series, top] = await Promise.all([
      api.summary(range),
      // The consistency heatmap always shows a long window. Its job is to make
      // streaks and gaps visible, which a 7-day grid cannot do, so it is
      // deliberately independent of the stat-tile range above it.
      api.timeseries("year", "day"),
      api.domains(range, { limit: 8 })
    ]);

    paintStat("focus", charts.hms(summary.focusSeconds), summary.focusDeltaPct);
    paintStat("sessions", String(summary.sessions), summary.sessionsDeltaPct);
    paintStat("blocks", String(summary.blocks), summary.blocksDeltaPct);
    paintStat("streak", `${summary.streak}d`, null);
    document.querySelector('[data-delta="streak"]').textContent =
      summary.longestStreak ? `best ${summary.longestStreak}d · goal ${summary.goalMinutes}m/day` : "";

    $("overviewSub").textContent =
      `${summary.goalHitDays} of ${summary.goalDays} days hit your ${summary.goalMinutes}-minute goal · ` +
      `${Math.round(summary.completionRate * 100)}% of sprints finished`;

    const heatDays = series.points.slice(-182);
    const drawn = charts.heatmap($("heatmap"), heatDays, { goalSeconds: summary.goalMinutes * 60 });
    $("heatmapRangeLabel").textContent = `${drawn} days`;
    charts.categoryStack($("categoryChart"), summary.categories);
    charts.domainTable($("topDomains"), top, { onGuard: guardDomain });
  }

  async function guardDomain(domain, button) {
    try {
      await api.addRule({ pattern: domain, kind: "block" });
      button.textContent = "guarded";
      button.disabled = true;
      button.style.textDecoration = "none";
      state.loaded.delete("viewRules");
      notify(`${domain} is now guarded.`, "info");
    } catch (err) {
      notify(err.message);
    }
  }

  // -------------------------------------------------------------- analytics
  async function loadAnalytics() {
    const [hours, series, all] = await Promise.all([
      api.hourly("30d"),
      api.timeseries("30d", "day"),
      api.domains("30d", { limit: 100 })
    ]);

    charts.hourlyPair($("hourlyChart"), hours.hours);
    const insight = $("hourlyInsight");
    if (insight) {
      insight.textContent = hours.peakFocusHour === null
        ? "Not enough sessions yet to find a pattern."
        : `Your deepest focus lands around ${charts.hourLabel(hours.peakFocusHour)}, and ` +
          `distraction peaks around ${charts.hourLabel(hours.peakDistractionHour)}.`;
    }

    charts.trendLines($("trendChart"), series.points);
    charts.domainTable($("domainTable"), all, { onGuard: guardDomain });
    $("domainCount").textContent = `${all.domains.length} sites`;
  }

  // ---------------------------------------------------------- session log
  async function loadSessions() {
    const data = await api.sessions("30d");
    const host = $("sessionTable");
    host.classList.add("viz");
    if (!data.sessions.length) {
      host.innerHTML = charts.emptyState("No Deep Work sessions recorded in the last 30 days.");
      return;
    }
    const OUTCOME = {
      accomplished: ["ok", "Accomplished"],
      partially: ["warn", "Partial"],
      derailed: ["bad", "Derailed"],
      abandoned: ["", "Abandoned"]
    };
    host.innerHTML =
      `<table><thead><tr><th>Date</th><th>Intention</th><th style="text-align:right">Planned</th>` +
      `<th style="text-align:right">Actual</th><th>Outcome</th><th style="text-align:right">Alignment</th></tr></thead>` +
      `<tbody>${data.sessions.map((s) => {
        const [cls, label] = OUTCOME[s.outcome] || ["", "—"];
        return `<tr>
          <td class="mono">${s.localDate}</td>
          <td>${charts.escapeHtml(s.intention || "—")}</td>
          <td style="text-align:right" class="mono">${s.plannedMin}m</td>
          <td style="text-align:right" class="mono">${charts.hms(s.actualSeconds)}</td>
          <td><span class="pill ${cls}">${label}</span></td>
          <td style="text-align:right" class="mono">${s.alignmentScore == null ? "—" : s.alignmentScore}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
  }

  // -------------------------------------------------------------- rules
  async function loadRules() {
    const data = await api.getRules();
    const host = $("ruleTable");
    $("ruleCount").textContent = `${data.rules.length} rules`;

    if (!data.rules.length) {
      host.innerHTML = charts.emptyState("Nothing guarded yet. Paste a few sites above to get started.");
      return;
    }

    const schedules = new Map(data.schedules.map((s) => [s.id, s.name]));
    const KIND = { block: ["bad", "Block"], shield: ["warn", "Soft shield"], allow: ["ok", "Always allow"] };

    host.innerHTML =
      `<table><thead><tr><th>Site</th><th>Rule</th><th>Schedule</th><th>Added by</th>` +
      `<th style="text-align:right">Stopped you (7d)</th><th></th></tr></thead><tbody>${
        data.rules.map((r) => {
          const [cls, label] = KIND[r.kind] || ["", r.kind];
          return `<tr data-rule="${r.id}">
            <td><strong>${charts.escapeHtml(r.pattern)}</strong>${
              r.note ? `<div class="hint" style="margin-top:2px">${charts.escapeHtml(r.note)}</div>` : ""}</td>
            <td><span class="pill ${cls}">${label}</span></td>
            <td>${r.scheduleId ? charts.escapeHtml(schedules.get(r.scheduleId) || "—") : "<span class='trend-flat'>Always</span>"}</td>
            <td><span class="trend-flat">${r.source}</span></td>
            <td style="text-align:right" class="mono">${r.hits7d}</td>
            <td style="text-align:right">
              <button class="viz-table-toggle" data-action="toggle">${r.enabled ? "disable" : "enable"}</button>
              <button class="viz-table-toggle" data-action="delete" style="color:var(--danger)">remove</button>
            </td>
          </tr>`;
        }).join("")}</tbody></table>`;

    host.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.closest("[data-rule]").dataset.rule);
        const rule = data.rules.find((r) => r.id === id);
        try {
          if (btn.dataset.action === "delete") await api.deleteRule(id);
          else await api.patchRule(id, { enabled: !rule.enabled });
          await loadRules();
        } catch (err) { fail(err); }
      });
    });
  }

  async function loadSchedules() {
    const data = await api.getSchedules();
    const host = $("scheduleList");
    if (!data.schedules.length) {
      host.innerHTML = charts.emptyState("No schedules yet. Create one to block a site only during certain hours.");
      return;
    }
    const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
    const time = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    host.innerHTML =
      `<table><thead><tr><th>Name</th><th>Days</th><th>Window</th><th></th></tr></thead><tbody>${
        data.schedules.map((s) => `<tr data-schedule="${s.id}">
          <td><strong>${charts.escapeHtml(s.name)}</strong></td>
          <td class="mono">${DAYS.map((d, i) => (s.daysMask & (1 << i))
            ? `<span style="color:var(--accent-light);font-weight:700">${d}</span>`
            : `<span class="trend-flat">${d}</span>`).join(" ")}</td>
          <td class="mono">${time(s.startMin)} – ${time(s.endMin)}${s.endMin < s.startMin ? " <span class='trend-flat'>(overnight)</span>" : ""}</td>
          <td style="text-align:right"><button class="viz-table-toggle" data-action="delete" style="color:var(--danger)">remove</button></td>
        </tr>`).join("")}</tbody></table>`;

    host.querySelectorAll("[data-action=delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.closest("[data-schedule]").dataset.schedule);
        try { await api.deleteSchedule(id); await loadSchedules(); } catch (err) { fail(err); }
      });
    });
  }

  // -------------------------------------------------------------- devices
  let pairTimer = null;

  async function loadDevices() {
    const data = await api.devices();
    const host = $("deviceTable");
    if (!data.devices.length) {
      host.innerHTML = charts.emptyState("No browser paired yet. Generate a code and enter it in the extension.");
      return;
    }
    host.innerHTML =
      `<table><thead><tr><th>Browser</th><th>Platform</th><th>Version</th><th>Last sync</th><th></th></tr></thead><tbody>${
        data.devices.map((d) => `<tr data-device="${d.id}">
          <td><strong>${charts.escapeHtml(d.name)}</strong></td>
          <td>${charts.escapeHtml(d.platform || "—")}</td>
          <td class="mono">${charts.escapeHtml(d.extensionVersion || "—")}</td>
          <td>${d.lastSyncAt ? relativeTime(d.lastSyncAt) : "<span class='trend-flat'>never</span>"}</td>
          <td style="text-align:right"><button class="viz-table-toggle" style="color:var(--danger)">unpair</button></td>
        </tr>`).join("")}</tbody></table>`;

    host.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-device]");
        if (!confirm("Unpair this browser? It keeps working on its own, but stops syncing.")) return;
        try { await api.revokeDevice(Number(row.dataset.device)); await loadDevices(); } catch (err) { fail(err); }
      });
    });
  }

  function relativeTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  // -------------------------------------------------------------- account
  async function loadAccount() {
    $("accountEmail").textContent = state.user
      ? `${state.user.email}${state.user.timezone ? " · " + state.user.timezone : ""}`
      : "";
    const data = await api.audit(40);
    const host = $("auditTable");
    if (!data.entries.length) { host.innerHTML = charts.emptyState("Nothing recorded yet."); return; }
    host.innerHTML =
      `<table><thead><tr><th>When</th><th>Action</th><th>Detail</th><th>From</th></tr></thead><tbody>${
        data.entries.map((e) => `<tr>
          <td class="mono">${new Date(e.createdAt).toLocaleString()}</td>
          <td><strong>${charts.escapeHtml(e.action)}</strong></td>
          <td class="trend-flat">${e.detail ? charts.escapeHtml(JSON.stringify(e.detail)) : "—"}</td>
          <td class="mono trend-flat">${charts.escapeHtml(e.ip || "—")}</td>
        </tr>`).join("")}</tbody></table>`;
  }

  // ----------------------------------------------------------------- wiring
  function wireActions() {
    $("overviewRange").addEventListener("change", () => loadOverview().catch(fail));

    $("bulkAddBtn").addEventListener("click", async () => {
      const field = $("bulkPatterns");
      if (!field.value.trim()) return;
      try {
        const result = await api.bulkAdd({ patterns: field.value });
        field.value = "";
        await loadRules();
        const parts = [];
        if (result.added.length) parts.push(`Added ${result.added.length}: ${result.added.join(", ")}`);
        if (result.skipped.length) {
          parts.push("Skipped " + result.skipped.map((s) => `${s.pattern} (${s.reason.toLowerCase()})`).join(", "));
        }
        notify(parts.join(" · ") || "Nothing to add.", result.added.length ? "info" : "error");
      } catch (err) { fail(err); }
    });

    $("newScheduleBtn").addEventListener("click", async () => {
      const name = prompt("Name this schedule (e.g. Work hours)");
      if (!name) return;
      const from = prompt("Start time (HH:MM)", "09:00");
      const to = prompt("End time (HH:MM)", "17:00");
      const toMin = (value) => {
        const [h, m] = String(value || "").split(":").map(Number);
        return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
      };
      const startMin = toMin(from), endMin = toMin(to);
      if (startMin === null || endMin === null) { notify("Times must look like 09:00."); return; }
      try {
        await api.createSchedule({ name, startMin, endMin, daysMask: 62 });
        await loadSchedules();
        notify("Schedule created — attach it to a rule from the Sites page.", "info");
      } catch (err) { fail(err); }
    });

    $("pairBtn").addEventListener("click", async () => {
      try {
        const { code, expiresAt } = await api.pairCode();
        $("pairPanel").hidden = false;
        $("pairCode").textContent = code.replace(/(.{4})/, "$1 ");
        clearInterval(pairTimer);
        const tick = () => {
          const left = Math.max(0, expiresAt - Date.now());
          $("pairCountdown").textContent =
            `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
          if (left <= 0) { clearInterval(pairTimer); $("pairPanel").hidden = true; loadDevices().catch(fail); }
        };
        tick();
        pairTimer = setInterval(tick, 1000);
      } catch (err) { fail(err); }
    });

    $("saveKeyBtn").addEventListener("click", async () => {
      const value = $("apiKey").value.trim();
      if (!value) { notify("Paste a key first."); return; }
      try {
        await api.patchSettings({ apiKey: value });
        $("apiKey").value = "";
        await loadSettings();
        notify("Key saved. It's stored on your server and never returned by the API.", "info");
      } catch (err) { fail(err); }
    });

    $("testKeyBtn").addEventListener("click", () => {
      notify("Key testing runs in the extension, which is what actually calls Gemini. " +
             "Save the key here, then press Test in the extension popup.", "info");
    });

    $("exportBtn").addEventListener("click", () => { location.href = "/api/stats/export?format=csv&range=all"; });
    $("exportAllBtn").addEventListener("click", () => { location.href = "/api/stats/export?format=json&range=all"; });

    $("changePasswordBtn").addEventListener("click", async () => {
      try {
        await api.changePassword({
          currentPassword: $("currentPassword").value,
          newPassword: $("newPassword").value
        });
        $("currentPassword").value = "";
        $("newPassword").value = "";
        notify("Password updated. Your other browsers have been signed out.", "info");
      } catch (err) {
        notify(err.fields ? Object.values(err.fields)[0] : err.message);
      }
    });

    $("deleteAccountBtn").addEventListener("click", async () => {
      const password = prompt("This erases everything permanently. Enter your password to confirm:");
      if (!password) return;
      try {
        await api.deleteAccount({ password });
        location.href = "/";
      } catch (err) { notify(err.message); }
    });

    $("logoutBtn").addEventListener("click", async () => {
      try { await api.logout(); } catch { /* going to the login page regardless */ }
      location.href = "/";
    });
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    buildAppearanceControls();
    bindSettings();
    wireActions();

    let me;
    try {
      me = await api.me();
    } catch {
      location.href = "/";
      return;
    }
    api.setCsrfToken(me.csrfToken);
    state.user = me.user;

    try {
      await loadSettings();
      // The server holds the authoritative theme; adopt it before first paint
      // of anything colour-dependent.
      if (state.settings.theme) {
        SproutTheme.apply(state.settings.theme, state.settings.appearance);
        paintAppearance(SproutTheme.get());
      }
    } catch (err) { fail(err); }

    const initial = location.hash.slice(1);
    showView(document.getElementById(initial) ? initial : "viewOverview");
  }

  boot();
})();
