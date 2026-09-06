/**
 * RBAC — Step 2: Seeding
 * ========================
 * Populates roles + role_permissions from permission-matrix.js (Step 1),
 * and creates exactly one Administrator account the very first time the
 * users table is empty.
 *
 * seedRoles() is deliberately safe to run on EVERY server start — it's an
 * upsert (ON CONFLICT DO UPDATE), so if you edit ROLES or
 * DEFAULT_ROLE_PERMISSIONS in rbac/permission-matrix.js and redeploy, the
 * database picks up the change automatically. It never touches the
 * `users` table.
 *
 * ensureDefaultAdmin() only acts once: as soon as any row exists in
 * `users`, it's a no-op forever after — it will never reset an existing
 * admin's password or create a second default account.
 */

const crypto = require("crypto");
const { ROLES, MODULES, DEFAULT_ROLE_PERMISSIONS } = require("./permission-matrix");
const { hashPassword } = require("./auth");
const { isModulePermissive } = require("./rollout");

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

const EMPTY_PERM = { view: false, create: false, edit: false, delete: false, approve: false };

async function seedRoles(db) {
  for (const role of ROLES) {
    await run(
      db,
      `INSERT INTO roles (key, label, description) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label, description = excluded.description`,
      [role.key, role.label, role.description]
    );
  }

  const roleRows = await all(db, `SELECT id, key FROM roles`);
  const roleIdByKey = Object.fromEntries(roleRows.map(r => [r.key, r.id]));

  for (const role of ROLES) {
    const roleId = roleIdByKey[role.key];
    const perms = DEFAULT_ROLE_PERMISSIONS[role.key] || {};
    for (const mod of MODULES) {
      // Step 10: a module mid-rollout (deliberately made permissive by
      // rbac/rollout.js's startPermissiveRollout) must survive a server
      // restart as permissive — otherwise this every-boot sync would
      // silently snap it back to the strict target the moment the app
      // redeploys, defeating the whole point of a staged rollout.
      // Untouched modules (rollout never run, or already tightened)
      // sync from permission-matrix.js exactly as before.
      if (await isModulePermissive(db, mod.key)) continue;

      const p = perms[mod.key] || EMPTY_PERM;
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
        [roleId, mod.key, p.view ? 1 : 0, p.create ? 1 : 0, p.edit ? 1 : 0, p.delete ? 1 : 0, p.approve ? 1 : 0]
      );
    }
  }

  console.log(`RBAC: synced ${ROLES.length} role(s) x ${MODULES.length} module(s) from permission-matrix.js`);
}

async function ensureDefaultAdmin(db) {
  const existing = await get(db, `SELECT COUNT(*) AS c FROM users`);
  if (existing.c > 0) return; // users already exist — never auto-create again

  const adminRole = await get(db, `SELECT id FROM roles WHERE key = 'admin'`);
  if (!adminRole) throw new Error("RBAC: 'admin' role not found — seedRoles() must run before ensureDefaultAdmin()");

  const email = process.env.RBAC_ADMIN_EMAIL || "admin@example.com";
  const password = process.env.RBAC_ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(password);

  await run(
    db,
    `INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`,
    ["Administrator", email, passwordHash, adminRole.id]
  );

  console.log("============================================================");
  console.log("RBAC: created the default Administrator account");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log("  Log in and change this password immediately.");
  console.log("  Set RBAC_ADMIN_EMAIL / RBAC_ADMIN_PASSWORD env vars before");
  console.log("  first boot to control these instead of getting a random one.");
  console.log("============================================================");
}

/**
 * ensureFixedAdmin() — guarantees ONE specific, hardcoded Administrator
 * login always exists, on every single boot, regardless of whether
 * `users` already has rows (unlike ensureDefaultAdmin() above, which
 * only ever fires once against an empty table).
 *
 * This exists so the developer always has a known way in, even against
 * a database (like a restored/imported one) that predates RBAC and has
 * no `users` table history of its own.
 *
 * SECURITY WARNING: "1234" is a placeholder-strength password. Anyone
 * who can reach this backend's /auth/login route can log in as a full
 * Administrator with it. Change EMAIL/PASSWORD below to something only
 * you know before deploying anywhere reachable from the internet, or
 * remove this call from server.js entirely once you have a real account
 * you trust (see rbac/users-routes.js / Users.html for creating one).
 */
const FIXED_ADMIN_EMAIL = "admin@login.com";
const FIXED_ADMIN_PASSWORD = "1234";

async function ensureFixedAdmin(db) {
  const adminRole = await get(db, `SELECT id FROM roles WHERE key = 'admin'`);
  if (!adminRole) throw new Error("RBAC: 'admin' role not found — seedRoles() must run before ensureFixedAdmin()");

  const passwordHash = await hashPassword(FIXED_ADMIN_PASSWORD);
  const existing = await get(db, `SELECT id FROM users WHERE email = ?`, [FIXED_ADMIN_EMAIL]);

  if (existing) {
    // Already exists — leave name/created_at alone, just make sure the
    // password/role/active-state match what's hardcoded above, in case
    // it was ever changed or deactivated.
    await run(
      db,
      `UPDATE users SET password_hash = ?, role_id = ?, is_active = 1 WHERE id = ?`,
      [passwordHash, adminRole.id, existing.id]
    );
  } else {
    await run(
      db,
      `INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`,
      ["Administrator", FIXED_ADMIN_EMAIL, passwordHash, adminRole.id]
    );
    console.log("============================================================");
    console.log("RBAC: created fixed Administrator account");
    console.log(`  email:    ${FIXED_ADMIN_EMAIL}`);
    console.log(`  password: ${FIXED_ADMIN_PASSWORD}`);
    console.log("  This is a hardcoded credential (rbac/seed.js) — change it");
    console.log("  before this backend is reachable from the internet.");
    console.log("============================================================");
  }
}

module.exports = { seedRoles, ensureDefaultAdmin, ensureFixedAdmin };
