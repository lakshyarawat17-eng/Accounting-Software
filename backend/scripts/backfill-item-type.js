/* -------------------- Phase 1, Step 3: item_type backfill -------------------- *
 *
 * Every existing item_master row was defaulted to FINISHED_GOOD by the
 * migration in server.js (see the item_type ALTER TABLE comment there).
 * That's a safe blanket default, not a real classification. This script
 * looks at how each item has ACTUALLY been used — bought, sold, or both —
 * and proposes a real item_type based on that history.
 *
 * Classification rule (deliberately simple — this is a starting point for
 * manual review, not a final answer):
 *   - Appears in purchase_invoice_items / purchase_order_items ONLY
 *       → RAW_MATERIAL
 *   - Appears in sales_invoice_items / sales_order_items ONLY
 *       → FINISHED_GOOD (i.e. leave as-is)
 *   - Appears in BOTH (bought and sold)
 *       → flagged REVIEW, left untouched. Common causes: a traded item
 *         (bought and resold as-is), a raw material occasionally sold as
 *         surplus, or a finished good that's also a component in another
 *         product's BOM. This needs a human decision, not a guess.
 *   - Appears in NEITHER (never transacted — e.g. brand new item)
 *       → flagged NEW, left untouched.
 *
 * SAFE BY DEFAULT: running this script with no arguments only PRINTS a
 * report — it makes no database changes. Nothing is written unless you
 * pass --apply.
 *
 * Usage:
 *   node scripts/backfill-item-type.js            # dry run, prints report
 *   node scripts/backfill-item-type.js --apply     # actually updates rows
 *
 * Respects DATA_DIR the same way server.js does, so it points at the same
 * accounts.db whether you're running locally or against a Railway volume.
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "accounts.db");
const APPLY = process.argv.includes("--apply");

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

  const items = await all(
    `SELECT id, item_code, item_name, item_type FROM item_master ORDER BY item_name`
  );

  const purchasedIds = new Set(
    (
      await all(`
        SELECT DISTINCT item_id FROM purchase_invoice_items WHERE item_id IS NOT NULL
        UNION
        SELECT DISTINCT item_id FROM purchase_order_items WHERE item_id IS NOT NULL
      `)
    ).map(r => r.item_id)
  );

  const soldIds = new Set(
    (
      await all(`
        SELECT DISTINCT item_id FROM sales_invoice_items WHERE item_id IS NOT NULL
        UNION
        SELECT DISTINCT item_id FROM sales_order_items WHERE item_id IS NOT NULL
      `)
    ).map(r => r.item_id)
  );

  const results = { RAW_MATERIAL: [], FINISHED_GOOD: [], REVIEW: [], NEW: [] };

  for (const item of items) {
    const bought = purchasedIds.has(item.id);
    const sold = soldIds.has(item.id);

    let bucket;
    if (bought && !sold) bucket = "RAW_MATERIAL";
    else if (sold && !bought) bucket = "FINISHED_GOOD";
    else if (bought && sold) bucket = "REVIEW";
    else bucket = "NEW";

    results[bucket].push(item);
  }

  for (const bucket of ["RAW_MATERIAL", "FINISHED_GOOD", "REVIEW", "NEW"]) {
    const list = results[bucket];
    console.log(`\n${bucket} (${list.length})`);
    console.log("-".repeat(40));
    for (const item of list) {
      const changed = bucket !== "REVIEW" && bucket !== "NEW" && item.item_type !== bucket;
      const marker = changed ? "  [WILL CHANGE]" : "";
      console.log(
        `  #${item.id} ${item.item_code || "(no code)"} — ${item.item_name} ` +
        `[currently: ${item.item_type}]${marker}`
      );
    }
  }

  if (!APPLY) {
    console.log(
      "\nDry run complete. No changes made. Review the lists above, " +
      "then re-run with --apply to write RAW_MATERIAL/FINISHED_GOOD updates.\n" +
      "REVIEW and NEW items are never auto-applied — reclassify those by hand " +
      "via PUT /item/:id once step 6 wires that up."
    );
    db.close();
    return;
  }

  let updated = 0;
  for (const bucket of ["RAW_MATERIAL", "FINISHED_GOOD"]) {
    for (const item of results[bucket]) {
      if (item.item_type !== bucket) {
        await run(`UPDATE item_master SET item_type = ? WHERE id = ?`, [bucket, item.id]);
        updated++;
      }
    }
  }

  console.log(`\nApplied. ${updated} item(s) updated.`);
  console.log(
    `${results.REVIEW.length} item(s) left as REVIEW and ` +
    `${results.NEW.length} item(s) left as NEW — reclassify those manually.`
  );
  db.close();
}

main().catch(err => {
  console.error("Backfill failed:", err.message);
  db.close();
  process.exit(1);
});
