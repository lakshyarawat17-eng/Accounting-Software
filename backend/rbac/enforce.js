/**
 * RBAC — Step 4: Enforcement Middleware
 * ========================================
 * This is the step that turns everything from Steps 1-3 from "we know
 * who you are" into "we actually check what you're allowed to do."
 *
 * IMPORTANT — READ BEFORE ENABLING
 * ---------------------------------
 * Step 7 (the frontend Login.html + per-page auth check) hasn't been
 * built yet. Nobody's browser currently sends the session cookie, because
 * there's no login screen for them to have gotten one from. If this
 * middleware enforces on day one, EVERY user of every page goes straight
 * to a wall of 401s — the whole app stops working until Step 7 ships.
 *
 * So this ships in DRY-RUN mode by default: it resolves the module +
 * action for every request and logs exactly what it WOULD have blocked
 * and why, but always calls next() and lets the request through
 * unchanged. Nothing about current behavior changes until you explicitly
 * opt in.
 *
 * To actually start enforcing (only do this once Step 7's Login.html
 * exists and staff have real accounts — see Step 2's admin bootstrap):
 *
 *     RBAC_ENFORCE=true
 *
 * as an environment variable (Railway → Variables). Recommended rollout:
 * run a day or two in dry-run first, watch the server logs for
 * `RBAC [DRY RUN] ... would block`, fix any route-mapping gaps or
 * matrix mistakes those reveal, THEN flip RBAC_ENFORCE=true.
 *
 * Covers every route automatically, including payroll.js's /hr/* — this
 * is a single global middleware registered in server.js before any route
 * (including the later `require("./payroll")(app, db, ...)` call) is
 * registered, so nothing needed to change in payroll.js itself.
 */

const { resolveModuleForPath } = require("./route-module-map");
const { resolveAction } = require("./action-map");

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

const ACTION_COLUMN = {
  view: "can_view",
  create: "can_create",
  edit: "can_edit",
  delete: "can_delete",
  approve: "can_approve"
};

async function hasPermission(db, roleKey, moduleKey, action) {
  if (!roleKey) return false;
  const column = ACTION_COLUMN[action];
  if (!column) return false;

  const row = await get(
    db,
    `SELECT rp.${column} AS allowed
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     WHERE r.key = ? AND rp.module = ?`,
    [roleKey, moduleKey]
  );
  return !!(row && row.allowed);
}

function requirePermission(db) {
  const enforce = process.env.RBAC_ENFORCE === "true";
  if (!enforce) {
    console.log(
      "RBAC: running in DRY RUN mode (no requests are being blocked). " +
      "Set RBAC_ENFORCE=true once Login.html (Step 7) is live to start enforcing."
    );
  }

  return async (req, res, next) => {
    const moduleKey = resolveModuleForPath(req.path);

    // Explicit bypass: /auth, /webhooks, /__test__ — see route-module-map.js
    if (moduleKey === null) return next();

    // Route not found in route-module-map.js at all. Fail closed once
    // enforcing (admin-only) rather than silently wide open; in dry run,
    // just flag it loudly so it gets added before you flip the switch.
    if (moduleKey === undefined) {
      console.warn(
        `RBAC: ${req.method} ${req.path} matched no entry in route-module-map.js. ` +
        (enforce ? "BLOCKING (fail-closed, admin-only) until it's added." : "[DRY RUN] would fail-closed to admin-only.")
      );
      if (!enforce) return next();
      if (!req.user || req.user.role_key !== "admin") {
        return res.status(403).json({
          error: "This route isn't covered by access control yet — contact an administrator."
        });
      }
      return next();
    }

    const action = resolveAction(req.method, req.path);

    if (!req.user) {
      if (!enforce) {
        console.warn(`RBAC [DRY RUN] ${req.method} ${req.path} -> ${moduleKey}.${action}: would block (not logged in)`);
        return next();
      }
      return res.status(401).json({ error: "Not authenticated" });
    }

    let allowed = false;
    try {
      allowed = await hasPermission(db, req.user.role_key, moduleKey, action);
    } catch (err) {
      console.error("RBAC permission lookup failed:", err.message);
      // A DB error here should not silently grant access.
      if (enforce) return res.status(500).json({ error: "Permission check failed" });
    }

    req.rbac = { module: moduleKey, action, allowed };

    if (!allowed) {
      const reason = `${req.user.role_label} does not have '${action}' access to '${moduleKey}'`;
      if (!enforce) {
        console.warn(`RBAC [DRY RUN] ${req.method} ${req.path} -> ${reason} — would block.`);
        return next();
      }
      return res.status(403).json({ error: reason });
    }

    next();
  };
}

module.exports = { requirePermission, hasPermission };
