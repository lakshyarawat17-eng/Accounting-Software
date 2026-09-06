/**
 * RBAC — Step 10: Staged Rollout
 * =================================
 * Steps 1-9 built the machinery (roles, auth, enforcement, user mgmt,
 * audit log). This file is what actually lets you flip `RBAC_ENFORCE=true`
 * in production without every non-admin user getting locked out on day 1,
 * and then walks permissions down to the real target matrix
 * (permission-matrix.js) one module at a time, with a record of exactly
 * what's been tightened and what hasn't.
 *
 * THE PROBLEM THIS SOLVES
 * ------------------------
 * permission-matrix.js already encodes the *final*, business-reviewed
 * permissions (Accountant can't create sales invoices, Sales Exec can't
 * touch payroll, etc). That's correct as a target — but flipping
 * RBAC_ENFORCE=true straight onto that matrix on day 1 means the first
 * time a Sales Executive tries something the matrix doesn't allow (maybe
 * the matrix has a gap nobody noticed, maybe their job has grown since
 * Step 1 was written), they get a hard 403 in the middle of their
 * workday. That's the "flip a switch" failure mode Step 10 exists to
 * avoid.
 *
 * THE APPROACH
 * ------------
 * 1. `startPermissiveRollout()` temporarily overwrites `role_permissions`
 *    in the DB (NOT permission-matrix.js — that file is untouched and
 *    stays the source of truth for the target state) so every role has
 *    the same access as Administrator to every *business* module. This
 *    is the literal "seed everyone as Admin" from the plan. Combined
 *    with RBAC_ENFORCE=true, this means: everyone must log in (Step 3/7
 *    still fully apply — no more anonymous access, and audit_log Step 9
 *    now has a real user_id on every row) but nobody's daily work breaks,
 *    because nobody is denied anything yet.
 *
 *    Deliberate exception: `admin_settings` (user management) is NOT
 *    made permissive — it stays admin-only even during rollout. Handing
 *    every role the ability to create/deactivate user accounts, even
 *    temporarily, is a bigger risk than the "seed everyone as Admin"
 *    step is trying to solve, and nothing in the app requires non-admin
 *    roles to reach it. See the README's Step 10 section for the full
 *    reasoning.
 *
 * 2. With everyone logged in and nothing blocked, use
 *    `rbac/test-role-coverage.js` (systematic, automated) and manual
 *    click-through per role (systematic, human) to verify the app
 *    actually works end-to-end per role — this is "test each role
 *    against each module" from the plan, now actually possible because
 *    real accounts exist and audit_log is recording real usage.
 *
 * 3. `tightenModule(moduleKey)` copies permission-matrix.js's real,
 *    reviewed values for ONE module back into `role_permissions` across
 *    every role, and records that module as tightened in a new
 *    `rbac_rollout` tracking table. Repeat per module, on whatever cadence
 *    the business is comfortable with — this is "progressively tighten
 *    permissions module by module." Nothing else changes: RBAC_ENFORCE
 *    stays true throughout, so tightening module N doesn't touch modules
 *    N+1..10, which are still permissive until their turn.
 *
 * 4. `getRolloutStatus()` / the `/rbac/rollout/status` route / the panel
 *    in Users.html always show, per module, whether it's still
 *    permissive or already tightened — so "which modules are done" is a
 *    glance, not something you have to remember or reconstruct from
 *    server logs.
 *
 * This file only touches `role_permissions` rows (data), never
 * `permission-matrix.js` (code) — so seed.js's normal upsert-on-boot
 * behavior would actually stomp a permissive rollout back to the target
 * matrix on the next deploy. To prevent that, seed.js's sync is skipped
 * for any module rbac_rollout marks as "not yet tightened" — see the
 * `isRolloutActive()` guard wired into seed.js.
 */

const { ROLES, MODULES, DEFAULT_ROLE_PERMISSIONS, getPermission } = require("./permission-matrix");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// admin_settings is never included in the permissive rollout — see the
// big comment above. It's tightened (== matches the real matrix) from
// the very start of rollout.
const NEVER_PERMISSIVE = new Set(["admin_settings"]);

const FULL_PERM = { view: true, create: true, edit: true, delete: true, approve: true };

