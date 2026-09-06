/**
 * RBAC — Step 10: Test accounts, one per role
 * ==============================================
 * "Test each role against each module systematically" needs a real
 * logged-in account per role to test with — up to now the only account
 * that has ever existed is the single seeded Administrator (rbac/seed.js).
 *
 * This creates (or updates the password of, if already present) one
 * account per non-admin role in permission-matrix.js:
 *   test.accountant@yourcompany.test
 *   test.sales_exec@yourcompany.test
 *   ...etc, using each role's `key`.
 * All share the same password so whoever's testing only needs to
 * remember one (override with TEST_USER_PASSWORD).
 *
 * These are for the rollout QA window only — see the Step 10 checklist
 * in rbac/README.md for deactivating them afterward (PUT /users/:id/status
 * via Users.html, or leave them deactivated-but-present if you'd rather
 * keep them around for the next time permissions change).
 *
 * Refuses to run against a production database unless you pass --force,
 * since these are throwaway, well-known-password accounts and have no
 * business existing in a real company's live system longer than the
 * rollout QA window.
 *
 * Usage (from backend/):
 *   node scripts/seed-test-users.js                # local/dev DB
 *   NODE_ENV=production node scripts/seed-test-users.js --force   # prod, explicit opt-in
 *   TEST_USER_PASSWORD=SomethingElse123! node scripts/seed-test-users.js
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { ROLES } = require("../rbac/permission-matrix");
const { hashPassword } = require("../rbac/auth");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "accounts.db");
const FORCE = process.argv.includes("--force");
const PASSWORD = process.env.TEST_USER_PASSWORD || "RbacRollout123!";

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function main() {
  if (process.env.NODE_ENV === "production" && !FORCE) {
    console.error(
      "Refusing to seed well-known-password test accounts into a production " +
      "database without --force. Re-run with --force if you're sure, and " +
      "deactivate these accounts again once the rollout QA window is over."
    );
    process.exit(1);
  }

  console.log(`Using DB: ${DB_PATH}`);
  console.log(`Test account password: ${PASSWORD}\n`);

  const passwordHash = await hashPassword(PASSWORD);

  for (const role of ROLES) {
    if (role.key === "admin") continue; // the seeded Administrator already covers this role

    const email = `test.${role.key}@yourcompany.test`;
    const roleRow = await get(`SELECT id FROM roles WHERE key = ?`, [role.key]);
    if (!roleRow) {
      console.warn(`Skipping ${role.key} — role not found in DB yet (has the server booted at least once?)`);
      continue;
    }

    const existing = await get(`SELECT id FROM users WHERE lower(email) = lower(?)`, [email]);
    if (existing) {
      await run(`UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?`, [passwordHash, existing.id]);
      console.log(`Updated:  ${email}  (${role.label})`);
    } else {
      await run(
        `INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`,
        [`Test — ${role.label}`, email, passwordHash, roleRow.id]
      );
      console.log(`Created:  ${email}  (${role.label})`);
    }
  }

  console.log("\nDone. Log in as any of these through Login.html, or run rbac/test-role-coverage.js for an automated pass.");
  db.close();
}

main().catch(err => {
  console.error("SEED TEST USERS ERROR:", err.message);
  process.exit(1);
});
