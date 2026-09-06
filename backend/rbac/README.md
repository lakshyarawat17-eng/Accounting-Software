# RBAC — Steps 1–10 (staged rollout complete)

- **Step 1** — defined *what* the roles/modules/permissions are, as plain
  data, for review before any code depended on it.
- **Step 2** — turned that data into real tables in `accounts.db`
  (`roles`, `role_permissions`, `users`) and seeds them automatically on
  every server start.
- **Step 3** — added login/logout/session auth: `POST /auth/login`,
  `POST /auth/logout`, `GET /auth/me`, backed by a new `sessions` table
  and bcrypt password hashing.
- **Step 4** — the actual enforcement middleware. Ships **off** by
  default (dry-run/log-only) — see "Enabling enforcement" below before
  you flip it on.
- **Step 5 (frontend gate)** — `frontend/auth.js` (included on every
  page) + `frontend/Login.html`. Redirects unauthenticated visitors to
  Login.html, greys out Main Menu tiles the role can't reach, and
  patches `window.fetch` so every existing page's API calls carry the
  session cookie — see `frontend/auth.js` for details. This is what
  makes it safe to set `RBAC_ENFORCE=true`.
- **Step 6 (user management)** — `rbac/users-routes.js` +
  `frontend/Users.html`. `GET/POST /users`, `PUT /users/:id`,
  `PUT /users/:id/status`, `PUT /users/:id/password`, `GET /roles` — all
  gated by the same admin_settings module as everything else. This is
  now the way to create staff accounts; previously the only account was
  the one auto-seeded Administrator.
- **Step 9 (audit logging)** — `rbac/audit.js`. A generic `audit_log`
  table + one global middleware that automatically records every
  create/edit/delete/approve request across the whole app (who, what
  module/action, what path, what status code) — plus `created_by` /
  `updated_by` columns stamped directly onto `payment_voucher`,
  `journal_voucher`, and `payroll_run`, the three record types called
  out as needing "who approved this" visible on the row itself. See the
  big comment at the top of `rbac/audit.js` for the full reasoning.
- **Step 10 (staged rollout)** — `rbac/rollout.js`, `rbac/rollout-routes.js`
  (backing a "Rollout & Access Status" panel on `Users.html`), plus
  `rbac/test-role-coverage.js` and three helper scripts. Lets `RBAC_ENFORCE=true`
  go live in production without locking anyone out on day one, then
  tightens permissions down to the real `permission-matrix.js` values one
  module at a time, with a record of what's done and what's still
  permissive. See "Step 10: Staged Rollout" further down for the full
  runbook.

## ⚠️ Before you enable Step 4

Step 7 (the frontend `Login.html` + per-page gating) hasn't been built
yet, which means no browser currently has a session cookie. If enforcement
were on by default, deploying this would immediately 401 every single
page for every user, with no way to log in through the UI. So:

- **`RBAC_ENFORCE` is unset by default → dry run.** Every request still
  gets resolved to a module + action + allow/deny decision, but nothing
  is ever blocked. Instead, the server logs `RBAC [DRY RUN] ... would
  block` for anything that would have failed, so you can watch real
  traffic and fix mapping/matrix issues with zero risk to the live app.
- **Set `RBAC_ENFORCE=true`** (Railway → Variables) only once Step 7
  exists and real staff accounts exist to log in with. Recommended: run
  a day or two in dry run first, review the logs, then flip it.

## Files

- **`permission-matrix.js`** *(Step 1)* — the modules, actions, roles, and the
  role × module → {view, create, edit, delete, approve} matrix.
- **`route-module-map.js`** *(Step 1)* — maps every existing URL prefix in
  `server.js` / `payroll.js` to one of the modules above, via
  longest-prefix match.
- **`verify-route-coverage.js`** *(Step 1)* — sanity-checks every real
  route resolves to a module. Re-run any time you add routes:
  `node rbac/verify-route-coverage.js` (from `backend/`).
