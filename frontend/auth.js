// ============================================================
// RBAC — Step 7: Frontend gate
// ============================================================
// Include this on every page right after config.js:
//     <script src="config.js"></script>
//     <script src="auth.js"></script>
//
// What it does:
//   1. Calls GET /auth/me on load. No session (401) -> redirect to
//      Login.html?next=<this page>.
//   2. Exposes window.RBAC = { user, role, permissions, can(), logout() }
//      once the check resolves, and fires a "rbac:ready" event on
//      `document` with the same data — pages (e.g. Main Menu.html) that
//      need to grey out links/tiles per-permission listen for this.
//   3. Injects a small "Signed in as ..." badge + Logout button in the
//      top-right corner of every gated page.
//   4. Looks up PAGE_MODULE_MAP[thisPage] and, if the user's role has no
//      'view' permission on that module, blocks the page behind an
//      "Access restricted" overlay instead of letting them stare at a
//      page full of failed API calls. This is UX only — the backend
//      middleware (rbac/enforce.js) is what actually enforces access;
//      this just avoids a confusing experience once RBAC_ENFORCE=true.
//
// This file deliberately does NOT touch existing page logic/fetch calls
// — it only reads /auth/me and layers UI on top.
// ============================================================

(function () {
  // ------------------------------------------------------------
  // Auto-attach the session cookie to every existing fetch() call.
  // ------------------------------------------------------------
  // The rest of the app (Clients.html, Sales Order.html, etc. — ~49
  // pages, thousands of fetch() calls) was written before RBAC existed
  // and none of them pass `credentials: "include"`. That's invisible
  // today because RBAC_ENFORCE is off, but the moment it's turned on,
  // every one of those calls would look logged-out to the backend
  // whenever frontend and backend are on different domains (e.g. Vercel
  // + Railway) — a browser only sends cookies cross-origin if the
  // request explicitly opts in.
  //
  // Rather than editing every call site, patch window.fetch once, here,
  // before any page-specific script runs: any request aimed at
  // API_BASE_URL that didn't already set `credentials` gets
  // `credentials: "include"` added automatically. Same-origin (local
  // dev) requests are unaffected either way.
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const opts = init ? Object.assign({}, init) : {};
    if (opts.credentials === undefined) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (window.API_BASE_URL && url.indexOf(window.API_BASE_URL) === 0) {
        opts.credentials = "include";
      }
    }
    return nativeFetch.call(this, input, opts);
  };
})();

