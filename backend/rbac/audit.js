/**
 * RBAC — Step 9: Audit Logging
 * ================================
 * Two independent pieces:
 *
 *   1. A generic `audit_log` table + middleware that automatically
 *      records every mutating request (create/edit/delete/approve —
 *      anything Step 4's enforce.js already resolved to a non-"view"
 *      action) once it's known who's calling (Step 3, `req.user`) and
 *      which module/action it resolved to (Step 4, `req.rbac`). Mirrors
 *      the existing email_log / whatsapp_log convention elsewhere in
 *      server.js: a plain append-only table, written to via a small
 *      helper, never blocking anything.
 *
 *      This is deliberately ONE middleware instead of hand-adding a
 *      logging call to the ~150 individual write routes across
 *      server.js/payroll.js — same reasoning as Step 5's centralized
 *      permission check ("far cheaper than editing every individual
 *      app.get(...) block"). It also means every DELETE anywhere in the
 *      app is covered automatically, which matters because a deleted
 *      row can't carry its own created_by/updated_by column — the
 *      audit_log row IS the record of who deleted it and when.
 *
 *   2. `created_by` / `updated_by` columns on the three tables the
 *      business specifically called out in Step 9 as sensitive —
 *      payment_voucher, journal_voucher, and payroll_run. For those,
 *      "who created/last touched *this specific row*" is something you
 *      want visible directly on the record itself (e.g. printed on a
 *      voucher, or shown in the payroll run header), not just
 *      recoverable by searching the audit log. See server.js
 *      (saveJournalInternal, /payment/save) and payroll.js
 *      (payroll run create/process/mark-paid) for where these actually
 *      get stamped.
 *
 * Nothing here is enforcement — it's purely observational, same spirit
 * as attachUser (Step 3): it never blocks a request or changes a
 * response, it just remembers who did what.
 */

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}

async function ensureAuditTable(db) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      role_key TEXT,
      module TEXT,
      action TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      entity_id TEXT,
      status_code INTEGER,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  );
  console.log("RBAC: audit_log table ready");
}

// Idempotent "add column if missing" — SQLite has no ADD COLUMN IF NOT
// EXISTS, so this follows the same pattern already used in server.js
// (`ALTER TABLE whatsapp_log ADD COLUMN provider TEXT`, () => {})`):
// the ALTER fails with "duplicate column name" on every boot after the
// first, and that failure is expected and safely swallowed.
function addColumnIfMissing(db, table, column, type) {
  return new Promise(resolve => {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, () => resolve());
  });
}

async function ensureOwnershipColumns(db) {
  await addColumnIfMissing(db, "payment_voucher", "created_by", "INTEGER");
  await addColumnIfMissing(db, "journal_voucher", "created_by", "INTEGER");
  await addColumnIfMissing(db, "payroll_run", "created_by", "INTEGER");
  await addColumnIfMissing(db, "payroll_run", "updated_by", "INTEGER");
  console.log(
    "RBAC: created_by/updated_by columns ready (payment_voucher, journal_voucher, payroll_run)"
  );
}

// Best-effort entity id for the audit row. The overwhelming majority of
// write routes in this app follow the /prefix/:id or /prefix/:id/verb
// shape, so req.params.id covers almost everything. Deliberately does
// NOT try to guess at a body field for the ~POST /x/save routes that
// create a brand-new row with no :id yet — the response status/summary
// still records that the attempt happened, and the row itself (via
// created_by, for the 3 tables in ensureOwnershipColumns) carries the
// rest.
function extractEntityId(req) {
  if (req.params && req.params.id) return String(req.params.id);
  return null;
}

// Keeps the stored summary short and safe. Never store password /
// password_hash fields, even though today's write routes don't accept
// those directly — cheap insurance against a future route that does.
function summarize(req) {
  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) return null;
  const { password, password_hash, ...rest } = body;
  let json;
  try {
    json = JSON.stringify(rest);
  } catch {
    return null;
  }
  if (!json || json === "{}") return null;
  return json.length > 500 ? json.slice(0, 500) + "…" : json;
}

async function recordAudit(db, entry) {
  try {
    await run(
      db,
      `INSERT INTO audit_log
       (user_id, user_name, role_key, module, action, method, path, entity_id, status_code, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.userId != null ? entry.userId : null,
        entry.userName || null,
        entry.roleKey || null,
        entry.module || null,
        entry.action || null,
        entry.method,
        entry.path,
        entry.entityId != null ? entry.entityId : null,
        entry.statusCode != null ? entry.statusCode : null,
        entry.summary || null
      ]
    );
  } catch (err) {
    // Audit logging must never take the actual request down with it.
    console.error("AUDIT LOG ERROR:", err.message);
  }
}

/**
 * Mount AFTER attachUser (Step 3) and requirePermission (Step 4) — it
 * reads req.user and req.rbac, both of which those set. Registering it
 * as one global app.use() means it covers every route (including
 * payroll.js's /hr/*, required later in server.js) with zero per-route
 * changes, exactly like Step 4/5's enforcement middleware.
 */
function auditMiddleware(db) {
  return (req, res, next) => {
    res.on("finish", () => {
      // Only mutating actions get an audit trail entry — GETs would
      // dwarf this table with noise and carry no "who changed what"
      // value. req.rbac is only set for routes requirePermission()
      // actually resolved to a module (Step 4), which is every gated
      // route; /auth, /webhooks, /__test__ stay unlogged same as
      // they're unenforced.
      const action = req.rbac && req.rbac.action;
      if (!action || action === "view") return;

      recordAudit(db, {
        userId: req.user ? req.user.id : null,
        userName: req.user ? req.user.name : null,
        roleKey: req.user ? req.user.role_key : null,
        module: req.rbac.module,
        action,
        method: req.method,
        path: req.path,
        entityId: extractEntityId(req),
        statusCode: res.statusCode,
        summary: summarize(req)
      });
    });
    next();
  };
}

module.exports = {
  ensureAuditTable,
  ensureOwnershipColumns,
  recordAudit,
  auditMiddleware
};
