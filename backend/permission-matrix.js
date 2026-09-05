/**
 * RBAC — Step 1: Roles & Permission Matrix
 * ==========================================
 * This file is the single source of truth for "who can do what" in the
 * app. It does NOT enforce anything by itself yet — later steps will:
 *   Step 2 — migrate this into `roles` / `role_permissions` tables in accounts.db
 *   Step 5 — use ROUTE_MODULE_MAP (route-module-map.js) + this matrix in an
 *            Express middleware that checks every incoming request
 *   Step 7 — use the same MODULES/ACTIONS list on the frontend to grey out
 *            Main Menu tiles the logged-in user's role can't access
 *
 * Treat this file as the editable "business sign-off" document for RBAC —
 * it's plain data, no framework code, specifically so it can be reviewed
 * and adjusted before anything is wired up.
 */

/* ---------------------------------------------------------------------
 * MODULES
 * Every route in server.js / payroll.js has been grouped into one of the
 * modules below (see route-module-map.js for the exact prefix -> module
 * mapping this was derived from). Two prefixes are deliberately left OUT
 * of this system entirely:
 *   - /auth/*      (the login flow itself — must be reachable while logged out)
 *   - /webhooks/*  (inbound WhatsApp webhook calls — not a logged-in user)
 * ------------------------------------------------------------------- */
const MODULES = [
  { key: "dashboard",        label: "Dashboards",                description: "Executive Dashboard, Sales & Purchase Analytics" },
  { key: "reports",          label: "Reports",                   description: "GST/HSN summaries, ageing, stock & item reports, GSTR filings" },
  { key: "masters",          label: "Master Data",                description: "Clients, Suppliers, Items, Locations, reference data" },
  { key: "sales",            label: "Sales",                      description: "Sales Orders, Sales Invoices, Delivery Challans, Credit Notes" },
  { key: "purchase",         label: "Purchase",                   description: "Purchase Orders, Purchase Invoices, Debit Notes" },
  { key: "inventory",        label: "Inventory & Manufacturing",  description: "Stock, Stock Transfers, BOM, Work Orders" },
  { key: "assets",           label: "Fixed Assets",               description: "Asset register, categories, depreciation runs, disposal/transfer" },
  { key: "accounts_finance", label: "Accounts & Finance",         description: "Journal Vouchers, Ledger, Payments, Receivables/Payables" },
  { key: "payroll_hr",       label: "Payroll & HR",                description: "Employees, Attendance, Leave, Loans, Payroll Runs (all /hr/*)" },
  { key: "admin_settings",   label: "Administration",             description: "Company Settings, User & Role Management" }
];

/* ---------------------------------------------------------------------
 * ACTIONS
 * Not every module uses every action — e.g. Dashboards/Reports are
 * view-only, so their create/edit/delete/approve are always false and
 * simply ignored by the middleware. Keeping the action set uniform
 * across modules keeps the matrix below easy to read and edit.
 * ------------------------------------------------------------------- */
const ACTIONS = ["view", "create", "edit", "delete", "approve"];

/* ---------------------------------------------------------------------
 * ROLES
 * A first-pass set based on the modules above. Expected to be refined
 * once the real org chart / job titles are confirmed.
 * ------------------------------------------------------------------- */
const ROLES = [
  { key: "admin",             label: "Administrator",         description: "Full access to every module, including user management" },
  { key: "accountant",        label: "Accountant",             description: "Owns books of account, GST, approvals; views sales/purchase, doesn't create them" },
  { key: "sales_exec",        label: "Sales Executive",        description: "Runs the sales cycle end to end; read-only elsewhere" },
  { key: "purchase_exec",     label: "Purchase Executive",     description: "Runs the purchase cycle end to end; read-only elsewhere" },
  { key: "inventory_manager", label: "Inventory Manager",      description: "Owns stock, transfers, BOM/work orders; read-only on sales/purchase for planning" },
  { key: "hr_payroll",        label: "HR & Payroll Officer",   description: "Owns the entire /hr/* module exclusively; no access to accounting modules" },
  { key: "auditor",           label: "Auditor (Read-only)",    description: "View-only across financial/operational modules; payroll excluded by default for privacy" }
];

/* ---------------------------------------------------------------------
 * DEFAULT PERMISSION MATRIX
 * permission(role, module) -> { view, create, edit, delete, approve }
 * Any module/action combination not listed defaults to `false` — see
 * the `perm()` helper and `getPermission()` below.
 * ------------------------------------------------------------------- */
function perm(view = false, create = false, edit = false, del = false, approve = false) {
  return { view, create, edit, delete: del, approve };
}

const DEFAULT_ROLE_PERMISSIONS = {
  admin: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true, true, true, true),
    sales: perm(true, true, true, true, true),
    purchase: perm(true, true, true, true, true),
    inventory: perm(true, true, true, true, true),
    assets: perm(true, true, true, true, true),
    accounts_finance: perm(true, true, true, true, true),
    payroll_hr: perm(true, true, true, true, true),
    admin_settings: perm(true, true, true, true)
  },

  accountant: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true, true, true, false),
    sales: perm(true, false, true, false, true),
    purchase: perm(true, false, true, false, true),
    inventory: perm(true),
    assets: perm(true, true, true, false, true),
    accounts_finance: perm(true, true, true, false, true),
    payroll_hr: perm(true),
    admin_settings: perm(false)
  },

  sales_exec: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true, true, true, false),
    sales: perm(true, true, true, false, true),
    purchase: perm(false),
    inventory: perm(true),
    assets: perm(false),
    accounts_finance: perm(true),
    payroll_hr: perm(false),
    admin_settings: perm(false)
  },

  purchase_exec: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true, true, true, false),
    sales: perm(false),
    purchase: perm(true, true, true, false, true),
    inventory: perm(true, false, true, false),
    assets: perm(false),
    accounts_finance: perm(true),
    payroll_hr: perm(false),
    admin_settings: perm(false)
  },

  inventory_manager: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true, true, true, false),
    sales: perm(true),
    purchase: perm(true),
    inventory: perm(true, true, true, true, true),
    assets: perm(false),
    accounts_finance: perm(false),
    payroll_hr: perm(false),
    admin_settings: perm(false)
  },

  hr_payroll: {
    dashboard: perm(false),
    reports: perm(false),
    masters: perm(true),
    sales: perm(false),
    purchase: perm(false),
    inventory: perm(false),
    assets: perm(false),
    accounts_finance: perm(false),
    payroll_hr: perm(true, true, true, true, true),
    admin_settings: perm(false)
  },

  auditor: {
    dashboard: perm(true),
    reports: perm(true),
    masters: perm(true),
    sales: perm(true),
    purchase: perm(true),
    inventory: perm(true),
    assets: perm(true),
    accounts_finance: perm(true),
    payroll_hr: perm(false), // excluded by default — salary data is sensitive; flip to perm(true) if auditor needs it
    admin_settings: perm(false)
  }
};

/**
 * Look up a single permission, defaulting missing entries to false rather
 * than throwing — so an incomplete matrix fails closed, not open.
 */
function getPermission(roleKey, moduleKey, action) {
  const rolePerms = DEFAULT_ROLE_PERMISSIONS[roleKey];
  if (!rolePerms) return false;
  const modulePerms = rolePerms[moduleKey];
  if (!modulePerms) return false;
  return !!modulePerms[action];
}

module.exports = {
  MODULES,
  ACTIONS,
  ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  getPermission
};
