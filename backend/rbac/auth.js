/**
 * RBAC — Step 3: Authentication
 * ================================
 * Password hashing (bcrypt) + server-side sessions stored in the
 * `sessions` table (Step 2), identified to the browser by a single
 * httpOnly cookie. Chosen over a JWT-in-header approach specifically
 * because the frontend is ~50 plain static HTML pages, not an SPA — a
 * cookie means Step 7 (frontend gating) doesn't have to touch every
 * existing `fetch()` call to attach an Authorization header. The browser
 * just sends the cookie automatically.
 *
 * IMPORTANT — this file does NOT lock anything down yet. `attachUser`
 * only identifies who's calling (`req.user`, or null if not logged in /
 * session expired); nothing rejects a request just for being
 * unauthenticated. `requireAuth` exists and is exported, but is not
 * applied to any business route yet — enforcing view/create/edit/delete/
 * approve per route is Step 5. Right now you can log in and call
 * GET /auth/me, and that's it.
 *
 * CROSS-ORIGIN NOTE: if your frontend (e.g. Vercel) and backend (e.g.
 * Railway) are on different domains, the browser will only send this
 * cookie back if:
 *   1. CORS is configured with `credentials: true` and a specific origin
 *      (not `*`) — already done in server.js's cors() setup.
 *   2. Every frontend fetch() call to a protected endpoint passes
 *      `credentials: "include"` — not needed yet since nothing calls
 *      /auth/* from the frontend until Step 7's Login.html, but keep it
 *      in mind then.
 *   3. In production, cookies are sent with `Secure; SameSite=None`,
 *      which requires the backend to be served over HTTPS (Railway does
 *      this by default).
 */

const bcrypt = require("bcrypt");
const crypto = require("crypto");

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = "sid";
const isProd = process.env.NODE_ENV === "production";

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

/* ---------------------------------------------------------------------
 * Passwords
 * ------------------------------------------------------------------- */
function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/* ---------------------------------------------------------------------
 * Sessions
 * ------------------------------------------------------------------- */
async function createSession(db, userId, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await run(
    db,
    `INSERT INTO sessions (token, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)`,
    [token, userId, expiresAt, req.headers["user-agent"] || null, req.ip || null]
  );
  return { token, expiresAt };
}

async function getSessionUser(db, token) {
  if (!token) return null;

  const row = await get(
    db,
    `SELECT u.id, u.name, u.email, u.is_active,
            r.key AS role_key, r.label AS role_label,
            s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE s.token = ?`,
    [token]
  );
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await run(db, `DELETE FROM sessions WHERE token = ?`, [token]); // expired — clean up
    return null;
  }
  if (!row.is_active) return null; // account deactivated after the session was issued

  return row;
}

async function destroySession(db, token) {
  if (!token) return;
  await run(db, `DELETE FROM sessions WHERE token = ?`, [token]);
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: SESSION_TTL_MS,
    path: "/"
  };
}

/* ---------------------------------------------------------------------
 * Middleware
 * ------------------------------------------------------------------- */

// Identifies the caller on every request (req.user = row above, or null).
// Never rejects a request itself — safe to app.use() globally.
function attachUser(db) {
  return async (req, res, next) => {
    try {
      const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
      req.user = await getSessionUser(db, token);
    } catch (err) {
      console.error("RBAC attachUser error:", err.message);
      req.user = null;
    }
    next();
  };
}

// Not wired into any route yet — for Step 5 (and for /auth/me itself) to use.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

/* ---------------------------------------------------------------------
 * Routes: POST /auth/login, POST /auth/logout, GET /auth/me
 * ------------------------------------------------------------------- */
function mountAuthRoutes(app, db) {
  app.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: "email and password are required" });
      }

      const user = await get(
        db,
        `SELECT u.id, u.name, u.email, u.password_hash, u.is_active,
                r.key AS role_key, r.label AS role_label
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE lower(u.email) = lower(?)`,
        [email]
      );

      // Same generic error whether the email doesn't exist or the password
      // is wrong — don't help an attacker enumerate valid emails.
      if (!user || !user.is_active) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const { token } = await createSession(db, user.id, req);
      await run(db, `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [user.id]);

      res.cookie(COOKIE_NAME, token, cookieOptions());
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role_key,
          role_label: user.role_label
        }
      });
    } catch (err) {
      console.error("LOGIN ERROR:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/auth/logout", async (req, res) => {
    try {
      const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
      await destroySession(db, token);
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ ok: true });
    } catch (err) {
      console.error("LOGOUT ERROR:", err.message);
      res.status(500).json({ error: "Logout failed" });
    }
  });

  // Returns who's logged in AND their full permission matrix, so Step 7's
  // frontend can gate menus/buttons without a separate round-trip.
  app.get("/auth/me", requireAuth, async (req, res) => {
    try {
      const permRows = await all(
        db,
        `SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete, rp.can_approve
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE r.key = ?`,
        [req.user.role_key]
      );

      const permissions = {};
      for (const p of permRows) {
        permissions[p.module] = {
          view: !!p.can_view,
          create: !!p.can_create,
          edit: !!p.can_edit,
          delete: !!p.can_delete,
          approve: !!p.can_approve
        };
      }

      res.json({
        user: { id: req.user.id, name: req.user.name, email: req.user.email },
        role: { key: req.user.role_key, label: req.user.role_label },
        permissions
      });
    } catch (err) {
      console.error("AUTH ME ERROR:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  destroySession,
  attachUser,
  requireAuth,
  mountAuthRoutes,
  COOKIE_NAME
};
