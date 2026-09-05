/**
 * RBAC — Step 1: Route -> Module Map
 * ====================================
 * Derived by inspecting every `app.get/post/put/delete(...)` in server.js
 * and every `app.get/post(...)` in payroll.js. This is what Step 5's
 * middleware will use to answer "which module does this incoming request
 * belong to?" via longest-prefix-match, then check the caller's role
 * against permission-matrix.js for that module.
 *
 * `module: null` means "do not gate this route with RBAC" — currently
 * just the login flow itself and the inbound WhatsApp webhook, which by
 * definition aren't called by an already-authenticated dashboard user.
 *
 * IMPORTANT: entries are matched longest-prefix-first (see
 * resolveModuleForPath below), so more specific paths like
 * "/report/dashboard-summary" are listed separately from the general
 * "/report" catch-all and will correctly take priority over it.
 */

const ROUTE_MODULE_MAP = [
  // --- Dashboards (more specific than the general /report/* catch-all below) ---
  { prefix: "/report/dashboard-summary", module: "dashboard" },
  { prefix: "/report/sales-purchase-analytics", module: "dashboard" },

  // --- Reports (GST/HSN, ageing, stock/item reports, GSTR filings) ---
  { prefix: "/report", module: "reports" },

  // --- Master data (shared across Sales & Purchase) ---
  { prefix: "/clients", module: "masters" },
  { prefix: "/suppliers", module: "masters" },
  { prefix: "/parties", module: "masters" },
  { prefix: "/items", module: "masters" },
  { prefix: "/item", module: "masters" },
  { prefix: "/reference", module: "masters" },
  { prefix: "/locations", module: "masters" },

  // --- Sales (covers /sales, /sales-invoice, /sales-invoice-items via prefix match) ---
  { prefix: "/so", module: "sales" },
  { prefix: "/sales", module: "sales" },
  { prefix: "/invoices", module: "sales" },
  { prefix: "/dc", module: "sales" },
  { prefix: "/credit-note", module: "sales" },

  // --- Purchase (covers /purchase, /purchase-invoice, /purchase-invoice-items via prefix match) ---
  { prefix: "/po", module: "purchase" },
  { prefix: "/purchase", module: "purchase" },
  { prefix: "/debit-note", module: "purchase" },

  // --- Inventory & Manufacturing (covers /stock and /stock-transfer via prefix match) ---
  { prefix: "/stock", module: "inventory" },
  { prefix: "/bom", module: "inventory" },
  { prefix: "/work-order", module: "inventory" },
  { prefix: "/wo-scrap", module: "inventory" },

  // --- Fixed Assets (covers /asset, /assets, /asset-categories via prefix match) ---
  { prefix: "/asset", module: "assets" },
  { prefix: "/fam", module: "assets" },
  { prefix: "/depreciation-run", module: "assets" },

  // --- Accounts & Finance ---
  { prefix: "/journal", module: "accounts_finance" },
  { prefix: "/save-journal", module: "accounts_finance" },
  { prefix: "/ledger", module: "accounts_finance" },
  { prefix: "/payment", module: "accounts_finance" },
  { prefix: "/receivables", module: "accounts_finance" },
  { prefix: "/payables", module: "accounts_finance" },

  // --- Payroll & HR (payroll.js — everything is already under /hr) ---
  { prefix: "/hr", module: "payroll_hr" },

  // --- Administration (existing /settings, plus /users & /roles to be added in later steps) ---
  { prefix: "/settings", module: "admin_settings" },
  { prefix: "/users", module: "admin_settings" },
  { prefix: "/roles", module: "admin_settings" },
  { prefix: "/rbac/rollout", module: "admin_settings" }, // Step 10 staged-rollout controls

  // --- Not gated by RBAC ---
  { prefix: "/auth", module: null },       // login/logout must work while logged out
  { prefix: "/webhooks", module: null },   // inbound WhatsApp webhook, not a user session
  { prefix: "/__test__", module: null }    // diagnostic route
];

// Longest prefix wins, so "/report/dashboard-summary" is checked before
// the shorter "/report" entry regardless of array order.
const SORTED_MAP = [...ROUTE_MODULE_MAP].sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Returns the module key for a given request path, or null if the path
 * isn't gated by RBAC, or undefined if the path matched nothing at all
 * (Step 5 should decide how to treat unmapped routes — recommended:
 * fail closed / require admin, then add the missing route here).
 */
function resolveModuleForPath(path) {
  const match = SORTED_MAP.find(entry => path.startsWith(entry.prefix));
  return match ? match.module : undefined;
}

module.exports = {
  ROUTE_MODULE_MAP,
  resolveModuleForPath
};
