/**
 * RBAC — Step 10: DB backup
 * ============================
 * "A DB backup before running the migration in step 2" from the plan —
 * generalized into a script worth running before ANY schema change or
 * rollout action (starting a permissive rollout, tightening a module,
 * or a future migration), not just Step 2's original one.
 *
 * Copies the live SQLite file to backups/accounts-<timestamp>.db.
 * SQLite files can be safely copied while the server is running as long
 * as no write is in flight at that exact instant, but for a database
 * this size, stopping the server for the few seconds this takes is the
 * safer option — this script does not attempt an online hot-copy.
 *
 * Usage (from backend/):
 *   node scripts/backup-accounts-db.js
 *
 * Respects the same DATA_DIR env var as server.js, so it backs up the
 * correct file whether you're on a local dev DB or a Railway Volume:
 *   DATA_DIR=/data node scripts/backup-accounts-db.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const SRC = path.join(DATA_DIR, "accounts.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`No database found at ${SRC}. Nothing to back up.`);
    process.exit(1);
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `accounts-${timestamp()}.db`);
  fs.copyFileSync(SRC, dest);

  const sizeKb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`Backed up ${SRC}`);
  console.log(`       -> ${dest} (${sizeKb} KB)`);
  console.log(
    "\nKeep this file somewhere outside the app's own filesystem too " +
    "(download it, or copy it off the Railway Volume) — a backup that " +
    "lives next to the thing it's backing up doesn't survive a lost volume."
  );
}

main();