- **`db-schema.js`** *(Step 2)* — creates the 4 RBAC tables (idempotent).
- **`rollout.js`** *(Step 10)* — `startPermissiveRollout`, `tightenModule`,
  `tightenAll`, `getRolloutStatus`, backed by a new `rbac_rollout` table.
  Also exports `isModulePermissive`, which `seed.js` checks so its normal
  every-boot sync doesn't stomp a deliberately-permissive module back to
  the strict matrix on redeploy.
- **`rollout-routes.js`** *(Step 10)* — `/rbac/rollout/status`,
  `/rbac/rollout/start`, `/rbac/rollout/tighten/:module`,
  `/rbac/rollout/tighten-all` — all gated by `admin_settings` like
  everything else in this list.
- **`test-role-coverage.js`** *(Step 10)* — automated "does every role's
  actual access match `permission-matrix.js`" check over HTTP. Run with
  `node rbac/test-role-coverage.js` (needs the server running and test
  accounts seeded — see `scripts/seed-test-users.js` below).
- **`seed.js`** *(Step 2)* — upserts roles/role_permissions from
  `permission-matrix.js` on every boot, and creates exactly one
  Administrator account the first time `users` is empty.
- **`auth.js`** *(Step 3)* — password hashing, session create/validate/
  destroy, the `attachUser`/`requireAuth` middleware, and the
  `/auth/login` `/auth/logout` `/auth/me` route handlers.
- **`action-map.js`** *(Step 4)* — maps HTTP method + path to a
  permission action (`view`/`create`/`edit`/`delete`/`approve`). Most
  routes follow the verb; a handful of workflow routes (cancel, approve,
  process, dispose, etc.) are explicitly listed to map to `approve`
  regardless of verb.
- **`enforce.js`** *(Step 4)* — the actual middleware:
  `resolveModuleForPath` → `resolveAction` → DB permission lookup →
  allow/deny (or dry-run log).
- **`users-routes.js`** *(Step 6)* — `/users` and `/roles` CRUD backing
  `frontend/Users.html`. No hard-delete route on purpose (same reasoning
  as `/locations` etc. elsewhere in the app) — deactivate via
  `PUT /users/:id/status` instead, which also revokes their sessions.
  Refuses to deactivate or reassign the last active Administrator.
- **`audit.js`** *(Step 9)* — `ensureAuditTable` (creates `audit_log`,
  idempotent), `ensureOwnershipColumns` (idempotent `ALTER TABLE ADD
  COLUMN` for `created_by`/`updated_by` on the 3 sensitive tables),
  `auditMiddleware` (the global `app.use()`, mounted after
  `requirePermission` so it can read `req.user` + `req.rbac`), and
  `recordAudit` (the raw insert helper, also usable directly if you ever
  want to log something outside the generic request/response cycle).

All six are wired into `server.js` right after the database connection
opens (search for `RBAC (Steps 2 & 3)`), as global `app.use()` calls
that run before every route — including payroll.js's `/hr/*`, since that
module is `require()`d later in the file and therefore automatically
passes through these middlewares too. Beyond the 3 `created_by`/
`updated_by` stamps described below, no other changes were needed in
`payroll.js` itself for audit logging — the generic middleware covers
the rest of `/hr/*` automatically.

## Database schema (Step 2)

```
roles              id, key (unique), label, description, created_at
role_permissions   id, role_id -> roles.id, module,
                    can_view, can_create, can_edit, can_delete, can_approve
                    UNIQUE(role_id, module)
users              id, name, email (unique), password_hash,
                    role_id -> roles.id, is_active, created_at, last_login_at
sessions           token (PK), user_id -> users.id, created_at,
                    expires_at, user_agent, ip
```

`role_permissions` is re-synced from `permission-matrix.js` on **every**
server boot (an upsert — `ON CONFLICT DO UPDATE`), so editing the matrix
file and redeploying is enough to change permissions; you never need to
hand-edit this table. `users` is never touched by the sync — only
`ensureDefaultAdmin()` writes to it, and only when the table is empty.

