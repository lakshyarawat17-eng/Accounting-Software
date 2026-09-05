# RBAC — Step 1: Roles & Permission Matrix

This folder is the output of **Step 1 only** (of the 10-step plan): defining
*what* the roles and modules are, in a plain-data form that's easy to review
and edit before any enforcement code is written.

Nothing in this folder is wired into `server.js` yet — that starts at
Step 2 (DB tables) and Step 5 (middleware). Right now these files aren't
`require()`d from anywhere.

## Files

- **`permission-matrix.js`** — the modules, actions, roles, and the
  role × module → {view, create, edit, delete, approve} matrix.
- **`route-module-map.js`** — maps every existing URL prefix in
  `server.js` / `payroll.js` to one of the modules above, via
  longest-prefix match. This is what the Step 5 middleware will use to
  figure out "which module does this request belong to?"

## Modules

| Module | Covers |
|---|---|
| Dashboards | Executive Dashboard, Sales & Purchase Analytics |
| Reports | GST/HSN summaries, ageing, stock & item reports, GSTR filings |
| Master Data | Clients, Suppliers, Items, Locations, reference data |
| Sales | Sales Orders, Sales Invoices, Delivery Challans, Credit Notes |
| Purchase | Purchase Orders, Purchase Invoices, Debit Notes |
| Inventory & Manufacturing | Stock, Stock Transfers, BOM, Work Orders |
| Fixed Assets | Asset register, categories, depreciation runs, disposal/transfer |
| Accounts & Finance | Journal Vouchers, Ledger, Payments, Receivables/Payables |
| Payroll & HR | Everything under `/hr/*` — employees, attendance, leave, loans, payroll runs |
| Administration | Company Settings, future User & Role management |

Two things are deliberately **not** gated by RBAC at all: `/auth/*` (has to
work while logged out) and `/webhooks/*` (inbound WhatsApp calls, not a
logged-in user).

## Roles (first pass)

| Role | Intent |
|---|---|
| Administrator | Full access everywhere, including user management |
| Accountant | Owns the books/GST/approvals; views sales & purchase but doesn't create them |
| Sales Executive | Runs the sales cycle end to end; read-only elsewhere |
| Purchase Executive | Runs the purchase cycle end to end; read-only elsewhere |
| Inventory Manager | Owns stock/transfers/BOM/work orders; read-only on sales & purchase for planning |
| HR & Payroll Officer | Owns `/hr/*` exclusively; no access to any accounting module |
| Auditor (Read-only) | View-only across financial/operational modules; **payroll excluded by default** |

## Permission matrix

`✔` = view, `+` = create, `✎` = edit, `🗑` = delete, `✓` = approve. Blank = no access.

| Module | Admin | Accountant | Sales Exec | Purchase Exec | Inventory Mgr | HR/Payroll | Auditor |
|---|---|---|---|---|---|---|---|
| Dashboards | ✔+✎🗑✓ | ✔ | ✔ | ✔ | ✔ | | ✔ |
| Reports | ✔+✎🗑✓ | ✔ | ✔ | ✔ | ✔ | | ✔ |
| Master Data | ✔+✎🗑 | ✔+✎ | ✔+✎ | ✔+✎ | ✔+✎ | ✔ | ✔ |
| Sales | ✔+✎🗑✓ | ✔✎✓ | ✔+✎✓ | | ✔ | | ✔ |
| Purchase | ✔+✎🗑✓ | ✔✎✓ | | ✔+✎✓ | ✔ | | ✔ |
| Inventory & Mfg | ✔+✎🗑✓ | ✔ | ✔ | ✔✎ | ✔+✎🗑✓ | | ✔ |
| Fixed Assets | ✔+✎🗑✓ | ✔+✎✓ | | | | | ✔ |
| Accounts & Finance | ✔+✎🗑✓ | ✔+✎✓ | ✔ | ✔ | | | ✔ |
| Payroll & HR | ✔+✎🗑✓ | ✔ | | | | ✔+✎🗑✓ | |
| Administration | ✔+✎🗑 | | | | | | |

**Notes / things worth confirming with the business before Step 2:**

- Accountant can *view + edit + approve* sales/purchase invoices (e.g. to
  fix a posting error) but not *create* new ones — the idea being sales
  and purchase originate with those teams. Flip `create` on if that's
  wrong for how you actually work.
- Sales/Purchase Executives get `approve` on their own module (e.g.
  self-approving an order) — if you want a maker-checker split instead
  (exec creates, accountant approves), remove `approve` from those two
  roles and rely on the Accountant's `approve` instead.
- Auditor sees everything except Payroll & HR, since salary data is
  sensitive — flip `payroll_hr.view` to `true` for that role if your
  auditor also needs payroll visibility.
- `delete` is `false` almost everywhere except Administrator — accounting
  records generally shouldn't be hard-deletable at all (cancel/reverse is
  usually the correct pattern), so treat every `delete: true` in this file
  as a deliberate exception, not a default.
- This matrix has **no concept of locations/branches yet** — if you
  operate multiple branches and need "Sales Exec for Branch A only", that
  needs an additional `location_id` scope on top of this, which isn't in
  scope for Step 1.

## Sanity check

`node rbac/verify-route-coverage.js` (run from `backend/`) diffs the
route list actually registered in `server.js`/`payroll.js` against
`route-module-map.js` and flags anything unmapped — useful to re-run any
time new routes are added, so nothing accidentally ships without an RBAC
module assignment.

## Next steps

- **Step 2**: migrate `permission-matrix.js` into `roles` /
  `role_permissions` tables in `accounts.db`, and add a `users` table.
- **Step 5**: write the Express middleware that calls
  `resolveModuleForPath(req.path)` + `getPermission(role, module, action)`
  from these files.
