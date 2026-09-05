/* -------------------- Phase 2, Step 3: stock_ledger location_id backfill -------------------- *
 *
 * Every existing stock_ledger row was left with location_id = NULL by the
 * migration in server.js (see the stock_ledger ALTER TABLE comment there).
 * This script assigns a real location to each historical row based on its
 * voucher_type, so reports don't show a mix of located and un-located
 * stock once Step 8 (location-aware Item Wise Report) lands.
 *
 * Assignment rule (a starting point, not a final answer — goods that
 * physically moved location after the fact, e.g. RM issued to production,
 * aren't visible from voucher_type alone and won't be modeled correctly
 * until Work Orders exist in Phase 4):
 *
 *   OPENING, GRN, PURCHASE   → RM Store   (stock entering from outside,
 *                                          pre-production)
 *   SALE, DC                → FG Store   (stock leaving to a customer)
 *   DEBIT NOTE               → RM Store   (stock returned OUT to a
 *                                          supplier — reverses a GRN/
 *                                          PURCHASE, so same location)
 *   CREDIT NOTE               → FG Store   (stock returned IN from a
 *                                          customer — reverses a SALE/DC,
 *                                          so same location)
 *   anything else            → flagged UNRECOGNIZED, left untouched. This
 *                              only happens if voucher_type contains a
 *                              value not covered above (e.g. new voucher
 *                              types added after this script was written) —
 *                              needs a human decision, not a guess.
 *
 * SAFE BY DEFAULT: running this script with no arguments only PRINTS a
 * report — it makes no database changes. Nothing is written unless you
 * pass --apply. Only rows where location_id IS NULL are ever touched, so
 * it's safe to re-run after Step 4 starts populating location_id on new
 * transactions going forward.
 *
 * Usage:
 *   node scripts/backfill-stock-location.js            # dry run, prints report
 *   node scripts/backfill-stock-location.js --apply     # actually updates rows
 *
 * Respects DATA_DIR the same way server.js does, so it points at the same
 * accounts.db whether you're running locally or against a Railway volume.
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "accounts.db");
const APPLY = process.argv.includes("--apply");

// voucher_type → location_name this script will assign it to.
const VOUCHER_TYPE_TO_LOCATION = {
  OPENING: "RM Store",
  GRN: "RM Store",
  PURCHASE: "RM Store",
  "DEBIT NOTE": "RM Store",
  SALE: "FG Store",
  DC: "FG Store",
  "CREDIT NOTE": "FG Store",
};

const db = new sqlite3.Database(DB_PATH);

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}

async function main() {
  console.log(`Using DB: ${DB_PATH}`);
  console.log(APPLY ? "Mode: APPLY (will write changes)\n" : "Mode: DRY RUN (no changes will be made)\n");

  // Resolve the location rows this script needs (they were seeded by the
  // Step 1/2 migration in server.js — RM Store and FG Store are guaranteed
  // to exist as long as that migration has run at least once).
  const locations = await all(
    `SELECT id, location_name FROM locations WHERE location_name IN (?, ?)`,
    ["RM Store", "FG Store"]
  );
  const locationIdByName = {};
  for (const loc of locations) locationIdByName[loc.location_name] = loc.id;

  for (const name of ["RM Store", "FG Store"]) {
    if (!locationIdByName[name]) {
      console.error(
        `ERROR: location "${name}" not found in the locations table. ` +
        `Run the server once (server.js) to apply the Step 1/2 migration ` +
        `and seed default locations before running this backfill.`
      );
      db.close();
      process.exit(1);
    }
  }

  const rows = await all(
    `SELECT id, voucher_type, voucher_no, item_id, date
     FROM stock_ledger
     WHERE location_id IS NULL
     ORDER BY id`
  );

  const buckets = {}; // voucher_type (or UNRECOGNIZED) → rows
  for (const row of rows) {
    const key = VOUCHER_TYPE_TO_LOCATION[row.voucher_type] ? row.voucher_type : "UNRECOGNIZED";
    (buckets[key] = buckets[key] || []).push(row);
  }

  const recognizedTypes = Object.keys(VOUCHER_TYPE_TO_LOCATION);
  for (const type of recognizedTypes) {
    const list = buckets[type] || [];
    const targetLocation = VOUCHER_TYPE_TO_LOCATION[type];
    console.log(`\n${type} → ${targetLocation} (${list.length} row(s))`);
    console.log("-".repeat(40));
    for (const row of list.slice(0, 10)) {
      console.log(`  stock_ledger#${row.id}  item#${row.item_id}  voucher_no=${row.voucher_no}  date=${row.date}`);
    }
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
  }

  const unrecognized = buckets.UNRECOGNIZED || [];
  console.log(`\nUNRECOGNIZED voucher_type (${unrecognized.length} row(s)) — left untouched`);
  console.log("-".repeat(40));
  for (const row of unrecognized.slice(0, 10)) {
    console.log(`  stock_ledger#${row.id}  voucher_type="${row.voucher_type}"  voucher_no=${row.voucher_no}  date=${row.date}`);
  }
  if (unrecognized.length > 10) console.log(`  ... and ${unrecognized.length - 10} more`);

  if (!APPLY) {
    console.log(
      "\nDry run complete. No changes made. Review the lists above, " +
      "then re-run with --apply to write location_id for all recognized " +
      "voucher types. UNRECOGNIZED rows are never auto-applied — extend " +
      "VOUCHER_TYPE_TO_LOCATION in this script and re-run once you know " +
      "which location they belong to."
    );
    db.close();
    return;
  }

  let updated = 0;
  for (const type of recognizedTypes) {
    const list = buckets[type] || [];
    if (!list.length) continue;
    const locationId = locationIdByName[VOUCHER_TYPE_TO_LOCATION[type]];
    const result = await run(
      `UPDATE stock_ledger SET location_id = ? WHERE location_id IS NULL AND voucher_type = ?`,
      [locationId, type]
    );
    updated += result.changes;
  }

  console.log(`\nApplied. ${updated} row(s) updated.`);
  console.log(
    `${unrecognized.length} row(s) left with location_id = NULL (UNRECOGNIZED voucher_type) — ` +
    `handle those manually or extend this script and re-run.`
  );
  db.close();
}

main().catch(err => {
  console.error("Backfill failed:", err.message);
  db.close();
  process.exit(1);
});