## First login (Step 2's seeded admin)

The very first time the server boots against a fresh `accounts.db`, it
prints the generated Administrator credentials to the server console
**once**:

```
============================================================
RBAC: created the default Administrator account
  email:    admin@example.com
  password: <random>
  Log in and change this password immediately.
============================================================
```

To control these instead of getting a random password, set
`RBAC_ADMIN_EMAIL` and `RBAC_ADMIN_PASSWORD` as environment variables
**before** the first boot (e.g. in Railway's variables panel). After the
first user exists, these env vars are ignored — there is currently no
"change my password" endpoint yet (that's part of Step 8's User
Management screen); for now, changing it means updating `password_hash`
directly via a small script using `rbac/auth.js`'s `hashPassword()`.

## Auth API (Step 3)

| Route | Body | Notes |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | Sets an httpOnly `sid` cookie. Returns `{ user }`. |
| `POST /auth/logout` | — | Clears the session, both server-side and the cookie. |
| `GET /auth/me` | — | Requires the cookie. Returns `{ user, role, permissions }` — the same shape Step 7's frontend will use to grey out menu items. |

Session cookie: httpOnly, 12-hour expiry, `Secure`+`SameSite=None` in
production (`NODE_ENV=production`) so it works across the Vercel/Railway
domain split, `SameSite=Lax` locally so it works over plain HTTP in dev.

**New dependencies** — added to `package.json`, run `npm install` before
starting the server: `bcrypt`, `cookie-parser`.

## Testing it locally

```bash
npm install
npm start
# console prints the generated admin email/password on first boot
# console also prints "RBAC: running in DRY RUN mode" — this is expected

curl -i -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"<paste the printed password>"}'

curl -i -b cookies.txt http://localhost:3000/auth/me
```

`/auth/me` should return your user, role (`admin`), and the full
permission matrix for that role.

To see Step 4's dry-run decisions in action, make a couple of requests
(logged in or not, doesn't matter yet) and watch the server console —
you'll see `RBAC [DRY RUN] ... would block` for anything a non-admin role
wouldn't be allowed to do once enforcement is switched on, with nothing
actually blocked.

## How permission checks work (Step 4)

For every incoming request:

1. `resolveModuleForPath(req.path)` (Step 1) — figures out which module
   the URL belongs to. `null` = explicitly not gated (`/auth`,
   `/webhooks`, `/__test__`) → request proceeds immediately. `undefined`
   = no match at all → **fails closed** (admin-only) once enforcing, so a
   forgotten new route can't accidentally end up wide open — fix this by
   adding the route's prefix to `route-module-map.js`.
2. `resolveAction(req.method, req.path)` (Step 4) — GET→view, POST→create,
   PUT/PATCH→edit, DELETE→delete, with workflow routes (cancel/approve/
   reject/close/process/mark-paid/dispose/verify) overridden to `approve`.
3. A DB lookup joining `role_permissions` → `roles` on the caller's role
   and the resolved module, checking the corresponding `can_<action>`
   column.
4. Allow → `next()`. Deny → `403` (or `401` if not logged in at all) —
   or, in dry run, always `next()` with a console warning either way.

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

## Audit logging (Step 9)

**`audit_log` table** (mirrors the existing `email_log`/`whatsapp_log`
convention — a plain append-only table, never blocking anything):

```
audit_log   id, user_id, user_name, role_key, module, action,
             method, path, entity_id, status_code, summary, created_at
```

**How rows get written:** `auditMiddleware` is one global `app.use()`,
mounted right after Step 4's `requirePermission`. It reads `req.user`
(Step 3) and `req.rbac` — the `{ module, action, allowed }` object
Step 4's enforcement middleware already computed for every request — and
on `res.on('finish')` writes one row for every request whose action is
`create`, `edit`, `delete`, or `approve` (GETs are skipped; they'd dwarf
the table with no "who changed what" value). This is one middleware
instead of hand-adding a logging call to the ~150 individual write
routes, same reasoning as Step 5's centralized permission check — and it
means **every `DELETE` anywhere in the app is audited automatically**,
which matters because a deleted row obviously can't carry its own
`created_by` column; the `audit_log` row is what proves who deleted it
and when.

`entity_id` is best-effort — pulled from `req.params.id`, which covers
the overwhelming majority of routes (`/journal/:id`, `/asset/:id/dispose`,
`/hr/payroll/run/:id/process`, etc.). Routes that create a brand-new
record with no `:id` yet (`/payment/save`, `/save-journal`, ...) log
`entity_id: null` — the row's own `created_by` column (see below) is
where "who created it" actually lives for those.

`summary` is a trimmed JSON dump of `req.body`, with `password` /
`password_hash` fields always stripped, capped at 500 characters.

**Failed attempts are logged too** — `status_code` records what actually
happened (e.g. a 403 from Step 4 once `RBAC_ENFORCE=true`, a 400
validation error, a 404), so "someone tried to delete X and it wasn't
found" is visible, not just successful writes.

**`created_by` / `updated_by` columns** — added via idempotent
`ALTER TABLE ADD COLUMN` (same pattern as the existing
`ALTER TABLE whatsapp_log ADD COLUMN provider TEXT`) to the three record
types the business specifically flagged as needing this on the row
itself:

| Table | Stamped on | Where |
|---|---|---|
| `journal_voucher` | `created_by` | Every call to `saveJournalInternal()` — the single choke point used by sales, purchase, assets, depreciation, disposal, debit/credit notes, payments, and payroll (15 call sites total across `server.js` and `payroll.js`) now passes `userId: req.user ? req.user.id : null` |
| `payment_voucher` | `created_by` | `POST /payment/save` |
| `payroll_run` | `created_by` | `POST /hr/payroll/run/create` |
| `payroll_run` | `updated_by` | `POST /hr/payroll/run/:id/process`, `POST /hr/payroll/run/:id/mark-paid` |

`role_permissions`, `users`, deletions, and every other table are **not**
given ownership columns — they're covered by the generic `audit_log`
above instead, which is a better fit for "who did this" on records that
either don't have a natural single owner or can be deleted entirely.

**Viewing the log today:** there's no `/audit` viewer route or UI screen
yet — query `audit_log` directly (e.g. via a small script, same as
`scripts/backfill-*.js`) or build a read-only Admin screen against it as
a follow-up. It's intentionally kept as infrastructure-only in this
step, same as Step 2 shipped the RBAC tables before Step 3 added a way
to log in with them.

## Sanity check

`node rbac/verify-route-coverage.js` (run from `backend/`) diffs the
route list actually registered in `server.js`/`payroll.js` against
`route-module-map.js` and flags anything unmapped — useful to re-run any
time new routes are added, so nothing accidentally ships without an RBAC
module assignment.

## Step 10: Staged Rollout

Steps 1-9 built the machinery. This is the actual runbook for turning it
on in production without breaking anyone's workday — "seed everyone as
Admin, test each role against each module, progressively tighten," plus
the deployment specifics, made concrete.

### 0. Pre-flight (do this before touching anything below)

- **Back up the database**: `npm run backup-db` (or `DATA_DIR=/data npm
  run backup-db` against a Railway Volume). Copies `accounts.db` to
  `backups/accounts-<timestamp>.db`. Do this before starting rollout and
  again before tightening each module, same as you would before Step 2's
  original migration.
- **Confirm production env vars** (see `.env.example` for the full list
  with explanations):
  - `NODE_ENV=production` — without this, `rbac/auth.js`'s cookie is
    sent without `Secure`/`SameSite=None` and most browsers will refuse
    to send it back cross-origin (Vercel frontend + Railway backend are
    different domains). This is what makes `secure: true` cookies
    actually take effect — see `cookieOptions()` in `rbac/auth.js`.
  - `RBAC_ADMIN_EMAIL` / `RBAC_ADMIN_PASSWORD` — set before first boot
    if you haven't already (ignored after the first user row exists).
  - **No `SESSION_SECRET` or `JWT_SECRET` is needed.** This app's Step 3
    uses random opaque tokens in a server-side `sessions` table, not a
    signed/stateless token — there's no secret to configure. See the
    note at the bottom of `.env.example` if you're wondering where it
    went relative to the original 10-step plan.
- **Create real staff accounts** via Users.html (Step 8) if you haven't
  already, so people aren't sharing the seeded Administrator login.

### 1. Seed everyone as Admin (make it safe to flip the switch)

```bash
# Via the UI: Users.html -> "Rollout & Access Status" panel -> Start rollout
# Via CLI:
npm run rbac-rollout start
```

This sets every role's permissions equal to Administrator's for every
*business* module (`admin_settings`/user-management stays admin-only
throughout — see the big comment in `rbac/rollout.js` for why that one
module is a deliberate exception to "everyone as Admin"). `permission-matrix.js`
itself is untouched; this only changes the live `role_permissions` data,
and survives redeploys (`seed.js` skips modules mid-rollout — see its
Step 10 comment).

Now set `RBAC_ENFORCE=true` on Railway. Real login is required and
`audit_log` starts recording real `user_id`s on every write — but
because every role is currently permissive, nobody is denied anything
yet. This is the moment "flip the switch" stops being scary.

### 2. Test each role against each module

- **Automated**: `node scripts/seed-test-users.js` (creates one login
  per role, shared password), then `node rbac/test-role-coverage.js`
  against the running server. It logs in as each role and hits one
  real GET route per module, comparing the response to what
  `permission-matrix.js` expects. Re-run this after every module you
  tighten in step 3 — mismatches should shrink to zero as you go.
- **Manual**: log in as each `test.<role>@yourcompany.test` account
  through `Login.html` and click through the pages that role's job
  actually needs, since the automated pass only checks `view` on one
  sample route per module, not every create/edit/delete/approve action.

### 3. Progressively tighten, module by module

```bash
# Via the UI: Users.html panel -> "Tighten" next to a module
# Via CLI, one module at a time:
npm run rbac-rollout tighten sales
npm run rbac-rollout tighten purchase
# ...repeat for each of: dashboard, reports, masters, sales, purchase,
# inventory, assets, accounts_finance, payroll_hr
# Or all remaining modules in one go once you've built confidence:
npm run rbac-rollout tighten-all
```

Each call copies `permission-matrix.js`'s real, business-reviewed values
for that one module into every role, and records it as `tightened` in
`rbac_rollout` — visible in the status panel/`/rbac/rollout/status`. Do
this on whatever cadence the business is comfortable with (a module a
day, a module a week); modules not yet tightened stay fully permissive
the whole time, so there's no partial/inconsistent state where two
untouched modules interact badly.

After each tighten, re-run `node rbac/test-role-coverage.js` and watch
`audit_log` / server logs for real 403s from real staff — a 403 here
either means the matrix genuinely needs adjusting (edit
`permission-matrix.js`, redeploy, re-run `tighten` for that module) or
someone's job needs a permission nobody anticipated in Step 1.

### 4. Wrap up

- Once every module shows `tightened`, deactivate the `test.*` accounts
  (`Users.html` → Deactivate) — they're QA-only and share a well-known
  password.
- Change the seeded Administrator's password if you haven't already
  (no self-service "change my password" endpoint yet — see "First
  login" above).
- Keep `RBAC_ENFORCE=true` and the pre-flight backup habit going forward
  for any future `permission-matrix.js` change.

## Other next steps (not part of Step 10)

- **Field/data-level restrictions** beyond module gating (e.g. hiding
  salary figures or margin data from roles that shouldn't see them, not
  just blocking the endpoint).
- **An Audit Log viewer screen** (Admin-only, same CRUD-screen pattern as
  Users.html) — `audit_log` (Step 9) has all the data now, just no UI to
  browse/filter it yet.
