/* ============================================================
   SPROUT — CHARTS
   ------------------------------------------------------------
   Hand-rolled SVG and DOM. No chart library: every chart here is
   under 60 lines, and a library would be larger than all of them
   put together while making the mark specs harder to hold to.

   Rules applied throughout:
     · one axis per plot — never two y-scales
     · colour follows the entity, not its rank
     · 2px surface gap between touching marks; no strokes
     · a legend whenever there are 2+ series; direct labels sparingly
     · every chart has a hover layer and a table view
   ============================================================ */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------- tooltip
  let tip = null;
  function tooltip() {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "viz-tip";
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(html, event) {
    const el = tooltip();
    el.innerHTML = html;
    el.classList.add("on");
    const pad = 14;
    const box = el.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  function hideTip() { if (tip) tip.classList.remove("on"); }

  // ------------------------------------------------------------- formatting
  function hms(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    if (s < 60) return s + "s";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function shortDate(iso) {
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  }
  function hourLabel(h) {
    if (h === 0) return "12a";
    if (h === 12) return "12p";
    return h < 12 ? `${h}a` : `${h - 12}p`;
  }
  function el(tag, attrs, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }
  function cssVar(name, scope) {
    return getComputedStyle(scope || document.documentElement).getPropertyValue(name).trim();
  }

  const CATEGORIES = [
    { key: "productive",  label: "Productive",   varName: "--cat-productive" },
    { key: "research",    label: "Research",     varName: "--cat-research" },
    { key: "neutral",     label: "Neutral",      varName: "--cat-neutral" },
    { key: "distracting", label: "Distracting",  varName: "--cat-distracting" }
  ];

  /**
   * Part-to-whole across four ordered categories.
   *
   * A stacked bar rather than a donut: angles are harder to compare than
   * lengths, and four labelled rows beat four slices with leader lines.
   * Every segment is also a legend row with its value and share — that is the
   * secondary encoding the sub-3:1 aqua fill requires, so nothing is carried
   * by colour alone.
   */
  function categoryStack(host, categories) {
    host.classList.add("viz");
    host.innerHTML = "";

    const total = CATEGORIES.reduce((sum, c) => sum + (categories[c.key] || 0), 0);
    if (!total) { host.innerHTML = emptyState("No browsing recorded in this window."); return; }

    const track = document.createElement("div");
    track.className = "stack-track";
    const legend = document.createElement("div");
    legend.className = "viz-legend";

    for (const cat of CATEGORIES) {
      const seconds = categories[cat.key] || 0;
      if (!seconds) continue;
      const share = (seconds / total) * 100;
      const colour = cssVar(cat.varName, host);

      const seg = document.createElement("div");
      seg.className = "stack-seg";
      seg.style.flex = `${seconds} 0 0`;
      seg.style.background = colour;
      seg.addEventListener("mousemove", (e) => showTip(
        `<strong>${cat.label}</strong><div class="row"><b>${hms(seconds)}</b> · ${share.toFixed(1)}%</div>`, e));
      seg.addEventListener("mouseleave", hideTip);
      track.appendChild(seg);

      const item = document.createElement("div");
      item.className = "viz-legend-item";
      item.innerHTML =
        `<span class="viz-swatch" style="background:${colour}"></span>` +
        `<span class="viz-legend-name">${cat.label}</span>` +
        `<span class="viz-legend-value">${hms(seconds)}</span>` +
        `<span class="viz-legend-share">${share.toFixed(0)}%</span>`;
      legend.appendChild(item);
    }

    host.append(track, legend);
  }

  /**
   * Focus consistency heatmap — a calendar grid, one cell per day.
   *
   * Sequential: one blue hue, light to dark, with a distinct "nothing here"
   * step that recedes to the surface. Weeks run down the columns like a
   * calendar, which is what makes a run of good days visible as a block.
   */
  function heatmap(host, points, { goalSeconds = 7200 } = {}) {   // eslint-disable-line no-param-reassign
    host.classList.add("viz");
    host.innerHTML = "";

    // A long empty run before the account existed is noise, not information.
    const firstActive = points.findIndex((p) => p.focusSeconds > 0 || p.blocks > 0);
    const visible = firstActive === -1 ? [] : points.slice(Math.max(0, firstActive - 3));
    if (!visible.length) { host.innerHTML = emptyState("No focus recorded yet."); return; }
    points = visible;

    // Pad the front so the first column starts on a Sunday.
    const first = new Date(points[0].date + "T12:00:00Z").getUTCDay();
    const cells = Array.from({ length: first }, () => null).concat(points);

    const grid = document.createElement("div");
    grid.className = "heat-grid";

    for (const point of cells) {
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      if (!point) { cell.style.background = "transparent"; grid.appendChild(cell); continue; }

      // Buckets relative to the user's own goal, so the ramp means something
      // personal rather than an arbitrary minute count.
      const ratio = point.focusSeconds / (goalSeconds || 7200);
      const level = point.focusSeconds === 0 ? 0
        : ratio < 0.25 ? 1 : ratio < 0.6 ? 2 : ratio < 1 ? 3 : 4;

      cell.style.background = cssVar(`--heat-${level}`, host);
      cell.addEventListener("mousemove", (e) => showTip(
        `<strong>${point.date}</strong>` +
        `<div class="row">Focus <b>${hms(point.focusSeconds)}</b></div>` +
        (point.blocks ? `<div class="row">Blocked <b>${point.blocks}</b></div>` : ""), e));
      cell.addEventListener("mouseleave", hideTip);
      grid.appendChild(cell);
    }

    const scale = document.createElement("div");
    scale.className = "heat-scale";
    scale.style.marginTop = "10px";
    scale.style.justifyContent = "flex-end";
    scale.innerHTML = "<span>Less</span>" +
      [0, 1, 2, 3, 4].map((l) => `<span class="sw" style="background:${cssVar(`--heat-${l}`, host)}"></span>`).join("") +
      "<span>More</span>";

    host.append(grid, scale);
    return points.length;
  }

  /**
   * Focus vs distraction over time.
   *
   * Both series are seconds, so one shared axis is honest — this is the one
   * place a second scale would be tempting and wrong. Two series, so a legend
   * is present; only the final point of each line is directly labelled.
   */
  function trendLines(host, points) {
    host.classList.add("viz");
    host.innerHTML = "";
    if (points.length < 2) { host.innerHTML = emptyState("Not enough days to draw a trend yet."); return; }

    const W = 900, H = 240, padL = 46, padR = 54, padT = 14, padB = 26;
    const max = Math.max(1, ...points.map((p) => Math.max(p.focusSeconds, p.distractingSeconds)));
    const niceMax = niceCeil(max);
    const x = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
    const y = (v) => padT + (1 - v / niceMax) * (H - padT - padB);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Focus and distracting time per day" });

    // Gridlines: hairline, solid, recessive. Ticks in round hours.
    for (let i = 0; i <= 4; i++) {
      const value = (niceMax / 4) * i;
      svg.appendChild(el("line", { class: "grid-line", x1: padL, x2: W - padR, y1: y(value), y2: y(value) }));
      svg.appendChild(el("text", { class: "axis-label", x: padL - 8, y: y(value) + 3.5, "text-anchor": "end" },
        value === 0 ? "0" : Math.round(value / 3600) + "h"));
    }

    const series = [
      { key: "focusSeconds", label: "Focus", colour: cssVar("--cat-productive", host) },
      { key: "distractingSeconds", label: "Distracting", colour: cssVar("--cat-distracting", host) }
    ];

    for (const s of series) {
      const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(" ");
      svg.appendChild(el("path", {
        d, fill: "none", stroke: s.colour, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round"
      }));

      // End marker with a 2px surface ring, plus the only direct label.
      const last = points[points.length - 1];
      svg.appendChild(el("circle", {
        cx: x(points.length - 1), cy: y(last[s.key]), r: 4.5,
        fill: s.colour, stroke: cssVar("--viz-surface", host), "stroke-width": 2
      }));
      svg.appendChild(el("text", {
        class: "value-label", x: x(points.length - 1) + 9,
        y: y(last[s.key]) + 4, fill: cssVar("--viz-ink", host)
      }, hms(last[s.key])));
    }

    // X labels: first, middle and last only — a date under every point is noise.
    [0, Math.floor(points.length / 2), points.length - 1].forEach((i, n) => {
      svg.appendChild(el("text", {
        class: "axis-label", x: x(i), y: H - 6,
        "text-anchor": n === 0 ? "start" : n === 2 ? "end" : "middle"
      }, shortDate(points[i].date)));
    });

    // Crosshair: one hit rect over the plot, nearest-point lookup.
    const crosshair = el("line", {
      x1: 0, x2: 0, y1: padT, y2: H - padB,
      stroke: cssVar("--viz-axis", host), "stroke-width": 1, opacity: 0
    });
    svg.appendChild(crosshair);

    const hit = el("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
    hit.addEventListener("mousemove", (event) => {
      const box = svg.getBoundingClientRect();
      const ratio = (event.clientX - box.left) / box.width * W;
      const index = Math.max(0, Math.min(points.length - 1,
        Math.round((ratio - padL) / (W - padL - padR) * (points.length - 1))));
      const point = points[index];
      crosshair.setAttribute("x1", x(index));
      crosshair.setAttribute("x2", x(index));
      crosshair.setAttribute("opacity", 0.45);
      showTip(
        `<strong>${point.date}</strong>` +
        `<div class="row"><span class="viz-swatch" style="background:${series[0].colour}"></span>Focus <b>${hms(point.focusSeconds)}</b></div>` +
        `<div class="row"><span class="viz-swatch" style="background:${series[1].colour}"></span>Distracting <b>${hms(point.distractingSeconds)}</b></div>`,
        event);
    });
    hit.addEventListener("mouseleave", () => { crosshair.setAttribute("opacity", 0); hideTip(); });
    svg.appendChild(hit);

    const legend = document.createElement("div");
    legend.className = "viz-legend";
    legend.innerHTML = series.map((s) =>
      `<div class="viz-legend-item"><span class="viz-swatch" style="background:${s.colour}"></span>` +
      `<span class="viz-legend-name">${s.label}</span></div>`).join("");

    host.append(svg, legend);
  }

  /**
   * When you focus, and when you reach for a distraction.
   *
   * Two measures of different units (seconds vs event counts), so this is two
   * small multiples sharing one x axis — never a dual-axis plot. Each row is a
   * single series, so neither needs a legend box; the row heading names it.
   */
  function hourlyPair(host, hours) {
    host.classList.add("viz");
    host.innerHTML = "";
    if (!hours.some((h) => h.focusSeconds || h.distractionEvents)) {
      host.innerHTML = emptyState("Nothing recorded in this window yet.");
      return;
    }

    const rows = [
      { title: "Focus time", key: "focusSeconds", colour: cssVar("--cat-productive", host), fmt: hms },
      { title: "Distraction attempts", key: "distractionEvents", colour: cssVar("--cat-distracting", host), fmt: (v) => `${v}` }
    ];

    for (const row of rows) {
      const max = Math.max(1, ...hours.map((h) => h[row.key]));
      const W = 900, H = 96, padB = 20, padT = 6;
      const band = W / 24;
      const barW = Math.min(24, band - 6);           // capped; the leftover is air

      const heading = document.createElement("div");
      heading.className = "card-title";
      heading.style.marginTop = row === rows[0] ? "0" : "18px";
      heading.innerHTML = `<span>${row.title}</span>`;

      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${row.title} by hour of day` });
      svg.appendChild(el("line", {
        class: "grid-line", x1: 0, x2: W, y1: H - padB, y2: H - padB
      }));

      hours.forEach((h) => {
        const value = h[row.key];
        const height = value ? Math.max(3, (value / max) * (H - padT - padB)) : 0;
        const cx = h.hour * band + band / 2;
        if (height) {
          svg.appendChild(el("rect", {
            x: cx - barW / 2, y: H - padB - height, width: barW, height,
            rx: 4, fill: row.colour
          }));
        }
        if (h.hour % 3 === 0) {
          svg.appendChild(el("text", {
            class: "axis-label", x: cx, y: H - 5, "text-anchor": "middle"
          }, hourLabel(h.hour)));
        }
      });

      // One hit rect per hour, full height — bigger than the mark, as it should be.
      hours.forEach((h) => {
        const hit = el("rect", { x: h.hour * band, y: 0, width: band, height: H - padB, fill: "transparent" });
        hit.addEventListener("mousemove", (e) => showTip(
          `<strong>${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)}</strong>` +
          `<div class="row">${row.title} <b>${row.fmt(h[row.key])}</b></div>`, e));
        hit.addEventListener("mouseleave", hideTip);
        svg.appendChild(hit);
      });

      host.append(heading, svg);
    }
  }

  /** Top domains: a table, with an in-cell magnitude bar in the row's own category colour. */
  function domainTable(host, data, { onGuard } = {}) {
    host.classList.add("viz");
    host.innerHTML = "";
    if (!data.domains.length) { host.innerHTML = emptyState("No site activity in this window."); return; }

    const max = data.domains[0].seconds || 1;
    const table = document.createElement("table");
    table.className = "dom-table";
    table.innerHTML =
      `<thead><tr><th>Domain</th><th>Category</th><th class="bar-cell">Time</th>` +
      `<th style="text-align:right">Share</th><th style="text-align:right">vs prev</th><th></th></tr></thead>`;

    const body = document.createElement("tbody");
    for (const row of data.domains) {
      const colour = cssVar(`--cat-${row.category}`, host);
      const tr = document.createElement("tr");

      // More time on a productive site is good; more time on a distracting one
      // is not. Colouring purely by sign would call every green day a problem.
      const wantMore = row.category === "productive" || row.category === "research";
      const meaningful = Math.abs(row.trendPct) > 5 && row.category !== "neutral";
      const good = (row.trendPct > 0) === wantMore;
      // Class names say good/bad, not up/down — the colour encodes whether the
      // change is welcome, and the arrow carries the direction so neither is
      // left to colour alone.
      const trendClass = !meaningful ? "trend-flat" : good ? "trend-good" : "trend-bad";
      const arrow = row.trendPct > 0 ? "▲" : row.trendPct < 0 ? "▼" : "";
      const trendText = row.trendPct === 0 ? "—" : `${arrow} ${Math.abs(row.trendPct)}%`;

      tr.innerHTML =
        `<td><strong>${escapeHtml(row.domain)}</strong></td>` +
        `<td><span class="pill" style="background:transparent;color:var(--text-secondary);padding-left:0">` +
          `<span class="viz-swatch" style="background:${colour};display:inline-block;margin-right:6px"></span>${row.category}</span></td>` +
        `<td class="bar-cell"><div style="display:flex;align-items:center;gap:8px">` +
          `<div class="dom-bar" style="width:${(row.seconds / max) * 100}%;background:${colour}"></div>` +
          `<span class="mono" style="white-space:nowrap">${hms(row.seconds)}</span></div></td>` +
        `<td style="text-align:right" class="mono">${row.sharePct}%</td>` +
        `<td style="text-align:right" class="${trendClass} mono">${trendText}</td>` +
        `<td style="text-align:right"></td>`;

      if (onGuard) {
        const cell = tr.lastElementChild;
        const btn = document.createElement("button");
        btn.className = "viz-table-toggle";
        btn.textContent = row.blocked ? "guarded" : "+ guard";
        btn.disabled = row.blocked;
        btn.style.textDecoration = row.blocked ? "none" : "underline";
        btn.addEventListener("click", () => onGuard(row.domain, btn));
        cell.appendChild(btn);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    host.appendChild(table);
  }

  // ------------------------------------------------------------------ utils
  function niceCeil(value) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    return Math.ceil(value / magnitude) * magnitude;
  }
  function emptyState(message) {
    return `<div class="empty"><strong>Nothing to show</strong>${escapeHtml(message)}</div>`;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  global.charts = {
    categoryStack, heatmap, trendLines, hourlyPair, domainTable,
    hms, hourLabel, shortDate, escapeHtml, emptyState, hideTip
  };
})(window);
