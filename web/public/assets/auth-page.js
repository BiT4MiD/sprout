/* Sign-in / create-account screen. */
(function () {
  "use strict";

  const banner = document.getElementById("authBanner");
  const loginForm = document.getElementById("loginForm");
  const signupForm = document.getElementById("signupForm");

  function show(message, kind) {
    banner.textContent = message || "";
    banner.className = "banner " + (kind || "error");
    banner.hidden = !message;
  }

  function markFields(fields) {
    document.querySelectorAll("[data-field-error]").forEach((n) => n.remove());
    if (!fields) return;
    for (const [name, reason] of Object.entries(fields)) {
      const input = document.querySelector(`input[name="${name}"]:not([hidden])`) ||
                    document.getElementById("login" + name[0].toUpperCase() + name.slice(1)) ||
                    document.getElementById("signup" + name[0].toUpperCase() + name.slice(1));
      if (!input) continue;
      const note = document.createElement("p");
      note.className = "hint";
      note.style.color = "var(--danger)";
      note.dataset.fieldError = "1";
      note.textContent = reason;
      input.insertAdjacentElement("afterend", note);
    }
  }

  function swap(toSignup) {
    show("");
    markFields(null);
    loginForm.hidden = toSignup;
    signupForm.hidden = !toSignup;
    (toSignup ? document.getElementById("signupEmail") : document.getElementById("loginEmail")).focus();
  }

  document.getElementById("showSignup").addEventListener("click", (e) => { e.preventDefault(); swap(true); });
  document.getElementById("showLogin").addEventListener("click", (e) => { e.preventDefault(); swap(false); });

  async function submit(form, button, run) {
    show("");
    markFields(null);
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Working…";
    try {
      const result = await run();
      api.setCsrfToken(result.csrfToken);
      // Carry the theme choice across so the dashboard opens in the right palette.
      location.href = "/app";
    } catch (err) {
      show(err.message || "Something went wrong.");
      markFields(err.fields);
      button.disabled = false;
      button.textContent = label;
    }
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(loginForm, document.getElementById("loginSubmit"), () => api.login({
      email: document.getElementById("loginEmail").value,
      password: document.getElementById("loginPassword").value
    }));
  });

  signupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(signupForm, document.getElementById("signupSubmit"), () => api.signup({
      email: document.getElementById("signupEmail").value,
      password: document.getElementById("signupPassword").value,
      displayName: document.getElementById("signupName").value,
      // The browser knows the user's zone; the server would only ever guess.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    }));
  });

  // Already signed in? Don't make them look at a login form.
  api.me().then(() => { location.href = "/app"; }).catch(() => {});
})();
