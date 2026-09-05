/**
 * RBAC — Step 8: User Management
 * =================================
 * Backs the new Users.html admin screen. Before this file, the only way
 * a user account could come into existence was ensureDefaultAdmin()'s
 * one-time seeded Administrator (rbac/seed.js) — there was no way to add
 * staff, change a role, deactivate someone who left, or reset a
 * forgotten password without hand-editing the database.
 *
 * All routes below live under /users and /roles, both of which
 * route-module-map.js already resolves to the "admin_settings" module —
 * they're gated by the exact same global `requirePermission` middleware
 * (rbac/enforce.js) as every other route, nothing new to wire up there.
 * In the default matrix (permission-matrix.js) only the `admin` role has
 * any access to admin_settings at all, so in practice these are
 * Administrator-only today, and stay that way automatically if you
 * later add a role with partial admin_settings access.
 *
 * Deliberately NOT included: a hard DELETE /users/:id. Same reasoning as
 * /locations and friends elsewhere in this app — a user row is
 * referenced by history (sessions, and later Step 9's created_by/
 * updated_by audit columns) that shouldn't disappear along with the
 * account. "Remove someone's access" is PUT /users/:id/status with
 * { is_active: false } instead, which also revokes every session they
 * currently hold.
 */

const { hashPassword } = require("./auth");

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    is_active: !!row.is_active,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    role: { key: row.role_key, label: row.role_label }
  };
}

/**
 * Guards against locking yourself out of the app entirely: refuses a
 * deactivate or role-change if it would leave zero active Administrator
 * accounts. Pass the id of the user being changed so they're excluded
 * from the "remaining admins" count (i.e. checks what's left *after*
 * this change).
 */
async function wouldRemoveLastAdmin(db, userIdBeingChanged) {
  const row = await get(
    db,
    `SELECT COUNT(*) AS c
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.key = 'admin' AND u.is_active = 1 AND u.id != ?`,
    [userIdBeingChanged]
  );
  return row.c === 0;
}

function mountUserRoutes(app, db) {
  /* ---------------- Roles (for the assignment dropdown) ---------------- */
  app.get("/roles", async (req, res) => {
    try {
      const roles = await all(db, `SELECT id, key, label, description FROM roles ORDER BY id`);
      res.json(roles);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ---------------- List users ---------------- */
  app.get("/users", async (req, res) => {
    try {
      const rows = await all(
        db,
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
                r.key AS role_key, r.label AS role_label
         FROM users u
         JOIN roles r ON r.id = u.role_id
         ORDER BY u.is_active DESC, u.name COLLATE NOCASE`
      );
      res.json(rows.map(publicUser));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ---------------- Get one user ---------------- */
  app.get("/users/:id", async (req, res) => {
    try {
      const row = await get(
        db,
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
                r.key AS role_key, r.label AS role_label
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: "User not found" });
      res.json(publicUser(row));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ---------------- Create a user ---------------- */
  app.post("/users", async (req, res) => {
    try {
      const { name, email, password, role_key } = req.body || {};

      if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
      if (!email || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      if (!role_key) return res.status(400).json({ error: "A role is required" });

      const role = await get(db, `SELECT id FROM roles WHERE key = ?`, [role_key]);
      if (!role) return res.status(400).json({ error: `Unknown role: ${role_key}` });

      const passwordHash = await hashPassword(password);

      const result = await run(
        db,
        `INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`,
        [name.trim(), email.trim().toLowerCase(), passwordHash, role.id]
      ).catch(err => {
        if (/UNIQUE/i.test(err.message)) {
          throw new Error("A user with this email already exists");
        }
        throw err;
      });

      const row = await get(
        db,
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
                r.key AS role_key, r.label AS role_label
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [result.lastID]
      );
      res.json(publicUser(row));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------------- Edit name / email / role ---------------- */
  app.put("/users/:id", async (req, res) => {
    try {
      const { name, email, role_key } = req.body || {};
      const userId = req.params.id;

      const existing = await get(
        db,
        `SELECT u.*, r.key AS current_role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [userId]
      );
      if (!existing) return res.status(404).json({ error: "User not found" });

      if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
      if (!email || !EMAIL_PATTERN.test(email.trim())) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (!role_key) return res.status(400).json({ error: "A role is required" });

      const role = await get(db, `SELECT id, key FROM roles WHERE key = ?`, [role_key]);
      if (!role) return res.status(400).json({ error: `Unknown role: ${role_key}` });

      if (existing.current_role_key === "admin" && role.key !== "admin" && existing.is_active) {
        if (await wouldRemoveLastAdmin(db, userId)) {
          return res.status(400).json({
            error: "Can't change this user's role — they're the only active Administrator. Promote someone else first."
          });
        }
      }

      await run(
        db,
        `UPDATE users SET name = ?, email = ?, role_id = ? WHERE id = ?`,
        [name.trim(), email.trim().toLowerCase(), role.id, userId]
      ).catch(err => {
        if (/UNIQUE/i.test(err.message)) {
          throw new Error("A user with this email already exists");
        }
        throw err;
      });

      const row = await get(
        db,
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
                r.key AS role_key, r.label AS role_label
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [userId]
      );
      res.json(publicUser(row));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------------- Activate / deactivate ---------------- */
  app.put("/users/:id/status", async (req, res) => {
    try {
      const userId = req.params.id;
      const { is_active } = req.body || {};
      if (typeof is_active !== "boolean") {
        return res.status(400).json({ error: "is_active (boolean) is required" });
      }

      const existing = await get(
        db,
        `SELECT u.*, r.key AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [userId]
      );
      if (!existing) return res.status(404).json({ error: "User not found" });

      if (!is_active && existing.role_key === "admin" && existing.is_active) {
        if (await wouldRemoveLastAdmin(db, userId)) {
          return res.status(400).json({
            error: "Can't deactivate this user — they're the only active Administrator. Promote someone else first."
          });
        }
      }

      await run(db, `UPDATE users SET is_active = ? WHERE id = ?`, [is_active ? 1 : 0, userId]);

      // Deactivating someone should kick them out immediately, not just
      // block their next login.
      if (!is_active) {
        await run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]);
      }

      const row = await get(
        db,
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
                r.key AS role_key, r.label AS role_label
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [userId]
      );
      res.json(publicUser(row));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ---------------- Reset password (admin-set, not a "forgot password" flow) ---------------- */
  app.put("/users/:id/password", async (req, res) => {
    try {
      const userId = req.params.id;
      const { password } = req.body || {};
      if (!password || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const existing = await get(db, `SELECT id FROM users WHERE id = ?`, [userId]);
      if (!existing) return res.status(404).json({ error: "User not found" });

      const passwordHash = await hashPassword(password);
      await run(db, `UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, userId]);

      // A password reset should invalidate any session issued under the
      // old password (e.g. a shared/compromised account being locked down).
      await run(db, `DELETE FROM sessions WHERE user_id = ?`, [userId]);

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = { mountUserRoutes };
