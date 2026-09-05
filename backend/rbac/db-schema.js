/**
 * RBAC — Step 2: Database Schema
 * =================================
 * Creates the four tables RBAC needs. Idempotent (CREATE TABLE IF NOT
 * EXISTS), same convention as the rest of server.js's table setup, so
 * it's safe to call on every server start.
 *
 *   roles             — the 7 roles from permission-matrix.js
 *   role_permissions  — role x module -> {view, create, edit, delete, approve}
 *   users             — one row per login, references a role
 *   sessions          — server-side session store for Step 3's cookie auth
 *                        (a session row = one logged-in browser)
 *
 * This file only creates tables — it does not populate them. See
 * seed.js for that (Step 2's data half) and auth.js for how sessions
 * get written to/read from at login time (Step 3).
 */

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}

async function ensureRbacTables(db) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_edit INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      can_approve INTEGER NOT NULL DEFAULT 0,
      UNIQUE(role_id, module)
    )`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT
    )`
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      user_agent TEXT,
      ip TEXT
    )`
  );

  console.log("RBAC: tables ready (roles, role_permissions, users, sessions)");
}

module.exports = { ensureRbacTables, run };
