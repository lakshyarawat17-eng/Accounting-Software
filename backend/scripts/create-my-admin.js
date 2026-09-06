/**
 * scripts/create-my-admin.js
 * ============================================================
 * One-off recovery tool: lets YOU create (or reset) your own
 * Administrator login when you're locked out of the app because
 * you never captured the console-printed credentials from
 * rbac/seed.js's ensureDefaultAdmin(), or you've lost the password.
 *
 * It connects to the exact same accounts.db that server.js uses
 * (same DATA_DIR env var), so run this in the same environment as
 * your deployed backend (e.g. `railway run node scripts/create-my-admin.js`)
 * — not on your laptop against a different, empty database.
 *
 * USAGE
 * -----
 *   List existing users (safe, read-only, no changes):
 *     node scripts/create-my-admin.js --list
 *
 *   Create yourself as a new Administrator, or reset your password if
 *   that email already exists:
 *     node scripts/create-my-admin.js --email you@yourcompany.com --password "SomeStrongPassword123!" --name "Your Name"
 *
 * WHAT IT DOES
 * ------------
 *   --list             Prints id, name, email, role, is_active for every
 *                       row in `users`. Nothing is changed.
 *   --email / --password
 *                       If a user with that email already exists: updates
 *                       their password_hash in place (using the same
 *                       bcrypt hashPassword() the app itself uses) and
 *                       makes sure they're an active Administrator.
 *                       If no such user exists: inserts a brand-new
 *                       Administrator row.
 *   --name              Optional, only used when creating a new row
 *                       (defaults to "Administrator").
 *
 * This does NOT touch any other user, and does not disable anyone.
 * Delete this file once you're done — it's a recovery tool, not
 * something that should stay reachable long-term.
 */

const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { hashPassword } = require("../rbac/auth");

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

function parseArgs(argv) {
  const out = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--email") out.email = argv[++i];
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--name") out.name = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const DATA_DIR = process.env.DATA_DIR || __dirname + "/..";
  const dbPath = path.join(DATA_DIR, "accounts.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`No database found at ${dbPath}. Are you running this in the same environment/DATA_DIR as the live server? (e.g. \`railway run node scripts/create-my-admin.js\`)`);
    process.exit(1);
  }
  console.log("Using DB file:", dbPath);

  const db = new sqlite3.Database(dbPath);

  if (args.list) {
    const rows = await all(
      db,
      `SELECT u.id, u.name, u.email, u.is_active, r.key AS role_key, u.last_login_at
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
       ORDER BY u.id`
    );
    if (rows.length === 0) {
      console.log("No users exist yet — the table is empty. Run again with --email/--password to create yourself as Administrator.");
    } else {
      console.log(`Found ${rows.length} user(s):`);
      console.table(rows);
    }
    db.close();
    return;
  }

  if (!args.email || !args.password) {
    console.error("Usage:\n  node scripts/create-my-admin.js --list\n  node scripts/create-my-admin.js --email you@company.com --password \"SomeStrongPassword123!\" [--name \"Your Name\"]");
    db.close();
    process.exit(1);
  }
  if (args.password.length < 8) {
    console.error("Please choose a password with at least 8 characters.");
    db.close();
    process.exit(1);
  }

  const adminRole = await get(db, `SELECT id FROM roles WHERE key = 'admin'`);
  if (!adminRole) {
    console.error("No 'admin' role found in role_permissions yet — start the server once first so rbac/seed.js can seed roles, then re-run this script.");
    db.close();
    process.exit(1);
  }

  const passwordHash = await hashPassword(args.password);
  const existing = await get(db, `SELECT id FROM users WHERE email = ?`, [args.email]);

  if (existing) {
    await run(
      db,
      `UPDATE users SET password_hash = ?, role_id = ?, is_active = 1 WHERE id = ?`,
      [passwordHash, adminRole.id, existing.id]
    );
    console.log(`Updated existing user id=${existing.id} (${args.email}): password reset, role set to Administrator, account activated.`);
  } else {
    const result = await run(
      db,
      `INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`,
      [args.name || "Administrator", args.email, passwordHash, adminRole.id]
    );
    console.log(`Created new Administrator user id=${result.lastID}: ${args.email}`);
  }

  console.log("\nYou can now log in at Login.html with:");
  console.log(`  email:    ${args.email}`);
  console.log(`  password: (the one you just passed in)`);

  db.close();
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
