/* Typed-ish fetch client. One place that knows about credentials, CSRF and
   the error envelope, so no page has to think about any of it. */
(function (global) {
  "use strict";

  var csrfToken = null;

  function url(path, params) {
    var u = new URL(path, global.location.origin);
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
      });
    }
    return u.toString();
  }

  /**
   * @throws {ApiError} with .code / .message / .fields, matching docs/API.md
   */
  async function request(method, path, { body, params } = {}) {
    var headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (csrfToken && method !== "GET") headers["x-csrf-token"] = csrfToken;

    var res = await fetch(url(path, params), {
      method: method,
      credentials: "same-origin",
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (res.status === 204) return null;

    var payload = null;
    try { payload = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
      var err = new Error((payload && payload.error && payload.error.message) || "Request failed");
      err.status = res.status;
      err.code = (payload && payload.error && payload.error.code) || "unknown";
      err.fields = payload && payload.error && payload.error.fields;
      throw err;
    }
    return payload;
  }

  global.api = {
    setCsrfToken: function (t) { csrfToken = t; },

    // auth
    me:       ()      => request("GET",  "/api/auth/me"),
    login:    (body)  => request("POST", "/api/auth/login",  { body }),
    signup:   (body)  => request("POST", "/api/auth/signup", { body }),
    logout:   ()      => request("POST", "/api/auth/logout"),
    changePassword: (body) => request("POST", "/api/auth/password", { body }),

    // settings
    getSettings:   ()      => request("GET",   "/api/settings"),
    patchSettings: (patch) => request("PATCH", "/api/settings", { body: patch }),

    // rules & schedules
    getRules:   ()          => request("GET",    "/api/rules"),
    addRule:    (body)      => request("POST",   "/api/rules", { body }),
    bulkAdd:    (body)      => request("POST",   "/api/rules/bulk", { body }),
    patchRule:  (id, body)  => request("PATCH",  "/api/rules/" + id, { body }),
    deleteRule: (id)        => request("DELETE", "/api/rules/" + id),
    getSchedules: ()        => request("GET",    "/api/schedules"),

    // stats
    summary:    (range)     => request("GET", "/api/stats/summary",    { params: { range } }),
    timeseries: (range, b)  => request("GET", "/api/stats/timeseries", { params: { range, bucket: b || "day" } }),
    domains:    (range, o)  => request("GET", "/api/stats/domains",    { params: Object.assign({ range }, o || {}) }),
    hourly:     (range)     => request("GET", "/api/stats/hourly",     { params: { range } }),
    sessions:   (range, c)  => request("GET", "/api/stats/sessions",   { params: { range, cursor: c } }),

    createSchedule: (body) => request("POST",   "/api/schedules", { body }),
    deleteSchedule: (id)   => request("DELETE", "/api/schedules/" + id),

    // devices
    devices:      ()   => request("GET",    "/api/devices"),
    pairCode:     ()   => request("POST",   "/api/devices/pair-code"),
    revokeDevice: (id) => request("DELETE", "/api/devices/" + id),

    // account
    audit: (limit)      => request("GET",    "/api/account/audit", { params: { limit } }),
    deleteAccount: (b)  => request("DELETE", "/api/account", { body: b })
  };
})(window);
