/**
 * RBAC — Step 4: Enforcement Middleware
 * ========================================
 * This is the step that turns everything from Steps 1-3 from "we know
 * who you are" into "we actually check what you're allowed to do."
 *
 * DEFAULT IS NOW FAIL-CLOSED (ENFORCING)
 * ---------------------------------------
 * Step 7 (Login.html + the frontend gate in auth.js) is built and live,
 * and Step 2's ensureDefaultAdmin() guarantees an Administrator account
 * exists from the very first boot — so there is no longer a bootstrapping
 * reason to ship open by default. Enforcement is now ON unless something
 * explicitly turns it off.
 *
 * Previously this defaulted to DRY RUN (log-only, always calls next())
 * unless RBAC_ENFORCE was the literal string "true". That meant an
 * *unset or lost* env var — a fresh deploy, a redeploy that dropped a
 * Railway variable, a local .env without it — silently disabled all
 * access control on every route, including payroll and user management,
 * for anyone who could reach the API at all. That failure mode is why
 * the default has been flipped: losing/forgetting the variable now
 * fails safe (locked down) instead of failing open (wide open).
 *
 * To run in dry-run mode instead (e.g. briefly, while watching logs
 * before a first-ever rollout, or in local dev before any real accounts
 * exist), set the literal string:
 *
 *     RBAC_ENFORCE=false
 *
 * as an environment variable. This must now be set *explicitly and on
 * purpose* — there's no accidental way to end up here. See rbac/rollout.js
 * for the recommended way to bring a fresh permission matrix online
 * without locking out real users on day one (startPermissiveRollout() +
 * tightenModule() per module) — that machinery, not dry-run mode, is the
 * supported path for a safe rollout now that Step 7 exists.
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
  // Fail-closed default: enforcing unless RBAC_ENFORCE is the literal
  // string "false". Any unset/misspelled/missing value now enforces,
  // rather than silently opening every route.
  const enforce = process.env.RBAC_ENFORCE !== "false";

  if (!enforce) {
    const warning =
      "RBAC: running in DRY RUN mode (RBAC_ENFORCE=false) — no requests are " +
      "being blocked, every route is reachable by anyone who can send a " +
      "request. This should only ever be set intentionally, briefly, and " +
      "never left on in a real deployment.";
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "\n" + "!".repeat(70) + "\n" +
        "RBAC WARNING: RBAC_ENFORCE=false in a PRODUCTION environment.\n" +
        "Access control is completely disabled for every route in this app,\n" +
        "including payroll and user management. Remove RBAC_ENFORCE=false\n" +
        "(or set it to anything other than \"false\") unless this is a\n" +
        "deliberate, temporary rollback.\n" +
        "!".repeat(70) + "\n"
      );
    } else {
      console.log(warning);
    }
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
