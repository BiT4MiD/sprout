/* ============================================================
   SPROUT — THEME RUNTIME
   ------------------------------------------------------------
   Loaded synchronously in <head> so the first paint is already
   in the right palette. It applies the cached choice from
   localStorage immediately. On the dashboard the server is the
   source of truth: app.js calls SproutTheme.apply() once settings
   load, and SproutTheme.save() PATCHes them back.
   ============================================================ */
(function (global) {
  "use strict";

  var THEMES = [
    { id: "sprout",   label: "Sprout",   hint: "Fresh green",    swatch: "#3d9a45", swatchDark: "#5fd06a" },
    { id: "midnight", label: "Midnight", hint: "Deep violet",    swatch: "#5b3ec9", swatchDark: "#9b7bf0" },
    { id: "ocean",    label: "Ocean",    hint: "Cool cyan",      swatch: "#127ac5", swatchDark: "#3cb4ee" },
    { id: "ember",    label: "Ember",    hint: "Warm amber",     swatch: "#c95a12", swatchDark: "#f5924a" },
    { id: "rose",     label: "Rose",     hint: "Soft magenta",   swatch: "#bd2a5e", swatchDark: "#ef6c9b" },
    { id: "graphite", label: "Graphite", hint: "Quiet monotone", swatch: "#53687f", swatchDark: "#8aa4bf" }
  ];

  var APPEARANCES = [
    { id: "system", label: "System", icon: "🖥️" },
    { id: "light",  label: "Light",  icon: "☀️" },
    { id: "dark",   label: "Dark",   icon: "🌙" }
  ];

  var DEFAULT_THEME = "sprout";
  var DEFAULT_APPEARANCE = "system";
  var CACHE_THEME = "sprout.theme";
  var CACHE_APPEARANCE = "sprout.appearance";

  var THEME_IDS = THEMES.map(function (t) { return t.id; });
  var listeners = [];
  var current = { theme: DEFAULT_THEME, appearance: DEFAULT_APPEARANCE, resolved: "light" };

  function safeGet(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { if (global.localStorage) global.localStorage.setItem(key, value); } catch (e) {}
  }

  function normalizeTheme(value) {
    return THEME_IDS.indexOf(value) !== -1 ? value : DEFAULT_THEME;
  }
  function normalizeAppearance(value) {
    return (value === "light" || value === "dark" || value === "system") ? value : DEFAULT_APPEARANCE;
  }

  function prefersDark() {
    try {
      return !!(global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (e) {
      return false;
    }
  }

  function resolveAppearance(appearance) {
    return appearance === "system" ? (prefersDark() ? "dark" : "light") : appearance;
  }

  function getTheme(id) {
    var wanted = normalizeTheme(id);
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === wanted) return THEMES[i];
    }
    return THEMES[0];
  }

  /** Accent hex for surfaces that can't use CSS custom properties (injected widgets). */
  function accentHex(themeId, resolvedAppearance) {
    var theme = getTheme(themeId);
    return resolvedAppearance === "dark" ? theme.swatchDark : theme.swatch;
  }

  // This file is also injected as a content script so page-level widgets can pick up
  // the accent colour. In that case it must NOT stamp attributes on the visited site's
  // <html> or write to that origin's localStorage — it only resolves state in memory.
  // On the dashboard this file always owns the document.
  var OWNS_DOCUMENT = true;

  function apply(themeId, appearance, options) {
    var theme = normalizeTheme(themeId);
    var mode = normalizeAppearance(appearance);
    var resolved = resolveAppearance(mode);

    var changed = current.theme !== theme || current.appearance !== mode || current.resolved !== resolved;
    current = { theme: theme, appearance: mode, resolved: resolved };

    if (OWNS_DOCUMENT) {
      var root = global.document && global.document.documentElement;
      if (root) {
        root.setAttribute("data-theme", theme);
        root.setAttribute("data-appearance", resolved);
        root.setAttribute("data-appearance-pref", mode);
      }
      safeSet(CACHE_THEME, theme);
      safeSet(CACHE_APPEARANCE, mode);
    }

    if (changed || (options && options.force)) {
      listeners.forEach(function (fn) {
        try { fn(current); } catch (e) {}
      });
    }
    return current;
  }

  /** Applies the choice and hands it to the page's persistence hook. */
  function save(themeId, appearance) {
    var next = apply(themeId, appearance);
    if (typeof global.onSproutThemeSave === "function") {
      // app.js sets this to PATCH /api/settings.
      global.onSproutThemeSave(next);
    }
    return next;
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  // 1. Paint immediately from the synchronous cache (no flash of the wrong palette).
  apply(OWNS_DOCUMENT ? safeGet(CACHE_THEME) : null, OWNS_DOCUMENT ? safeGet(CACHE_APPEARANCE) : null);

  // 2. On the web there is no chrome.storage; the server is the source of
  //    truth and app.js calls SproutTheme.apply() once settings arrive.

  // 3. Follow the OS when the user is on "System".
  try {
    if (global.matchMedia) {
      var query = global.matchMedia("(prefers-color-scheme: dark)");
      var react = function () {
        if (current.appearance === "system") apply(current.theme, "system", { force: true });
      };
      if (query.addEventListener) query.addEventListener("change", react);
      else if (query.addListener) query.addListener(react);
    }
  } catch (e) {}

  global.SproutTheme = {
    OWNS_DOCUMENT: OWNS_DOCUMENT,
    THEMES: THEMES,
    APPEARANCES: APPEARANCES,
    DEFAULT_THEME: DEFAULT_THEME,
    DEFAULT_APPEARANCE: DEFAULT_APPEARANCE,
    get: function () { return current; },
    getTheme: getTheme,
    accentHex: accentHex,
    apply: apply,
    save: save,
    onChange: onChange
  };
})(typeof window !== "undefined" ? window : self);
