/**
 * RBAC — Step 10: Rollout CLI
 * ==============================
 * A command-line equivalent of the "Rollout & Access Status" panel on
 * Users.html — for running Step 10 from a Railway shell / local
 * terminal instead of clicking through the UI. Same underlying
 * functions (rbac/rollout.js), same effect either way.
 *
 * Usage (from backend/):
 *   node scripts/rollout-cli.js status
 *   node scripts/rollout-cli.js start
 *   node scripts/rollout-cli.js tighten <module-key>
 *   node scripts/rollout-cli.js tighten-all
 *
 * Module keys: dashboard, reports, masters, sales, purchase, inventory,
 * assets, accounts_finance, payroll_hr, admin_settings (see
 * rbac/permission-matrix.js MODULES for the full list + descriptions).
 *
 * Back up first: node scripts/backup-accounts-db.js
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { startPermissiveRollout, tightenModule, tightenAll, getRolloutStatus } = require("../rbac/rollout");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "accounts.db");
const db = new sqlite3.Database(DB_PATH);

function printStatus(rows) {
  console.log("Module".padEnd(20), "Status".padEnd(14), "Tightened at");
  console.log("-".repeat(60));
  for (const r of rows) {
    console.log(r.module.padEnd(20), r.status.padEnd(14), r.tightened_at || "");
  }
}

async function main() {
  const [, , cmd, arg] = process.argv;
  console.log(`Using DB: ${DB_PATH}\n`);

  if (cmd === "status") {
    printStatus(await getRolloutStatus(db));
  } else if (cmd === "start") {
    await startPermissiveRollout(db, null);
    printStatus(await getRolloutStatus(db));
  } else if (cmd === "tighten") {
    if (!arg) throw new Error("Usage: node scripts/rollout-cli.js tighten <module-key>");
    await tightenModule(db, arg, null);
    printStatus(await getRolloutStatus(db));
  } else if (cmd === "tighten-all") {
    await tightenAll(db, null);
    printStatus(await getRolloutStatus(db));
  } else {
    console.log("Usage: node scripts/rollout-cli.js <status|start|tighten <module>|tighten-all>");
    process.exit(1);
  }

  db.close();
}

main().catch(err => {
  console.error("ROLLOUT CLI ERROR:", err.message);
  process.exit(1);
});