async function ensureRolloutTable(db) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS rbac_rollout (
      module TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'not_started',
      tightened_at TEXT,
      tightened_by INTEGER REFERENCES users(id)
    )`
  );

  // One row per module, defaulting to 'not_started'. Idempotent — only
  // inserts rows that don't already exist.
  for (const mod of MODULES) {
    await run(
      db,
      `INSERT OR IGNORE INTO rbac_rollout (module, status) VALUES (?, 'not_started')`,
      [mod.key]
    );
  }
}

/**
 * Is this module still mid-rollout (permissive, not yet matched to the
 * real matrix)? seed.js consults this so its normal every-boot upsert
 * doesn't clobber a deliberately-permissive module back to the strict
 * target the moment the server restarts.
 */
async function isModulePermissive(db, moduleKey) {
  if (NEVER_PERMISSIVE.has(moduleKey)) return false;
  try {
    const row = await get(db, `SELECT status FROM rbac_rollout WHERE module = ?`, [moduleKey]);
    // No row yet (rollout never started) -> not in a special permissive
    // state; seed.js should just apply the real matrix as it always has.
    if (!row) return false;
    return row.status === "permissive";
  } catch (err) {
    // rbac_rollout doesn't exist yet (very first boot, before
    // ensureRolloutTable has run) — fail safe to "not permissive" so
    // seed.js's normal sync behavior proceeds unchanged.
    return false;
  }
}

async function setRolePermissionRow(db, roleId, moduleKey, perm) {
  await run(
    db,
    `INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(role_id, module) DO UPDATE SET
       can_view = excluded.can_view,
       can_create = excluded.can_create,
       can_edit = excluded.can_edit,
       can_delete = excluded.can_delete,
       can_approve = excluded.can_approve`,
    [roleId, moduleKey, perm.view ? 1 : 0, perm.create ? 1 : 0, perm.edit ? 1 : 0, perm.delete ? 1 : 0, perm.approve ? 1 : 0]
  );
}

/**
 * Step 10a — "seed everyone as Admin so nothing breaks."
 * Marks every business module (everything except admin_settings)
 * `permissive` and grants every role full access to it, regardless of
 * what permission-matrix.js says. Refuses to run a second time once any
 * module has already been tightened, to avoid accidentally re-loosening
 * something the business already signed off on — use `tightenModule` /
 * `retightenAll` instead if you need to adjust after that point.
 */
async function startPermissiveRollout(db, actingUserId) {
  await ensureRolloutTable(db);

  const alreadyTightened = await all(
    db,
    `SELECT module FROM rbac_rollout WHERE status = 'tightened'`
  );
  if (alreadyTightened.length > 0) {
    const names = alreadyTightened.map(r => r.module).join(", ");
    throw new Error(
      `Rollout already has tightened module(s) (${names}). Refusing to restart a fresh ` +
      `permissive rollout, which would re-loosen them. Use tightenModule() for the ` +
      `remaining modules instead.`
    );
  }

  const roleRows = await all(db, `SELECT id, key FROM roles`);

  for (const mod of MODULES) {
    if (NEVER_PERMISSIVE.has(mod.key)) continue;
    for (const role of roleRows) {
      await setRolePermissionRow(db, role.id, mod.key, FULL_PERM);
    }
    await run(
      db,
      `UPDATE rbac_rollout SET status = 'permissive', tightened_at = NULL, tightened_by = NULL WHERE module = ?`,
      [mod.key]
    );
  }

  console.log(
    "RBAC ROLLOUT: every role now has full access to every business module " +
    "(admin_settings excluded). Safe to set RBAC_ENFORCE=true — nothing will be " +
    "denied until you call tightenModule() per module."
  );
}

/**
 * Step 10b — restore permission-matrix.js's real, reviewed values for
 * ONE module across every role, and mark it 'tightened'. Safe to call
 * on a module that's already tightened (re-applies the same values —
 * useful after editing permission-matrix.js).
 */
async function tightenModule(db, moduleKey, actingUserId) {
  await ensureRolloutTable(db);

  const mod = MODULES.find(m => m.key === moduleKey);
  if (!mod) throw new Error(`Unknown module '${moduleKey}'`);

  const roleRows = await all(db, `SELECT id, key FROM roles`);
  const EMPTY = { view: false, create: false, edit: false, delete: false, approve: false };

  for (const role of roleRows) {
    const target = (DEFAULT_ROLE_PERMISSIONS[role.key] || {})[moduleKey] || EMPTY;
    await setRolePermissionRow(db, role.id, moduleKey, target);
  }

  await run(
    db,
    `INSERT INTO rbac_rollout (module, status, tightened_at, tightened_by)
     VALUES (?, 'tightened', datetime('now'), ?)
     ON CONFLICT(module) DO UPDATE SET
       status = 'tightened', tightened_at = datetime('now'), tightened_by = excluded.tightened_by`,
    [moduleKey, actingUserId || null]
  );

  console.log(`RBAC ROLLOUT: '${moduleKey}' tightened to its real permission-matrix.js values.`);
}

/** Tighten every remaining module in one call — for finishing the rollout in one go. */
async function tightenAll(db, actingUserId) {
  for (const mod of MODULES) {
    await tightenModule(db, mod.key, actingUserId);
  }
}

/**
 * Per-module status for the admin UI / CLI: not_started (matrix applied
 * normally, rollout never used), permissive (temporarily wide open),
 * or tightened (matches permission-matrix.js, locked in).
 */
async function getRolloutStatus(db) {
  await ensureRolloutTable(db);
  const rows = await all(
    db,
    `SELECT r.module, r.status, r.tightened_at, u.name AS tightened_by_name
     FROM rbac_rollout r
     LEFT JOIN users u ON u.id = r.tightened_by`
  );
  const byModule = Object.fromEntries(rows.map(r => [r.module, r]));

  return MODULES.map(mod => {
    const row = byModule[mod.key] || { status: "not_started", tightened_at: null, tightened_by_name: null };
    return {
      module: mod.key,
      label: mod.label,
      status: NEVER_PERMISSIVE.has(mod.key) ? "tightened" : row.status,
      tightened_at: row.tightened_at,
      tightened_by: row.tightened_by_name
    };
  });
}

module.exports = {
  ensureRolloutTable,
  isModulePermissive,
  startPermissiveRollout,
  tightenModule,
  tightenAll,
  getRolloutStatus
};
