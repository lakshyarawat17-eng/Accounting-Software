/**
 * RBAC — Step 10: Rollout admin API
 * ====================================
 * Backs the "Rollout & Access Status" panel on Users.html. All three
 * routes live under /rbac/rollout, which route-module-map.js maps to
 * "admin_settings" — same global `requirePermission` gate as everything
 * else, so these are Administrator-only automatically (see
 * rbac/rollout.js's NEVER_PERMISSIVE note for why admin_settings itself
 * is never made permissive during rollout).
 *
 * These are a thin HTTP wrapper around rbac/rollout.js — see that file
 * for what each operation actually does. Equivalent CLI scripts exist
 * for anyone who prefers Railway's console over clicking a button:
 * scripts/rollout-start.js and scripts/rollout-tighten.js.
 */

const { startPermissiveRollout, tightenModule, tightenAll, getRolloutStatus } = require("./rollout");

function mountRolloutRoutes(app, db) {
  app.get("/rbac/rollout/status", async (req, res) => {
    try {
      const status = await getRolloutStatus(db);
      res.json({ status });
    } catch (err) {
      console.error("ROLLOUT STATUS ERROR:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/rbac/rollout/start", async (req, res) => {
    try {
      await startPermissiveRollout(db, req.user ? req.user.id : null);
      res.json({ ok: true, status: await getRolloutStatus(db) });
    } catch (err) {
      console.error("ROLLOUT START ERROR:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/rbac/rollout/tighten/:module", async (req, res) => {
    try {
      await tightenModule(db, req.params.module, req.user ? req.user.id : null);
      res.json({ ok: true, status: await getRolloutStatus(db) });
    } catch (err) {
      console.error("ROLLOUT TIGHTEN ERROR:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/rbac/rollout/tighten-all", async (req, res) => {
    try {
      await tightenAll(db, req.user ? req.user.id : null);
      res.json({ ok: true, status: await getRolloutStatus(db) });
    } catch (err) {
      console.error("ROLLOUT TIGHTEN-ALL ERROR:", err.message);
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = { mountRolloutRoutes };