(function () {
  const LOGIN_PAGE = "Login.html";

  function currentPage() {
    const parts = window.location.pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1] || "Main Menu.html");
  }

  const THIS_PAGE = currentPage();

  // Login.html handles its own auth/me check (to bounce an already-logged-in
  // user straight to Main Menu) — don't double-gate it here.
  if (THIS_PAGE === LOGIN_PAGE) return;

  // ------------------------------------------------------------
  // Page -> RBAC module map. Mirrors backend/rbac/route-module-map.js,
  // derived from which API prefix each page actually calls. Keep this in
  // sync if a page's primary module changes or a new page is added —
  // "undefined" (no entry) means "don't gate this page's visibility",
  // it will still redirect-to-login if the session is missing.
  // ------------------------------------------------------------
  const PAGE_MODULE_MAP = {
    "Main Menu.html": null, // landing page — always reachable once logged in

    // Dashboards
    "Dashboard.html": "dashboard",
    "Sales Purchase Analytics.html": "dashboard",

    // Reports
    "GST Details.html": "reports",
    "HSN Summary.html": "reports",
    "Item Wise Report.html": "reports",
    "Outstanding and Ageing.html": "reports",

    // Master data
    "Clients.html": "masters",
    "Suppliers.html": "masters",
    "Item Master.html": "masters",
    "Locations.html": "masters",

    // Sales
    "Sales Order.html": "sales",
    "Sales Order Register.html": "sales",
    "Delivery Challan.html": "sales",
    "Delivery Challan Register.html": "sales",
    "Sales Book.html": "sales",
    "Credit Note.html": "sales",
    "Credit Note Register.html": "sales",

    // Purchase
    "Purchase Order.html": "purchase",
    "Purchase Order Register.html": "purchase",
    "Goods Receipt.html": "purchase",
    "Purchase Book.html": "purchase",
    "Debit Note.html": "purchase",
    "Debit Note Register.html": "purchase",

    // Inventory & Manufacturing
    "Stock Transfer.html": "inventory",
    "Stock Transfer Register.html": "inventory",
    "Bill of Materials.html": "inventory",
    "BOM Register.html": "inventory",
    "Work Order.html": "inventory",
    "Work Order Register.html": "inventory",

    // Fixed Assets
    "Assets.html": "assets",
    "Asset Reports.html": "assets",
    "Depreciation Run.html": "assets",

    // Accounts & Finance
    "Cash Book.html": "accounts_finance",
    "Payment and Receipt.html": "accounts_finance",
    "Journal.html": "accounts_finance",
    "Journal Register.html": "accounts_finance",
    "Ledger Master.html": "accounts_finance",
    "Ledger.html": "accounts_finance",
    "Trial Balance.html": "accounts_finance",
    "Balance Sheet.html": "accounts_finance",
    "Profit and Loss.html": "accounts_finance",

    // Payroll & HR
    "Employees.html": "payroll_hr",
    "Attendance.html": "payroll_hr",
    "Employee Loans.html": "payroll_hr",
    "Salary Structure.html": "payroll_hr",
    "Payroll Run.html": "payroll_hr",
    "Payroll Reports.html": "payroll_hr",
    "Payroll Settings.html": "payroll_hr",

    // Administration
    "Settings.html": "admin_settings",
    "Users.html": "admin_settings"
  };

  // ------------------------------------------------------------
  // Styles for the badge + overlay. Self-contained (doesn't assume
  // ui-theme.css has loaded yet / at all on every page).
  // ------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    #rbacBadge {
      position: fixed; top: 12px; right: 14px; z-index: 99999;
      display: flex; align-items: center; gap: 10px;
      background: #ffffff; border: 1px solid #dde3ec; border-radius: 999px;
      box-shadow: 0 1px 2px rgba(17,28,51,.08), 0 6px 16px rgba(17,28,51,.08);
      padding: 6px 8px 6px 14px;
      font: 500 12.5px/1.3 Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #16243f;
    }
    #rbacBadge .rbac-who { display: flex; flex-direction: column; line-height: 1.25; }
    #rbacBadge .rbac-name { font-weight: 700; }
    #rbacBadge .rbac-role {
      font-size: 11px; color: #1c4f9c; background: #e8f0fb;
      border-radius: 999px; padding: 1px 8px; margin-top: 2px; width: fit-content;
    }
    #rbacBadge button {
      font: 600 12px/1 Inter, system-ui, sans-serif; cursor: pointer;
      border: 1px solid #dde3ec; background: #fff; color: #47536a;
      border-radius: 999px; padding: 7px 12px;
    }
    #rbacBadge button:hover { border-color: #b3261e; color: #b3261e; }
    #rbacOverlay {
      position: fixed; inset: 0; z-index: 99998;
      background: #eef1f6; display: flex; align-items: center; justify-content: center;
      font: 400 14px/1.6 Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    }
    #rbacOverlay .rbac-box {
      max-width: 420px; text-align: center; background: #fff;
      border: 1px solid #dde3ec; border-radius: 12px; padding: 34px 30px;
      box-shadow: 0 1px 2px rgba(17,28,51,.06), 0 10px 24px rgba(17,28,51,.07);
    }
    #rbacOverlay h2 { margin: 0 0 10px; font-size: 19px; color: #16243f; }
    #rbacOverlay p { margin: 0 0 22px; color: #6b7686; }
    #rbacOverlay a {
      display: inline-block; text-decoration: none; font-weight: 600; font-size: 13.5px;
      background: #1c4f9c; color: #fff; border-radius: 7px; padding: 10px 18px;
    }
  `;
  document.head.appendChild(style);

  function renderBadge(data) {
    const existing = document.getElementById("rbacBadge");
    if (existing) existing.remove();

    const badge = document.createElement("div");
    badge.id = "rbacBadge";
    badge.innerHTML = `
      <div class="rbac-who">
        <span class="rbac-name"></span>
        <span class="rbac-role"></span>
      </div>
      <button type="button">Log out</button>
    `;
    badge.querySelector(".rbac-name").textContent = data.user.name || data.user.email;
    badge.querySelector(".rbac-role").textContent = data.role.label;
    badge.querySelector("button").addEventListener("click", function () {
      window.RBAC.logout();
    });
    document.body.appendChild(badge);
  }

  function renderAccessRestricted(moduleKey) {
    const overlay = document.createElement("div");
    overlay.id = "rbacOverlay";
    overlay.innerHTML = `
      <div class="rbac-box">
        <h2>Access restricted</h2>
        <p>Your role doesn't have access to this section${moduleKey ? " (" + moduleKey + ")" : ""}.
        If you think this is wrong, contact an administrator.</p>
        <a href="Main Menu.html">Back to Main Menu</a>
      </div>
    `;
    // Wait for <body> to exist since auth.js may run before it's parsed.
    if (document.body) document.body.appendChild(overlay);
    else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(overlay));
  }

  function redirectToLogin() {
    const next = encodeURIComponent(THIS_PAGE + window.location.search);
    window.location.replace(LOGIN_PAGE + "?next=" + next);
  }

  window.RBAC = {
    user: null,
    role: null,
    permissions: {},
    PAGE_MODULE_MAP: PAGE_MODULE_MAP,
    can: function (moduleKey, action) {
      const m = window.RBAC.permissions[moduleKey];
      return !!(m && m[action]);
    },
    logout: async function () {
      try {
        await fetch(window.API_BASE_URL + "/auth/logout", {
          method: "POST",
          credentials: "include"
        });
      } catch (e) {
        // Best-effort — clear the cookie server-side if possible, but
        // don't block the redirect on a network error.
      }
      window.location.replace(LOGIN_PAGE);
    }
  };

  window.RBAC.ready = fetch(window.API_BASE_URL + "/auth/me", { credentials: "include" })
    .then(function (res) {
      if (res.status === 401) {
        redirectToLogin();
        return null;
      }
      if (!res.ok) throw new Error("auth check failed: " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data) return null;

      window.RBAC.user = data.user;
      window.RBAC.role = data.role;
      window.RBAC.permissions = data.permissions || {};

      renderBadge(data);

      const moduleKey = PAGE_MODULE_MAP[THIS_PAGE];
      if (moduleKey && !window.RBAC.can(moduleKey, "view")) {
        renderAccessRestricted(moduleKey);
      }

      document.dispatchEvent(new CustomEvent("rbac:ready", { detail: data }));
      return data;
    })
    .catch(function (err) {
      // A network hiccup shouldn't silently lock everyone out; log it and
      // let the page render — the backend still enforces on every API call.
      console.error("RBAC: auth check failed:", err.message);
      return null;
    });
})();
