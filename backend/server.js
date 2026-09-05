console.log("🔥 SERVER.JS FILE LOADED 🔥", __filename);
const PDFDocument = require("pdfkit");
const fs = require("fs");

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();

/* -------------------- CORS -------------------- */
// Set FRONTEND_URL in Railway to your Vercel URL (comma-separate multiple origins).
// Falls back to allowing all origins if not set, so it still works out of the box.
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length
    ? function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS: " + origin));
      }
    : true,
}));

app.use(express.json());

/* -------------------- VOUCHER CHRONOLOGY FUNCTION -------------------- */

function getNextVoucherNo(callback) {
  db.get(
    `SELECT voucher_no FROM journal_voucher
     ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return callback(err);

      if (!row) return callback(null, "JV/0001");

      const lastNo = row.voucher_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      callback(null, `JV/${nextNo}`);
    }
  );
}

/* -------------------- PAYMENT / RECEIPT VOUCHER NUMBERING -------------------- */
// Separate series per type: PAY/0001, PAY/0002... and REC/0001, REC/0002...
function getNextPaymentVoucherNo(type, callback) {
  const prefix = type === "RECEIPT" ? "REC" : "PAY";
  db.get(
    `SELECT voucher_no FROM payment_voucher WHERE type = ? ORDER BY id DESC LIMIT 1`,
    [type],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(null, `${prefix}/0001`);
      const lastNo = row.voucher_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");
      callback(null, `${prefix}/${nextNo}`);
    }
  );
}

/* -------------------- STOCK CHECK FUNCTION -------------------- */

function getAvailableStock(itemId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
      FROM stock_ledger
      WHERE item_id = ?
      `,
      [itemId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.available ?? 0);
      }
    );
  });
}

/* Same as getAvailableStock, but scoped to one location — used by Stock
   Transfer (Step 7) to check "is there enough of this item at the FROM
   location" rather than the item's total across every location. This is
   deliberately narrow (one lookup, one caller) rather than a general
   location-aware stock report; that's Step 8's Item Wise Report work. */
function getAvailableStockAtLocation(itemId, locationId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
      FROM stock_ledger
      WHERE item_id = ? AND location_id = ?
      `,
      [itemId, locationId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.available ?? 0);
      }
    );
  });
}

/* Same as getAvailableStockAtLocation, but additionally scoped to one
   batch_no — the lookup batch-aware issue validation (Step 5), FEFO
   consumption (Step 7), and batch reporting (Step 9) all reuse, mirroring
   how getAvailableStockAtLocation itself became the shared primitive for
   Stock Transfer/WO issue once locations landed. Rows with a NULL batch_no
   (pre-batch-tracking stock, or items that never carry a batch) are matched
   by passing batchNo = null, since `location_id = NULL` never matches in
   SQL and needs the same IS NULL handling location_id itself doesn't need
   here (batchNo is expected to always be a real value or explicit null,
   never omitted). */
function getAvailableStockAtBatchLocation(itemId, locationId, batchNo) {
  return new Promise((resolve, reject) => {
    const batchClause = batchNo === null || batchNo === undefined
      ? "batch_no IS NULL"
      : "batch_no = ?";
    const params = batchNo === null || batchNo === undefined
      ? [itemId, locationId]
      : [itemId, locationId, batchNo];
    db.get(
      `
      SELECT
        IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
      FROM stock_ledger
      WHERE item_id = ? AND location_id = ? AND ${batchClause}
      `,
      params,
      (err, row) => {
        if (err) return reject(err);
        resolve(row?.available ?? 0);
      }
    );
  });
}

/* -------------------- LOCATION RESOLUTION (Phase 2, Step 4) --------------------
   Every stock_ledger INSERT point now takes a location_id, but the frontend
   screens that let a user actually pick one aren't wired up until Step 9
   (GRN "receive into" / DC "issue from" dropdowns). Until then — and for
   any caller that simply omits it — this resolves a sensible default by
   name, so location_id is populated going forward instead of landing back
   in the NULL state the Step 3 backfill just cleaned up.

   Looked up fresh per call (a single indexed SELECT on a tiny table) rather
   than cached, so renaming a location in the new Locations screen (Step 6)
   takes effect immediately without a server restart. If providedId is
   already given (truthy), it's trusted as-is and no lookup happens. */
function resolveLocationId(providedId, defaultLocationName) {
  return new Promise((resolve, reject) => {
    if (providedId) return resolve(providedId);
    db.get(
      `SELECT id FROM locations WHERE location_name = ?`,
      [defaultLocationName],
      (err, row) => {
        if (err) return reject(err);
        // Falls back to NULL (not an error) if even the seed location is
        // missing — e.g. a user renamed/deleted it before Step 6 added a
        // real deactivate flow. Matches the "nullable for now" stance the
        // Step 2 migration already committed to, rather than blocking an
        // entire invoice/GRN/DC save over a missing lookup row.
        resolve(row ? row.id : null);
      }
    );
  });
}



/* -------------------- BOM VERSIONING (Phase 3, Step 2) --------------------
   A BOM is never edited in place once it has a version past DRAFT — see the
   bom table comment (Step 1) for why. These two helpers are the mechanics
   everything else (the CRUD API in Step 3, the cost rollup in Step 5) is
   built on:

     resolveActiveBOM      — "what's the current BOM for this FG item?"
     cloneBOMToNewVersion  — "start a new editable draft from it"

   Both are looked up fresh per call rather than cached, same stance as
   resolveLocationId above — a BOM being activated/superseded should take
   effect immediately, not after a restart. */

/* Returns the row from `bom` that is currently ACTIVE for a given FG item,
   or null if that FG has no active BOM yet (still all DRAFT, or no BOM at
   all). This is the single source of truth for "what does it currently
   cost to make one of these" — Step 5's cost rollup and Step 3's
   /bom/:fgItemId/new-version endpoint both resolve through this rather
   than each running their own query, so "current BOM" means the same
   thing everywhere.

   Assumes at most one ACTIVE row per fg_item_id, which is an API-layer
   invariant (enforced by the /bom/:id/activate transaction in Step 3), not
   a DB constraint — LIMIT 1 here is a safety net, not the enforcement
   mechanism, so if that invariant is ever violated this silently picks one
   row rather than surfacing the data-integrity problem loudly. */
function resolveActiveBOM(fgItemId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM bom WHERE fg_item_id = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`,
      [fgItemId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

/* Starts a new editable version of an FG's BOM by cloning its component
   lines forward. Source version is whichever is ACTIVE for that FG; if
   none is ACTIVE yet (e.g. the FG only has a DRAFT sitting unactivated,
   or no BOM at all), this cannot clone anything meaningful and rejects —
   callers (Step 3's /bom/:fgItemId/new-version) should surface that as
   "create the first version instead" rather than a generic 500.

   Deliberately does NOT touch the source row's status — the previous
   ACTIVE version stays ACTIVE (and therefore still the one Step 5's cost
   rollup uses) until the new DRAFT this creates is itself activated. Two
   BOM rows are allowed to exist for the same FG at once (one ACTIVE, one
   DRAFT-in-progress); it's only two ACTIVE rows at once that's invalid.

   Runs as its own transaction (BEGIN/COMMIT/ROLLBACK) since it's a
   multi-statement write (new bom row + N cloned bom_items rows) that must
   land atomically, same shape as the GRN/Stock Transfer handlers — a
   caller invoking this doesn't need to wrap it in another transaction. */
function cloneBOMToNewVersion(fgItemId) {
  return new Promise((resolve, reject) => {
    (async () => {
      // Tracks whether BEGIN TRANSACTION actually ran, so the catch block
      // below only issues ROLLBACK when there's a transaction open to roll
      // back — the "no active BOM" validation error above is thrown before
      // BEGIN, and calling ROLLBACK with nothing open raises its own
      // unhandled statement error instead of surfacing the real one.
      let transactionStarted = false;
      try {
        const sourceBOM = await resolveActiveBOM(fgItemId);
        if (!sourceBOM) {
          throw new Error(
            "This item has no active BOM to create a new version from. Create the first version instead."
          );
        }

        const sourceItems = await new Promise((res, rej) => {
          db.all(
            `SELECT component_item_id, qty_per_unit, unit, narration FROM bom_items WHERE bom_id = ?`,
            [sourceBOM.id],
            (err, rows) => (err ? rej(err) : res(rows))
          );
        });

        db.run("BEGIN TRANSACTION");
        transactionStarted = true;

        const newVersion = sourceBOM.version + 1;
        const newBomId = await new Promise((res, rej) => {
          db.run(
            `
            INSERT INTO bom (bom_no, fg_item_id, version, status, effective_date, narration)
            VALUES (?, ?, ?, 'DRAFT', NULL, ?)
            `,
            [sourceBOM.bom_no, fgItemId, newVersion, sourceBOM.narration || null],
            function (err) {
              if (err) return rej(err);
              res(this.lastID);
            }
          );
        });

        for (const item of sourceItems) {
          await new Promise((res, rej) => {
            db.run(
              `
              INSERT INTO bom_items (bom_id, component_item_id, qty_per_unit, unit, narration)
              VALUES (?, ?, ?, ?, ?)
              `,
              [newBomId, item.component_item_id, item.qty_per_unit, item.unit, item.narration],
              err => (err ? rej(err) : res())
            );
          });
        }

        db.run("COMMIT");
        resolve({ id: newBomId, bom_no: sourceBOM.bom_no, version: newVersion });
      } catch (err) {
        if (transactionStarted) db.run("ROLLBACK");
        reject(err);
      }
    })();
  });
}

/* Explodes an FG's ACTIVE BOM for a given target quantity — resolves the
   BOM (via resolveActiveBOM), pulls its bom_items lines, and returns each
   one with required_qty = qty_per_unit × targetQty alongside the raw
   qty_per_unit/unit/component_item_id. This is the read-only "what would
   it take to build N of these" computation; Step 3's /work-order/create
   is what turns this into the frozen work_order_components snapshot rows
   — this helper itself never writes anything.

   Rejects the same way cloneBOMToNewVersion does when resolveActiveBOM
   comes back null ("no active BOM to build this from"), so callers get a
   consistent message whether they're starting a new BOM version or a new
   work order against a component-less FG. Also returns the resolved BOM
   row itself (not just the exploded lines) since Step 3's caller needs
   bom_id/bom_version for the work_order header alongside the lines. */
function explodeBOMForQuantity(fgItemId, targetQty) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const bomRow = await resolveActiveBOM(fgItemId);
        if (!bomRow) {
          throw new Error(
            "This item has no active BOM to build this from."
          );
        }

        const bomItems = await new Promise((res, rej) => {
          db.all(
            `SELECT component_item_id, qty_per_unit, unit, narration FROM bom_items WHERE bom_id = ?`,
            [bomRow.id],
            (err, rows) => (err ? rej(err) : res(rows))
          );
        });

        const lines = bomItems.map(item => ({
          component_item_id: item.component_item_id,
          qty_per_unit: item.qty_per_unit,
          unit: item.unit,
          narration: item.narration,
          required_qty: item.qty_per_unit * targetQty,
        }));

        resolve({ bom: bomRow, lines });
      } catch (err) {
        reject(err);
      }
    })();
  });
}

/* Resolves "what does this component currently cost, per unit" — the
   pricing half of the cost rollup (Step 5 sums qty_per_unit × this across
   a BOM's lines). Looks at stock_ledger for the most recent GRN/receipt
   with stock actually coming in (qty_in > 0) for that item, most recent by
   date then id (id as the tiebreaker for same-day receipts, so it's
   deterministic rather than picking whichever row SQLite happens to
   return first). If the item has never been received — no purchase
   history yet, e.g. a component that's only ever been in an opening
   balance, or a brand new item_master row — this falls back to
   item_master.opening_rate, same "fall back to a known default rather
   than error out" shape as resolveLocationId's default-location lookup
   above.

   Deliberately looked up fresh per call, not cached — same "never cache,
   look up fresh" stance as resolveLocationId and resolveActiveBOM, since a
   rate that changed on the last GRN should be reflected the very next time
   a cost rollup runs, not after a restart.

   Returns a plain number (0 if even opening_rate is unset/null, so callers
   summing rates never have to guard against undefined/NaN), or rejects if
   the item itself doesn't exist. Doesn't distinguish "priced at 0 because
   that's genuinely the opening rate" from "priced at 0 because there's no
   data at all" — a rollup built on this should treat an all-zero
   component as a sign to check the item's purchase history, not as a
   reliable free-material cost. */
function getCurrentComponentRate(itemId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT rate FROM stock_ledger
      WHERE item_id = ? AND qty_in > 0 AND rate IS NOT NULL
      ORDER BY date DESC, id DESC
      LIMIT 1
      `,
      [itemId],
      (err, ledgerRow) => {
        if (err) return reject(err);
        if (ledgerRow) return resolve(ledgerRow.rate);

        // No receipt history — fall back to the item's opening rate.
        db.get(
          `SELECT opening_rate FROM item_master WHERE id = ?`,
          [itemId],
          (err2, itemRow) => {
            if (err2) return reject(err2);
            if (!itemRow) return reject(new Error(`Item ${itemId} not found`));
            resolve(itemRow.opening_rate || 0);
          }
        );
      }
    );
  });
}

/* Shared cost-rollup logic behind both GET /bom/:id/cost and its
   by-fg-item wrapper (Step 5) — prices every line of a BOM at its
   CURRENT component rate and sums them into a total cost per FG unit.
   Always calls getCurrentComponentRate() at request time rather than
   reading a stored rate off bom_items (there isn't one — see the
   bom_items table comment, Step 1), so this is a live standard-costing
   view: run it twice on different days and you can get two different
   totals if a component's rate moved in between, which is the point.

   Kept as its own function (not inlined into the route handler) so the
   by-fg-item wrapper can call it directly once it's resolved which bom_id
   is "active" for that FG, instead of re-deriving the cost logic or
   making the wrapper route call the other route over HTTP. */
function computeBOMCost(bomId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT b.*, im.item_name AS fg_item_name, im.unit AS fg_unit
      FROM bom b
      JOIN item_master im ON im.id = b.fg_item_id
      WHERE b.id = ?
      `,
      [bomId],
      (err, bomRow) => {
        if (err) return reject(err);
        if (!bomRow) return reject(new Error("BOM not found"));

        db.all(
          `
          SELECT bi.*, im.item_name AS component_item_name, im.unit AS component_unit
          FROM bom_items bi
          JOIN item_master im ON im.id = bi.component_item_id
          WHERE bi.bom_id = ?
          ORDER BY bi.id
          `,
          [bomId],
          async (err2, items) => {
            if (err2) return reject(err2);

            try {
              let totalCostPerUnit = 0;
              const components = [];

              // Sequential, not Promise.all — keeps this readable as a
              // straightforward "price each line, running total" loop,
              // and a BOM's component count is small enough (tens of
              // lines, not thousands) that this isn't a real perf concern.
              for (const item of items) {
                const currentRate = await getCurrentComponentRate(item.component_item_id);
                const lineCost = item.qty_per_unit * currentRate;
                totalCostPerUnit += lineCost;

                components.push({
                  component_item_id: item.component_item_id,
                  component_item_name: item.component_item_name,
                  qty_per_unit: item.qty_per_unit,
                  unit: item.unit || item.component_unit,
                  current_rate: currentRate,
                  line_cost: lineCost
                });
              }

              resolve({
                bom_id: bomRow.id,
                bom_no: bomRow.bom_no,
                fg_item_id: bomRow.fg_item_id,
                fg_item_name: bomRow.fg_item_name,
                fg_unit: bomRow.fg_unit,
                version: bomRow.version,
                status: bomRow.status,
                components,
                total_cost_per_unit: totalCostPerUnit
              });
            } catch (rateErr) {
              reject(rateErr);
            }
          }
        );
      }
    );
  });
}

/* -------------------- GET-OR-CREATE ITEM (used by PO / GRN / Purchase) -------------------- */

function getOrCreateItem(itemName, gstRate, rate) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM item_master WHERE item_name = ?`,
      [itemName],
      (err, row) => {
        if (err) return reject(err);
        if (row) return resolve(row.id);

        db.run(
          `
          INSERT INTO item_master
          (item_name, unit, gst_rate, selling_price)
          VALUES (?, 'Nos', ?, ?)
          `,
          [itemName, Number(gstRate) || 0, rate],
          function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
          }
        );
      }
    );
  });
}

/* -------------------- SAVE JOURNAL FUNCTION -------------------- */

function saveJournalInternal({ date, narration, entries }) {
  return new Promise((resolve, reject) => {
    if (!entries || !entries.length) {
      return reject(new Error("No journal entries"));
    }

    const ledgersUsed = entries.map(e => e.particulars).filter(Boolean);
    const placeholders = ledgersUsed.map(() => "?").join(",");

    db.all(
      `SELECT ledger FROM ledger_master WHERE ledger IN (${placeholders})`,
      ledgersUsed,
      (err, rows) => {
        if (err) return reject(err);

        const validLedgers = rows.map(r => r.ledger);
        const invalid = ledgersUsed.filter(l => !validLedgers.includes(l));

        if (invalid.length) {
          return reject(
            new Error(`Invalid ledger(s): ${invalid.join(", ")}`)
          );
        }

        getNextVoucherNo((err, voucherNo) => {
          if (err) return reject(err);

          db.run(
            `INSERT INTO journal_voucher (date, voucher_no, narration)
             VALUES (?, ?, ?)`,
            [date, voucherNo, narration],
            function (err) {
              if (err) return reject(err);

              const voucherId = this.lastID;

              const je = db.prepare(`
                INSERT INTO journal_entries
                (voucher_id, ledger, lf, debit, credit)
                VALUES (?, ?, ?, ?, ?)
              `);

              const le = db.prepare(`
                INSERT INTO ledger_entries
                (ledger, date, voucher_no, narration, debit, credit)
                VALUES (?, ?, ?, ?, ?, ?)
              `);

              for (const e of entries) {
                const d = Number(e.debit) || 0;
                const c = Number(e.credit) || 0;

                je.run(voucherId, e.particulars, voucherNo, d, c);
                le.run(e.particulars, date, voucherNo, narration, d, c);
              }

              je.finalize();
              le.finalize();

              resolve(voucherNo);
            }
          );
        });
      }
    );
  });
}

/* -------------------- SETTINGS (KEY/VALUE) -------------------- */

// The list of PDF templates the sales invoice can be generated with.
// Add new entries here as new template renderers are implemented below.
const INVOICE_TEMPLATES = [
  {
    id: "classic",
    name: "Classic",
    description: "Simple black & white layout with a bordered items table. The original default template."
  },
  {
    id: "modern",
    name: "Modern",
    description: "Bold colored header band, cleaner typography, totals highlighted in a shaded box."
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Compact, ruled-line layout with no boxes — light ink usage, good for quick printing."
  },
  {
    id: "gst_tabular",
    name: "GST Tax Invoice (Tally-style)",
    description: "Fully boxed, grid-style tax invoice matching the classic Tally/e-Invoice layout, with an HSN-wise tax summary, amount-in-words, and the seller/buyer GSTIN & address. Fields our system doesn't capture yet (delivery note, dispatch details) are left blank."
  }
];

function getSetting(key, defaultValue) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : defaultValue);
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, String(value)],
      err => (err ? reject(err) : resolve())
    );
  });
}

/* -------------------- GSTIN VALIDATION & STATE CODES --------------------
   A GSTIN is 15 characters: 2-digit state code + 10-char PAN (5 letters,
   4 digits, 1 letter) + 1 entity/registration number (1-9 or A-Z) +
   the literal 'Z' + 1 checksum character (alphanumeric). We validate the
   format (not the checksum algorithm itself) and use the state code to
   auto-determine CGST+SGST vs IGST instead of trusting a manually picked
   dropdown. */
const GST_STATE_CODES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
  "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
  "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman & Diu", "26": "Dadra & Nagar Haveli",
  "27": "Maharashtra", "28": "Andhra Pradesh (Old)", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction"
};

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function normalizeGstin(gstin) {
  return String(gstin || "").trim().toUpperCase();
}

function isValidGstin(gstin) {
  if (!gstin) return false;
  return GSTIN_REGEX.test(normalizeGstin(gstin));
}

// Returns { code, name } from a valid GSTIN's first 2 digits, or null if
// the GSTIN is missing/invalid/an unrecognised state code.
function getGstStateFromGstin(gstin) {
  if (!isValidGstin(gstin)) return null;
  const code = normalizeGstin(gstin).slice(0, 2);
  return GST_STATE_CODES[code] ? { code, name: GST_STATE_CODES[code] } : null;
}

/* -------------------- HSN/SAC VALIDATION --------------------
   Per CBIC Notification 78/2020 (originally in force since 01-Apr-2021),
   the number of HSN digits a taxpayer must declare depends on prior
   financial year turnover (Aggregate Annual Turnover / AATO):
     - AATO > Rs 5 crore   -> 6-digit HSN minimum
     - AATO <= Rs 5 crore  -> 4-digit HSN minimum
   The older intermediate "Rs 1.5cr - 5cr" slab and the "below Rs 1.5cr
   HSN is optional" slab were both retired — GSTN's Phase-3 rollout of
   GSTR-1 Table 12 (effective the May-2025 return period) collapsed this
   to just the two tiers above, and CBIC clarified on 10-Jun-2025 that
   HSN reporting is mandatory on every B2B supply with NO turnover
   exemption at all — only B2C supplies from a taxpayer with AATO up to
   Rs 5 crore may still omit it (Notification 12/2017-CT, as amended).

   Because a single item in this system can be sold to both a B2B and a
   B2C customer, and we validate HSN at the item-master level (not
   per-invoice, where we'd actually know if the buyer is registered), we
   can't safely treat HSN as "optional" for any turnover slab any more —
   doing so would let a low-turnover business save an item without HSN
   and then legally fail to report it the moment that item is sold B2B.
   So HSN is now always required at item-master level; only the required
   *digit length* varies with turnover. (If you want true item-level
   optionality for B2C-only sellers under Rs 5cr, that needs a per-sale
   B2B/B2C check at invoice time, not at item-master time.)

   HSN/SAC codes are always purely numeric with length 4, 6, or 8
   (services use SAC, which is also numeric and conventionally 6 digits
   under Chapter 99). */
const HSN_REGEX = /^\d{4}$|^\d{6}$|^\d{8}$/;

function isValidHsnFormat(hsn) {
  return HSN_REGEX.test(String(hsn || "").trim());
}

// Minimum HSN digit length mandated for this business's turnover slab.
// Always >= 4 — HSN reporting has no turnover-based exemption any more
// (see comment block above), so this never returns 0.
function requiredHsnDigits(annualTurnover) {
  const t = Number(annualTurnover) || 0;
  return t > 50000000 ? 6 : 4;   // > Rs 5 crore -> 6 digits, else -> 4 digits
}

// Validates an HSN against the business's turnover-driven requirement.
// Returns { ok: true } or { ok: false, error: "..." }.
function validateHsnForTurnover(hsn, annualTurnover) {
  const minDigits = requiredHsnDigits(annualTurnover);
  const trimmed = String(hsn || "").trim();

  if (!trimmed) {
    return {
      ok: false,
      error: `HSN/SAC code is required (a minimum ${minDigits}-digit HSN is mandatory for your declared turnover slab, per CBIC Notification 78/2020 and the May-2025 GSTR-1 Table 12 rules).`
    };
  }

  if (!isValidHsnFormat(trimmed)) {
    return { ok: false, error: "HSN/SAC must be a numeric code of 4, 6, or 8 digits (e.g. 8471, 847130, 84713010)." };
  }

  if (trimmed.length < minDigits) {
    return {
      ok: false,
      error: `HSN/SAC must be at least ${minDigits} digits for your declared turnover slab (got ${trimmed.length} digits: "${trimmed}").`
    };
  }

  return { ok: true };
}

// Standard GST Unit Quantity Codes (UQC) as published by CBIC. Free-text
// units ("pcs", "each", etc.) get silently rejected/flagged during GSTR-1
// filing, so item creation/update is restricted to this list.
const UQC_CODES = [
  "BAGS", "BALE", "BDL", "BGS", "BOU", "BOX", "BTL", "BUN", "CAN", "CBM",
  "CCM", "CMS", "CTN", "DOZ", "DRM", "GGR", "GMS", "GRS", "GYD", "KGS",
  "KLR", "KME", "MLT", "MTR", "MTS", "NOS", "PAC", "PCS", "PRS", "QTL",
  "ROL", "SET", "SQF", "SQM", "SQY", "TBS", "TGM", "THD", "TON", "TUB",
  "UGS", "UNT", "YDS", "OTH"
];

function isValidUqc(unit) {
  return UQC_CODES.includes(String(unit || "").trim().toUpperCase());
}

/* -------------------- GST SUPPLY TYPE (Exempt / Nil-Rated / Zero-Rated) --------------------
   TAXABLE   — normal rated supply, tax charged at the item's gst_rate. Default.
   EXEMPT    — exempt supply under a notification (GSTR-1 Table 8). Always 0% —
               the item's gst_rate is forced to 0 so a stale non-zero rate can
               never leak into a downstream calculation.
   NIL_RATED — nil-rated goods/services (also Table 8). Same 0% forcing as EXEMPT.
   ZERO_RATED — export/SEZ supply under LUT, GSTR-1 Table 6A. Unlike the other
               two, the item itself keeps its normal domestic gst_rate (e.g. an
               item sold at 18% domestically most of the time) — it's only the
               specific invoice LINE that gets billed at 0% when marked
               ZERO_RATED (see Step 3), so gst_rate is left untouched here. */
const VALID_SUPPLY_TYPES = ["TAXABLE", "EXEMPT", "NIL_RATED", "ZERO_RATED"];

function normalizeSupplyType(value) {
  const v = String(value || "TAXABLE").trim().toUpperCase();
  return VALID_SUPPLY_TYPES.includes(v) ? v : null;
}

// Buckets a line's supply_type into the three GSTR-1-shaped groups the
// reports (gst-summary, hsn-summary) keep apart: ordinary taxable supplies
// (the existing B2B/B2C summary), EXEMPT/NIL_RATED supplies (Table 8
// style), and ZERO_RATED exports/SEZ-under-LUT supplies (Table 6A style).
// Falls back to TAXABLE for anything unrecognized, same as normalizeSupplyType.
function supplyCategory(supplyType) {
  const v = normalizeSupplyType(supplyType) || "TAXABLE";
  if (v === "ZERO_RATED") return "zero_rated";
  if (v === "EXEMPT" || v === "NIL_RATED") return "exempt_nil";
  return "taxable";
}

/* purchase_invoice_items.itc_category / itc_eligible / rcm_applicable —
   see the ALTER TABLE comments above (search "itc_category:") for what each
   value means and which GSTR-3B table row it feeds. Same normalize-with-
   fallback pattern as normalizeSupplyType: a missing/unrecognized value
   falls back to the safe default, but a value that was SENT and doesn't
   match anything valid is rejected outright by the caller rather than
   silently coerced, same as normalizeSupplyType. */
const VALID_ITC_CATEGORIES = ["OTHER", "IMPORT_GOODS", "IMPORT_SERVICES", "RCM", "ISD"];

/* -------------------- ITEM TYPE (manufacturing readiness, Phase 1) --------------------
   item_master.item_type classifies WHAT ROLE an item plays in the business,
   independent of its GST supply_type above:
   RAW_MATERIAL   — purchased input, consumed in production. Never sold directly
                    in the common case, but not forbidden (e.g. selling surplus RM).
   WIP            — semi-finished/in-process item. Only exists as a BOM
                    component or a Work Order output in later phases; not
                    normally purchased or sold on its own.
   FINISHED_GOOD  — the sellable end product. Default for anything with no
                    stronger signal, since that matches this app's original
                    (pre-manufacturing) usage as a trading item.
   CONSUMABLE     — used up in production/operations but not part of the
                    BOM output itself (lubricants, packing material, etc).
   SCRAP          — waste/rejected output, usually near-zero value, tracked
                    separately so it doesn't distort finished-goods costing.
   Stored as plain TEXT rather than a CHECK constraint, same reasoning as
   supply_type above (ALTER TABLE + CHECK is version-fragile in SQLite);
   validity is enforced in the API layer via normalizeItemType(). */
const VALID_ITEM_TYPES = ["RAW_MATERIAL", "WIP", "FINISHED_GOOD", "CONSUMABLE", "SCRAP"];

function normalizeItemType(value) {
  const v = String(value || "FINISHED_GOOD").trim().toUpperCase();
  return VALID_ITEM_TYPES.includes(v) ? v : null;
}

/* -------------------- FIXED ASSET DEPRECIATION METHOD (FAM Step 4) --------------------
   Same normalize-with-fallback / reject-if-sent-but-invalid pattern as
   normalizeSupplyType and normalizeItemType above. SLM (Straight Line
   Method) is the default for both categories and individual assets. */
const VALID_DEPRECIATION_METHODS = ["SLM", "WDV"];

function normalizeDepreciationMethod(value) {
  const v = String(value || "SLM").trim().toUpperCase();
  return VALID_DEPRECIATION_METHODS.includes(v) ? v : null;
}

const VALID_ASSET_STATUSES = ["ACTIVE", "DISPOSED", "WRITTEN_OFF"];

/* -------------------- FIXED ASSET CAPITALIZATION MODE (FAM Step 5) --------------------
   How a fixed_asset row came into existence, decides whether/what journal
   gets posted at capitalization time (see /asset/create and
   /asset/capitalize-from-purchase-invoice below):
   OPENING          — a pre-existing asset being entered into the register
                      for the first time (e.g. onboarding this module against
                      assets the business already owned). No journal is
                      posted — the cost is already sitting in the books
                      however it was originally recorded; this call is just
                      catching the register up to reality.
   MANUAL_PURCHASE  — a newly bought asset, entered directly (not through
                      the Purchase Invoice module). Posts Dr Asset Ledger /
                      Cr credit_ledger (Bank A/c or a Sundry Creditors
                      ledger), same as step 5's part (a).
   PURCHASE_INVOICE — capitalized from an existing purchase_invoice_items
                      line (step 5's part (b)). The purchase was already
                      booked to Purchases A/c when the invoice was saved, so
                      capitalizing it is a RECLASSIFICATION journal: Dr Asset
                      Ledger / Cr Purchases A/c, moving the cost off the
                      P&L and onto the Balance Sheet — it does not touch the
                      supplier/GST entries already posted for that invoice. */
const VALID_CAPITALIZATION_MODES = ["OPENING", "MANUAL_PURCHASE", "PURCHASE_INVOICE"];

function normalizeCapitalizationMode(value) {
  const v = String(value || "OPENING").trim().toUpperCase();
  return VALID_CAPITALIZATION_MODES.includes(v) ? v : null;
}

/* -------------------- DEPRECIATION CALCULATION ENGINE (FAM Step 6) --------------------
   Pure function, no DB access — same separation the BOM costing engine and
   payroll's computePayroll() already use, so it's independently testable
   and so the (future) Depreciation Run can call it once per asset per
   period without caring how the numbers get persisted.

   computeDepreciation(asset, periodStart, periodEnd, openingWDV) returns the
   depreciation charge for ONE asset over the window [periodStart, periodEnd]
   (inclusive, 'YYYY-MM-DD' strings — a calendar month for a monthly run, a
   financial year for an annual one; the engine doesn't care which).

   asset: { acquisition_date, acquisition_cost, salvage_value,
            depreciation_method ('SLM'|'WDV'), depreciation_rate (percent,
            optional), useful_life_years, status, disposal_date (optional) }
   openingWDV: written-down value at the START of periodStart — i.e.
            acquisition_cost minus all depreciation booked in EARLIER
            periods. Required for WDV to be correct from the second period
            onward; if omitted, the engine assumes this is the asset's very
            first period and falls back to acquisition_cost (nothing
            depreciated yet). SLM does not need openingWDV to compute the
            charge (it's always a flat amount off original cost) but the
            value is still used, when supplied, to cap the charge so
            cumulative depreciation never runs past (cost - salvage).

   Behavior:
   - Returns 0 if the asset wasn't yet acquired by periodEnd, was disposed/
     written off before periodStart, or useful_life_years/rate can't
     produce a positive annual charge.
   - Pro-rates on an actual-days-held / 365 basis: annualCharge is always a
     FULL-YEAR figure, then scaled by daysHeld(within the window) / 365,
     capped at 1.0 so a leap-year's extra day never pushes a full-year
     charge above the full annual figure. This is what lets the SAME
     annualCharge produce a correct number whether [periodStart, periodEnd]
     is a full financial year (proration ~1) or just one calendar month of
     a monthly Depreciation Run (proration ~ 30/365) — without the caller
     having to know which. (A fixed 365-day reference, rather than a
     leap-aware 365/366 count, is a deliberate simplification — see the
     comment at the proration line below.)
   - SLM: annual charge = (cost - salvage) * rate, where rate is
     depreciation_rate/100 if given, else 1/useful_life_years.
   - WDV: annual charge = openingWDV * rate, where rate is
     depreciation_rate/100 if given, else the rate implied by
     useful_life_years by the standard reducing-balance formula
     rate = 1 - (salvage/cost)^(1/useful_life_years). (Falls back to
     1/useful_life_years, same as SLM, if salvage is 0 or cost <= 0, since
     the closed-form WDV rate is undefined when the asset depreciates fully
     to zero.)
   - The charge is always capped so opening WDV never drops below salvage
     value, and rounded to 2 decimals (rupee-paise), matching round2() used
     throughout payroll.js. */

function parseISODate(s) {
  // 'YYYY-MM-DD' -> UTC midnight Date, so day-diffs aren't shifted by the
  // server's local timezone (same reasoning DATE-only fields get treated
  // as UTC everywhere else money math touches a date in this codebase).
  if (!s) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetweenInclusive(startISO, endISO) {
  const s = parseISODate(startISO);
  const e = parseISODate(endISO);
  if (!s || !e || e < s) return 0;
  return Math.round((e - s) / 86400000) + 1;
}

// round2() — rupee-paise rounding helper — is already defined later in this
// file (used by the GST reports); function declarations are hoisted, so it
// is safely usable here too. Not redefined here to avoid a duplicate
// top-level declaration.

function computeDepreciation(asset, periodStart, periodEnd, openingWDV) {
  const cost = Number(asset.acquisition_cost) || 0;
  const salvage = Number(asset.salvage_value) || 0;
  const usefulLife = Number(asset.useful_life_years) || 0;
  const method = normalizeDepreciationMethod(asset.depreciation_method) || "SLM";
  const explicitRate = asset.depreciation_rate != null && asset.depreciation_rate !== ""
    ? Number(asset.depreciation_rate) / 100
    : null;

  if (cost <= 0 || salvage >= cost) return 0;
  if (asset.status && asset.status !== "ACTIVE") return 0;

  // Clip the window to how long the asset was actually held: never before
  // acquisition, never after disposal (if any).
  const effectiveStart = asset.acquisition_date > periodStart ? asset.acquisition_date : periodStart;
  const effectiveEnd = asset.disposal_date && asset.disposal_date < periodEnd ? asset.disposal_date : periodEnd;
  const daysHeld = daysBetweenInclusive(effectiveStart, effectiveEnd);
  if (daysHeld <= 0) return 0;
  if (daysBetweenInclusive(periodStart, periodEnd) <= 0) return 0; // invalid window (end before start)

  // Fixed 365-day reference year to convert the annual charge into a
  // daily rate. Using the *actual* days in whichever calendar/leap year
  // the window happens to fall in would be more precise, but which
  // calendar year "the" leap day should be attributed to is ambiguous for
  // a financial year (which spans two calendar years) — a fixed 365-day
  // basis is simpler, matches common practice, and the min(...,1) cap
  // below means a leap year's extra day is simply never charged rather
  // than silently over-depreciating.
  const proration = Math.min(daysHeld / 365, 1);

  // Opening WDV: caller-supplied, else assume this is the first-ever
  // period for this asset (nothing depreciated yet).
  const base = openingWDV != null && Number.isFinite(Number(openingWDV))
    ? Number(openingWDV)
    : cost;

  let annualCharge = 0;

  if (method === "SLM") {
    if (explicitRate != null) {
      annualCharge = (cost - salvage) * explicitRate;
    } else if (usefulLife > 0) {
      annualCharge = (cost - salvage) / usefulLife;
    }
  } else {
    // WDV
    let rate = explicitRate;
    if (rate == null) {
      if (usefulLife > 0 && salvage > 0) {
        rate = 1 - Math.pow(salvage / cost, 1 / usefulLife);
      } else if (usefulLife > 0) {
        rate = 1 / usefulLife; // fully-depreciating asset: fall back to SLM-equivalent rate
      }
    }
    if (rate != null) {
      annualCharge = base * rate;
    }
  }

  if (!(annualCharge > 0)) return 0;

  let charge = round2(annualCharge * proration);

  // Never depreciate past salvage value.
  const maxAllowed = round2(base - salvage);
  if (charge > maxAllowed) charge = maxAllowed;
  if (charge < 0) charge = 0;

  return charge;
}

/* locations.location_type — same "TEXT, validated in the API layer" stance
   as supply_type/item_type above. Matches the loose classifier the Step 1
   migration comment describes (used for filtering in dropdowns, not a
   CHECK constraint). Defaults to STORE, same fallback pattern as
   normalizeItemType. */
const VALID_LOCATION_TYPES = ["STORE", "SHOP_FLOOR", "QC", "OTHER"];

function normalizeLocationType(value) {
  const v = String(value || "STORE").trim().toUpperCase();
  return VALID_LOCATION_TYPES.includes(v) ? v : null;
}

/* validateUnitConversion(unit, secondaryUnit, conversionFactor)
 * Validates the secondary_unit/conversion_factor pair added alongside
 * item_type. Both fields are optional (an item with no secondary unit is
 * the normal case), but if EITHER is supplied, both must be, and they
 * must make sense together:
 *   - secondary_unit must be a real GST UQC code, same as the primary unit
 *   - secondary_unit must differ from the primary unit (else it's not a
 *     conversion, it's a no-op, and probably a data-entry mistake)
 *   - conversion_factor must be a positive number ("how many primary
 *     `unit`s make one secondary_unit", e.g. unit=NOS, secondary_unit=BOX,
 *     conversion_factor=12 → 1 BOX = 12 NOS)
 * Returns { ok: true, secondary_unit, conversion_factor } with normalized
 * values (secondary_unit uppercased, or both null if neither was supplied),
 * or { ok: false, error } for the caller to surface as a 400 — mirrors the
 * { ok, error } shape validateHsnForTurnover already uses elsewhere. */
function validateUnitConversion(unit, secondaryUnit, conversionFactor) {
  const hasSecondary = secondaryUnit != null && String(secondaryUnit).trim() !== "";
  const hasFactor = conversionFactor != null && String(conversionFactor).trim() !== "";

  if (!hasSecondary && !hasFactor) {
    return { ok: true, secondary_unit: null, conversion_factor: null };
  }

  if (hasSecondary !== hasFactor) {
    return {
      ok: false,
      error: "secondary_unit and conversion_factor must be supplied together, or not at all."
    };
  }

  const secondaryUpper = String(secondaryUnit).trim().toUpperCase();
  if (!isValidUqc(secondaryUpper)) {
    return {
      ok: false,
      error: `secondary_unit must be a standard GST Unit Quantity Code (UQC), e.g. NOS, KGS, PCS, BOX, MTR. Got "${secondaryUnit}". See /reference/uqc for the full list.`
    };
  }

  const primaryUpper = String(unit || "").trim().toUpperCase();
  if (secondaryUpper === primaryUpper) {
    return {
      ok: false,
      error: `secondary_unit ("${secondaryUpper}") must be different from the item's primary unit ("${primaryUpper}").`
    };
  }

  const factorNum = Number(conversionFactor);
  if (!Number.isFinite(factorNum) || factorNum <= 0) {
    return {
      ok: false,
      error: `conversion_factor must be a positive number. Got "${conversionFactor}".`
    };
  }

  return { ok: true, secondary_unit: secondaryUpper, conversion_factor: factorNum };
}

function normalizeItcCategory(value) {
  const v = String(value || "OTHER").trim().toUpperCase();
  return VALID_ITC_CATEGORIES.includes(v) ? v : null;
}

const VALID_ITC_ELIGIBLE = ["ELIGIBLE", "INELIGIBLE_17_5", "INELIGIBLE_OTHER"];

function normalizeItcEligible(value) {
  const v = String(value || "ELIGIBLE").trim().toUpperCase();
  return VALID_ITC_ELIGIBLE.includes(v) ? v : null;
}

// rcm_applicable is a plain 0/1 flag, not an enum — anything truthy (1,
// "1", true) normalizes to 1, everything else (including undefined, for
// lines/frontends that don't send it yet) normalizes to 0.
function normalizeRcmApplicable(value) {
  return value === 1 || value === "1" || value === true ? 1 : 0;
}

/* -------------------- EMAIL (HTTP API, not SMTP) --------------------
   Railway (and most PaaS hosts) block outbound SMTP ports (25/465/587),
   which is why nodemailer/SMTP never worked here. Instead this sends
   mail over a normal HTTPS API call. Three providers are supported —
   pick whichever you can sign up for right now, only ONE is needed:

   • Resend   — fastest signup (GitHub login). No domain required to
     test: you can send to your OWN signup email immediately using the
     shared sender onboarding@resend.dev. To email OTHER people's
     inboxes you'll eventually need to verify a domain.
     Setup: https://resend.com -> API Keys -> Create key
     Railway env var: RESEND_API_KEY

   • Brevo    — needs a verified "from" sender (no domain needed) but
     can then send to any real client address right away, not just
     your own inbox.
     Setup: https://www.brevo.com -> Senders -> verify one address,
     then Settings -> SMTP & API -> API Keys -> Generate
     Railway env var: BREVO_API_KEY

   • SendGrid — same deal as Brevo: verify one sender address (Settings
     -> Sender Authentication -> Single Sender Verification), then can
     send to any real client right away.
     Setup: https://sendgrid.com -> Settings -> API Keys -> Create key
     Railway env var: SENDGRID_API_KEY

   Whichever key(s) are present in env vars (or saved in Settings) get
   used, in priority order: Resend, then Brevo, then SendGrid.
------------------------------------------------------------------ */

const MAIL_SETTING_KEYS = [
  "resend_api_key",
  "brevo_api_key",
  "sendgrid_api_key",
  "mail_from_name",
  "mail_from_email"
];

async function getMailConfig() {
  const values = await Promise.all(MAIL_SETTING_KEYS.map(k => getSetting(k, "")));
  const cfg = {};
  MAIL_SETTING_KEYS.forEach((k, i) => (cfg[k] = values[i]));
  // Env vars take priority so keys don't have to live in the DB.
  cfg.resend_api_key = process.env.RESEND_API_KEY || cfg.resend_api_key;
  cfg.brevo_api_key = process.env.BREVO_API_KEY || cfg.brevo_api_key;
  cfg.sendgrid_api_key = process.env.SENDGRID_API_KEY || cfg.sendgrid_api_key;
  cfg.mail_from_name = process.env.MAIL_FROM_NAME || cfg.mail_from_name;
  cfg.mail_from_email = process.env.MAIL_FROM_EMAIL || cfg.mail_from_email;
  return cfg;
}

async function sendViaResend(cfg, { to, subject, text, attachments }) {
  // No verified domain yet? Resend still lets you send from this shared
  // sandbox address, but only to the email you signed up with.
  const fromEmail = cfg.mail_from_email || "onboarding@resend.dev";
  const fromName = cfg.mail_from_name || "Accounts";

  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: [to],
    subject,
    text
  };

  if (attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: fs.readFileSync(a.path).toString("base64")
    }));
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.resend_api_key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || `Resend API error (${resp.status})`);
  }
  return data;
}

async function sendViaBrevo(cfg, { to, subject, text, attachments }) {
  if (!cfg.mail_from_email) {
    throw new Error(
      "No 'from' email set. Go to Settings and enter the sender email you verified in Brevo."
    );
  }

  const payload = {
    sender: { name: cfg.mail_from_name || "Accounts", email: cfg.mail_from_email },
    to: [{ email: to }],
    subject,
    textContent: text
  };

  if (attachments.length) {
    payload.attachment = attachments.map(a => ({
      name: a.filename,
      content: fs.readFileSync(a.path).toString("base64")
    }));
  }

  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": cfg.brevo_api_key,
      "Content-Type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || `Brevo API error (${resp.status})`);
  }
  return data;
}

async function sendViaSendGrid(cfg, { to, subject, text, attachments }) {
  if (!cfg.mail_from_email) {
    throw new Error(
      "No 'from' email set. Go to Settings and enter the sender email you verified in SendGrid."
    );
  }

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: cfg.mail_from_email, name: cfg.mail_from_name || "Accounts" },
    subject,
    content: [{ type: "text/plain", value: text }]
  };

  if (attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      type: "application/pdf",
      disposition: "attachment",
      content: fs.readFileSync(a.path).toString("base64")
    }));
  }

  const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.sendgrid_api_key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  // SendGrid returns 202 with an empty body on success, so only try to
  // parse JSON when there's actually a body (i.e. on error).
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    const msg = data?.errors?.map(e => e.message).join("; ");
    throw new Error(msg || `SendGrid API error (${resp.status})`);
  }
  return { status: "sent" };
}

async function sendEmail({ to, subject, text, attachments = [] }) {
  const cfg = await getMailConfig();

  if (cfg.resend_api_key) {
    return sendViaResend(cfg, { to, subject, text, attachments });
  }
  if (cfg.brevo_api_key) {
    return sendViaBrevo(cfg, { to, subject, text, attachments });
  }
  if (cfg.sendgrid_api_key) {
    return sendViaSendGrid(cfg, { to, subject, text, attachments });
  }

  throw new Error(
    "Email is not configured yet. Add a Resend, Brevo, or SendGrid API key in Settings (or as a Railway env var: RESEND_API_KEY / BREVO_API_KEY / SENDGRID_API_KEY)."
  );
}

function logEmailAttempt({ invoice_no, client_id, email, status, error }) {
  db.run(
    `INSERT INTO email_log (invoice_no, client_id, email, status, error)
     VALUES (?, ?, ?, ?, ?)`,
    [invoice_no || null, client_id || null, email || null, status, error || null]
  );
}

/* -------------------- WHATSAPP (Twilio) --------------------
   Uses Twilio's WhatsApp Business API over its normal HTTPS REST API
   (no SDK needed, same pattern as the email providers above).

   Setup:
     1. https://console.twilio.com -> get your Account SID + Auth Token.
     2. Enable WhatsApp: either use Twilio's WhatsApp Sandbox for testing
        (join code, sandbox number like whatsapp:+14155238886), or a
        Twilio-approved WhatsApp Sender for production.
     3. Set these as Settings (or Railway env vars):
        TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
        (TWILIO_WHATSAPP_FROM must include the "whatsapp:" prefix, e.g.
        "whatsapp:+14155238886")

   Media (the invoice PDF) is sent as a MediaUrl, not an attachment —
   Twilio fetches it itself, so it must be a URL Twilio can reach over
   the public internet. That's why PUBLIC_BASE_URL is required: it's
   your Railway URL (or custom domain), used to build
   `${PUBLIC_BASE_URL}/invoices/sales/<invoiceNo>.pdf`, which is already
   served publicly by the /invoices static route below.
------------------------------------------------------------------ */

const WHATSAPP_SETTING_KEYS = [
  "twilio_account_sid",
  "twilio_auth_token",
  "twilio_whatsapp_from",
  "whatsapp_default_country_code",
  "public_base_url",
  "twilio_content_sid"
];

async function getWhatsAppConfig() {
  const values = await Promise.all(WHATSAPP_SETTING_KEYS.map(k => getSetting(k, "")));
  const cfg = {};
  WHATSAPP_SETTING_KEYS.forEach((k, i) => (cfg[k] = values[i]));
  // Env vars take priority so keys don't have to live in the DB.
  cfg.twilio_account_sid = process.env.TWILIO_ACCOUNT_SID || cfg.twilio_account_sid;
  cfg.twilio_auth_token = process.env.TWILIO_AUTH_TOKEN || cfg.twilio_auth_token;
  cfg.twilio_whatsapp_from = process.env.TWILIO_WHATSAPP_FROM || cfg.twilio_whatsapp_from;
  cfg.whatsapp_default_country_code =
    process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || cfg.whatsapp_default_country_code;
  cfg.public_base_url = process.env.PUBLIC_BASE_URL || cfg.public_base_url;
  // HX... SID of a Twilio Content Template. Required for any message that
  // *starts* a conversation (i.e. isn't a reply within the 24h customer
  // service window) - which is every invoice notification we send.
  // In the Sandbox this must be one of Twilio's 3 pre-approved templates
  // (see Console > Messaging > Try it Out > Send a WhatsApp message, or the
  // legacy Content Template Builder). In production, register your own
  // WhatsApp Sender and create/approve a custom template instead.
  cfg.twilio_content_sid = process.env.TWILIO_CONTENT_SID || cfg.twilio_content_sid;
  return cfg;
}

// Turns a loosely-formatted phone number into E.164 (e.g. "+919876543210").
// Client phone numbers are typically stored without a country code, so we
// prepend a default one (configurable in Settings) when it's missing.
function normalizePhoneForWhatsApp(rawPhone, defaultCountryCode) {
  let digits = String(rawPhone || "").replace(/[^\d+]/g, "");
  if (!digits) return null;

  if (digits.startsWith("+")) {
    return digits;
  }
  // Already has a country code typed without a leading +, e.g. "919876543210"
  if (defaultCountryCode && digits.startsWith(defaultCountryCode)) {
    return `+${digits}`;
  }
  const cc = (defaultCountryCode || "").replace(/[^\d]/g, "");
  return cc ? `+${cc}${digits}` : `+${digits}`;
}

// sendWhatsApp() supports two mutually-exclusive modes:
//
//   1. Template mode (contentVariables passed in): sends ContentSid +
//      ContentVariables. Required for any message that STARTS a
//      conversation - i.e. the customer hasn't messaged you in the last
//      24h. This is the normal case for invoice notifications.
//
//   2. Free-form mode (body/mediaUrl passed in, no contentVariables):
//      sends Body/MediaUrl directly. Only works as a REPLY within 24h of
//      the customer's last inbound message (e.g. right after they send
//      "join <sandbox-code>"). Outside that window Twilio rejects it with
//      Error 92005/21654 "ContentSid Required" - which is the error that
//      prompted this change.
async function sendWhatsApp({ to, body, mediaUrl, contentVariables }) {
  const cfg = await getWhatsAppConfig();

  if (!cfg.twilio_account_sid || !cfg.twilio_auth_token) {
    throw new Error(
      "WhatsApp is not configured yet. Add your Twilio Account SID and Auth Token in Settings (or as Railway env vars: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)."
    );
  }
  if (!cfg.twilio_whatsapp_from) {
    throw new Error(
      'No WhatsApp "from" number set. Add it in Settings, including the whatsapp: prefix (e.g. whatsapp:+14155238886).'
    );
  }

  const toAddress = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const params = new URLSearchParams();
  params.set("To", toAddress);
  params.set("From", cfg.twilio_whatsapp_from);

  if (contentVariables) {
    // Template mode.
    if (!cfg.twilio_content_sid) {
      throw new Error(
        "No Content Template SID set. Add TWILIO_CONTENT_SID in Settings (an HX... SID from Console > Messaging > Content Template Builder). In the Sandbox you must use one of Twilio's 3 pre-approved templates."
      );
    }
    params.set("ContentSid", cfg.twilio_content_sid);
    params.set("ContentVariables", JSON.stringify(contentVariables));
  } else {
    // Free-form mode - only valid inside an open 24h session.
    if (!cfg.public_base_url && mediaUrl) {
      throw new Error(
        "No Public Base URL set in Settings. WhatsApp needs a public HTTPS URL to fetch the invoice PDF from (e.g. your Railway URL)."
      );
    }
    if (body) params.set("Body", body);
    if (mediaUrl) params.set("MediaUrl", mediaUrl);
  }

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_account_sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${cfg.twilio_account_sid}:${cfg.twilio_auth_token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    }
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || `Twilio API error (${resp.status})`);
  }
  return data;
}

function logWhatsAppAttempt({ invoice_no, client_id, phone, status, error, provider }) {
  db.run(
    `INSERT INTO whatsapp_log (invoice_no, client_id, phone, status, error, provider)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [invoice_no || null, client_id || null, phone || null, status, error || null, provider || null]
  );
}

/* -------------------- WHATSAPP (Meta Cloud API) --------------------
   Uses Meta's official WhatsApp Business Platform (Cloud API) directly —
   no Twilio in the middle. This runs ALONGSIDE the Twilio integration
   above; which one actually gets used is controlled by the
   "whatsapp_provider" setting ("twilio" or "meta", Twilio remains the
   default so nothing changes unless you switch it).

   Setup:
     1. https://developers.facebook.com -> create/select a Meta App ->
        add the "WhatsApp" product.
     2. WhatsApp > API Setup gives you a Phone Number ID and a temporary
        access token (24h). For anything beyond quick testing, generate a
        permanent token instead: Meta Business Suite > System Users ->
        create a system user with whatsapp_business_messaging permission
        -> generate a token with no expiry.
     3. Set these as Settings (or Railway env vars):
        META_WHATSAPP_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID
     4. Business-initiated messages (every invoice notification) MUST use
        a pre-approved Message Template - create one under WhatsApp >
        Message Templates in Meta Business Suite. Set its name/language
        as META_WHATSAPP_TEMPLATE_NAME / META_WHATSAPP_TEMPLATE_LANG (or
        in Settings). The template's body should have 4 {{n}} variables
        to match the same "type / number / date / message" layout used
        for Twilio, so the two providers stay interchangeable - see the
        mapping in /invoices/send-whatsapp below.
     5. Optional - to receive delivery status callbacks (and any inbound
        replies), point a webhook at this server: Meta App > WhatsApp >
        Configuration > Webhook, callback URL
        `${PUBLIC_BASE_URL}/webhooks/whatsapp`, verify token = whatever
        you set as META_WHATSAPP_VERIFY_TOKEN, subscribe to "messages".

   Media (the invoice PDF) is sent as a document header component with a
   public link, same idea as Twilio's MediaUrl - Meta fetches it itself.
   This only works if the approved template actually has a document
   header, which is why it's gated behind the
   "meta_whatsapp_template_has_doc_header" setting.
------------------------------------------------------------------ */

const META_WHATSAPP_SETTING_KEYS = [
  "whatsapp_provider",
  "meta_whatsapp_token",
  "meta_whatsapp_phone_number_id",
  "meta_whatsapp_business_account_id",
  "meta_whatsapp_verify_token",
  "meta_whatsapp_template_name",
  "meta_whatsapp_template_lang",
  "meta_whatsapp_template_has_doc_header"
];

const META_GRAPH_VERSION = "v20.0";

async function getMetaWhatsAppConfig() {
  const values = await Promise.all(META_WHATSAPP_SETTING_KEYS.map(k => getSetting(k, "")));
  const cfg = {};
  META_WHATSAPP_SETTING_KEYS.forEach((k, i) => (cfg[k] = values[i]));

  // Env vars take priority so keys don't have to live in the DB.
  cfg.whatsapp_provider = (process.env.WHATSAPP_PROVIDER || cfg.whatsapp_provider || "twilio").toLowerCase();
  cfg.meta_whatsapp_token = process.env.META_WHATSAPP_TOKEN || cfg.meta_whatsapp_token;
  cfg.meta_whatsapp_phone_number_id =
    process.env.META_WHATSAPP_PHONE_NUMBER_ID || cfg.meta_whatsapp_phone_number_id;
  cfg.meta_whatsapp_business_account_id =
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || cfg.meta_whatsapp_business_account_id;
  cfg.meta_whatsapp_verify_token =
    process.env.META_WHATSAPP_VERIFY_TOKEN || cfg.meta_whatsapp_verify_token;
  cfg.meta_whatsapp_template_name =
    process.env.META_WHATSAPP_TEMPLATE_NAME || cfg.meta_whatsapp_template_name;
  cfg.meta_whatsapp_template_lang =
    process.env.META_WHATSAPP_TEMPLATE_LANG || cfg.meta_whatsapp_template_lang || "en_US";
  cfg.meta_whatsapp_template_has_doc_header =
    cfg.meta_whatsapp_template_has_doc_header === "true" || cfg.meta_whatsapp_template_has_doc_header === true;
  return cfg;
}

// Meta wants the recipient as plain digits with country code, no "+" and
// no "whatsapp:" prefix (unlike Twilio) - reuse the same E.164 normalizer
// and just strip the leading "+".
function normalizePhoneForMeta(rawPhone, defaultCountryCode) {
  const e164 = normalizePhoneForWhatsApp(rawPhone, defaultCountryCode);
  return e164 ? e164.replace(/^\+/, "") : null;
}

// sendWhatsAppMeta() mirrors sendWhatsApp()'s two modes:
//
//   1. Template mode (templateName/bodyParams passed in, or nothing at
//      all): sends a pre-approved Message Template. Required for any
//      message that STARTS a conversation - i.e. business-initiated,
//      which is every invoice notification. Falls back to the
//      "hello_world" sample template (pre-approved for every WABA, no
//      params) when no template is configured, so the Settings "Send
//      Test WhatsApp" button works with zero template setup.
//
//   2. Free-form mode (body passed in, no templateName): sends a plain
//      text message. Only works as a REPLY within 24h of the customer's
//      last inbound message - outside that window Meta rejects it with
//      error 131047 "Re-engagement message".
async function sendWhatsAppMeta({ to, body, templateName, templateLang, bodyParams, documentHeaderLink }) {
  const cfg = await getMetaWhatsAppConfig();

  if (!cfg.meta_whatsapp_token) {
    throw new Error(
      "WhatsApp (Meta) is not configured yet. Add your Meta access token in Settings (or as a Railway env var: META_WHATSAPP_TOKEN)."
    );
  }
  if (!cfg.meta_whatsapp_phone_number_id) {
    throw new Error(
      "No Meta Phone Number ID set. Add it in Settings (from Meta Business Suite > WhatsApp > API Setup), or as META_WHATSAPP_PHONE_NUMBER_ID."
    );
  }

  const toDigits = String(to || "").replace(/^whatsapp:/, "").replace(/^\+/, "");

  let payload;
  if (body && !templateName) {
    payload = { messaging_product: "whatsapp", to: toDigits, type: "text", text: { body } };
  } else {
    const name = templateName || cfg.meta_whatsapp_template_name || "hello_world";
    const lang = templateLang || cfg.meta_whatsapp_template_lang || "en_US";
    const components = [];

    if (documentHeaderLink && cfg.meta_whatsapp_template_has_doc_header) {
      components.push({
        type: "header",
        parameters: [
          { type: "document", document: { link: documentHeaderLink, filename: `${name}.pdf` } }
        ]
      });
    }
    if (bodyParams && bodyParams.length) {
      components.push({
        type: "body",
        parameters: bodyParams.map(p => ({ type: "text", text: String(p) }))
      });
    }

    payload = {
      messaging_product: "whatsapp",
      to: toDigits,
      type: "template",
      template: {
        name,
        language: { code: lang },
        ...(components.length ? { components } : {})
      }
    };
  }

  const resp = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${cfg.meta_whatsapp_phone_number_id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.meta_whatsapp_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `Meta WhatsApp API error (${resp.status})`);
  }
  return data;
}

/* -------------------- SALES INVOICE UPDATE FUCNTION -------------------- */

function getNextInvoiceNo(cb) {
  db.get(
    `
    SELECT MAX(
      CAST(SUBSTR(narration, INSTR(narration, 'INV-') + 4) AS INTEGER)
    ) AS maxInv
    FROM journal_voucher
    WHERE narration LIKE 'Sales Invoice INV-%'
    `,
    [],
    (err, row) => {
      if (err) return cb(err);

      const next = (row?.maxInv || 0) + 1;
      const invNo = "INV-" + String(next).padStart(4, "0");
      cb(null, invNo);
    }
  );
}

/* -------------------- SALES INVOICE PDF FUCNTION -------------------- */


/* ---- Number to words (Indian numbering: crore/lakh/thousand) ---- */
const NUM_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const NUM_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(n) {
  if (n < 20) return NUM_ONES[n];
  return NUM_TENS[Math.floor(n / 10)] + (n % 10 ? " " + NUM_ONES[n % 10] : "");
}

function threeDigitWords(n) {
  let str = "";
  if (n >= 100) {
    str += NUM_ONES[Math.floor(n / 100)] + " Hundred";
    n %= 100;
    if (n) str += " ";
  }
  if (n) str += twoDigitWords(n);
  return str;
}

function numberToWordsIndian(num) {
  num = Math.round(num);
  if (num === 0) return "Zero";

  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  const rest = num;

  const parts = [];
  if (crore) parts.push(threeDigitWords(crore) + " Crore");
  if (lakh) parts.push(threeDigitWords(lakh) + " Lakh");
  if (thousand) parts.push(threeDigitWords(thousand) + " Thousand");
  if (rest) parts.push(threeDigitWords(rest));

  return parts.join(" ");
}

// e.g. 4130.5 -> "Indian Rupee Four Thousand One Hundred Thirty and Fifty Paise Only"
function amountInWords(amount, currencyLabel) {
  const rupees = Math.floor(amount + 1e-6);
  const paise = Math.round((amount - rupees) * 100);

  let words = (currencyLabel || "Indian Rupee") + " " + numberToWordsIndian(rupees);
  if (paise > 0) {
    words += " and " + numberToWordsIndian(paise) + " Paise";
  }
  words += " Only";
  return words;
}

/* ---- Template: classic (original design) ---- */
/* -------------------- STEP 6: INVOICE PDF LABELING -------------------- */
/* EXEMPT/NIL_RATED/ZERO_RATED lines always carry 0% GST (forced at save
   time in Step 3), so there's never a real tax amount to print against
   them — instead the line/HSN-group is labelled with its classification,
   and any invoice carrying a ZERO_RATED (export/SEZ under LUT) line gets
   the Rule 46 statutory declaration printed on it. */
function supplyTypeLabel(supplyType) {
  const v = normalizeSupplyType(supplyType) || "TAXABLE";
  if (v === "EXEMPT") return "Exempt";
  if (v === "NIL_RATED") return "Nil Rated";
  if (v === "ZERO_RATED") return "Zero Rated";
  return null; // TAXABLE — no label, GST breakup applies as normal
}

function hasZeroRatedLine(items) {
  return (items || []).some(item => normalizeSupplyType(item.supply_type) === "ZERO_RATED");
}

// Rule 46 of the CGST Rules, 2017 mandates this exact declaration on any
// tax invoice covering a zero-rated (export/SEZ under LUT) supply.
const EXPORT_DECLARATION_TEXT = "SUPPLY MEANT FOR EXPORT/SEZ UNDER LUT WITHOUT PAYMENT OF IGST";

// Appends the classification label to a line's description for display —
// e.g. "Widget A (Exempt)" — so a non-taxable line is clearly marked right
// on the items table instead of silently showing a 0.00 GST amount.
function describeLineForPdf(item) {
  const label = supplyTypeLabel(item.supply_type);
  return label ? `${item.description || ""} (${label})` : (item.description || "");
}

function renderClassicTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal, seller, buyer }) {
  // HEADER
  doc.fontSize(18).text("TAX INVOICE", { align: "center" }).moveDown();

  if (seller && seller.name) {
    doc.font("Helvetica-Bold").fontSize(12).text(seller.name);
    doc.font("Helvetica").fontSize(9);
    if (seller.address) doc.text(seller.address);
    if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`);
    doc.moveDown();
  }

  doc.fontSize(12)
    .text(`Invoice No: ${invoiceNo}`)
    .text(`Date: ${date}`)
    .moveDown();

  doc.font("Helvetica-Bold").text("Billed To:");
  doc.font("Helvetica").text(customer);
  if (buyer && buyer.address) doc.fontSize(9).text(buyer.address).fontSize(12);
  if (buyer && buyer.gstin) doc.fontSize(9).text(`GSTIN: ${buyer.gstin}`).fontSize(12);
  doc.moveDown();

  // TABLE HEADER
  let y = doc.y;
  doc.font("Helvetica-Bold");
  doc.text("Sr", 40, y);
  doc.text("Description", 80, y);
  doc.text("Qty", 330, y, { width: 50, align: "right" });
  doc.text("Rate", 390, y, { width: 70, align: "right" });
  doc.text("Amount", 470, y, { width: 80, align: "right" });

  doc.moveDown(0.5).font("Helvetica");

  // ITEMS
  let startY = doc.y;

  items.forEach((item, i) => {
    const displayDesc = describeLineForPdf(item);
    const descHeight = doc.heightOfString(displayDesc, { width: 240 });
    const rowHeight = Math.max(descHeight, 20);

    if (startY + rowHeight > doc.page.height - 80) {
      doc.addPage();
      startY = 50;

      doc.font("Helvetica-Bold");
      doc.text("Sr", 40, startY);
      doc.text("Description", 80, startY);
      doc.text("Qty", 330, startY, { width: 50, align: "right" });
      doc.text("Rate", 390, startY, { width: 70, align: "right" });
      doc.text("Amount", 470, startY, { width: 80, align: "right" });
      doc.font("Helvetica");

      startY += 20;
    }

    doc.text(i + 1, 40, startY);
    doc.text(displayDesc, 80, startY, { width: 240 });
    doc.text(item.qty, 330, startY, { width: 50, align: "right" });
    doc.text(item.rate.toFixed(2), 390, startY, { width: 70, align: "right" });
    doc.text(item.amount.toFixed(2), 470, startY, { width: 80, align: "right" });

    startY += rowHeight + 5;
  });

  doc.y = startY;

  // TOTAL
  // "Taxable Amount" and "Grand Total" print unconditionally — an invoice
  // that's wholly EXEMPT/NIL_RATED/ZERO_RATED has no CGST/SGST/IGST to
  // show (gstBreakup is null), but it still has an amount payable and
  // that must never disappear from the PDF.
  doc.moveDown();
  doc.font("Helvetica-Bold")
     .text(`Taxable Amount: ₹ ${amount.toFixed(2)}`, { align: "right" });

  if (gstBreakup) {
    doc.font("Helvetica");
    if (gstBreakup.igst) {
      doc.text(`IGST: ₹ ${gstBreakup.igst.toFixed(2)}`, { align: "right" });
    } else {
      doc.text(`CGST: ₹ ${gstBreakup.cgst.toFixed(2)}`, { align: "right" });
      doc.text(`SGST: ₹ ${gstBreakup.sgst.toFixed(2)}`, { align: "right" });
    }
  }
  doc.font("Helvetica-Bold")
     .text(`Grand Total: ₹ ${grandTotal.toFixed(2)}`, { align: "right" });

  doc.moveDown(1);
  if (hasZeroRatedLine(items)) {
    doc.font("Helvetica-Bold").fontSize(9)
       .text(EXPORT_DECLARATION_TEXT, { align: "center" });
    doc.moveDown(0.5);
  }

  doc.moveDown(1);
  doc.fontSize(10).font("Helvetica").text("This is a system generated invoice.", { align: "center" });
}

/* ---- Template: modern (colored header band + shaded totals box) ---- */
function renderModernTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal, seller, buyer }) {
  const accent = "#2952e3";

  // HEADER BAND
  doc.rect(0, 0, doc.page.width, 90).fill(accent);
  doc.fillColor("white").fontSize(22).font("Helvetica-Bold")
     .text("TAX INVOICE", 40, 30);
  doc.fontSize(10).font("Helvetica")
     .text(`Invoice No: ${invoiceNo}`, 40, 60)
     .text(`Date: ${date}`, 40, 74);

  if (seller && seller.name) {
    doc.fontSize(11).font("Helvetica-Bold").text(seller.name, 330, 28, { width: 220, align: "right" });
    doc.fontSize(8).font("Helvetica");
    if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`, 330, 42, { width: 220, align: "right" });
    if (seller.address) doc.text(seller.address, 330, 54, { width: 220, align: "right" });
  }

  doc.fillColor("black");
  doc.y = 110;

  doc.font("Helvetica-Bold").fontSize(11).text("Billed To:");
  doc.font("Helvetica").fontSize(11).text(customer);
  if (buyer && buyer.address) doc.fontSize(9).text(buyer.address).fontSize(11);
  if (buyer && buyer.gstin) doc.fontSize(9).text(`GSTIN: ${buyer.gstin}`).fontSize(11);
  doc.moveDown();

  // TABLE HEADER
  let y = doc.y;
  doc.rect(40, y - 4, 510, 20).fill("#eef1fb");
  doc.fillColor(accent).font("Helvetica-Bold").fontSize(10);
  doc.text("Sr", 45, y);
  doc.text("Description", 80, y);
  doc.text("Qty", 330, y, { width: 50, align: "right" });
  doc.text("Rate", 390, y, { width: 70, align: "right" });
  doc.text("Amount", 470, y, { width: 75, align: "right" });
  doc.fillColor("black").font("Helvetica");

  doc.moveDown(1.2);
  let startY = doc.y;

  items.forEach((item, i) => {
    const displayDesc = describeLineForPdf(item);
    const descHeight = doc.heightOfString(displayDesc, { width: 240 });
    const rowHeight = Math.max(descHeight, 20);

    if (startY + rowHeight > doc.page.height - 100) {
      doc.addPage();
      startY = 50;
    }

    if (i % 2 === 1) {
      doc.rect(40, startY - 3, 510, rowHeight + 3).fill("#f7f8fc");
      doc.fillColor("black");
    }

    doc.fontSize(10);
    doc.text(i + 1, 45, startY);
    doc.text(displayDesc, 80, startY, { width: 240 });
    doc.text(item.qty, 330, startY, { width: 50, align: "right" });
    doc.text(item.rate.toFixed(2), 390, startY, { width: 70, align: "right" });
    doc.text(item.amount.toFixed(2), 470, startY, { width: 75, align: "right" });

    startY += rowHeight + 5;
  });

  doc.y = startY + 10;

  // TOTALS BOX
  // Box height still varies by how many tax lines are shown, but the box
  // always reserves a row for Grand Total now — a wholly EXEMPT/NIL_RATED/
  // ZERO_RATED invoice (gstBreakup null) still needs 1 row for Taxable
  // Amount + 1 row for Grand Total (40px), not just the Taxable Amount row.
  const boxTop = doc.y;
  const boxHeight = gstBreakup ? (gstBreakup.igst ? 60 : 78) : 40;
  doc.rect(330, boxTop, 220, boxHeight).fillAndStroke("#eef1fb", "#eef1fb");
  doc.fillColor("black").font("Helvetica").fontSize(10);

  let ty = boxTop + 8;
  doc.text(`Taxable Amount:`, 340, ty, { continued: false });
  doc.text(`₹ ${amount.toFixed(2)}`, 470, ty, { width: 70, align: "right" });
  ty += 16;

  if (gstBreakup) {
    if (gstBreakup.igst) {
      doc.text(`IGST:`, 340, ty);
      doc.text(`₹ ${gstBreakup.igst.toFixed(2)}`, 470, ty, { width: 70, align: "right" });
      ty += 16;
    } else {
      doc.text(`CGST:`, 340, ty);
      doc.text(`₹ ${gstBreakup.cgst.toFixed(2)}`, 470, ty, { width: 70, align: "right" });
      ty += 16;
      doc.text(`SGST:`, 340, ty);
      doc.text(`₹ ${gstBreakup.sgst.toFixed(2)}`, 470, ty, { width: 70, align: "right" });
      ty += 16;
    }
  }
  doc.font("Helvetica-Bold").fillColor(accent);
  doc.text(`Grand Total:`, 340, ty);
  doc.text(`₹ ${grandTotal.toFixed(2)}`, 470, ty, { width: 70, align: "right" });

  doc.fillColor("black").font("Helvetica");
  doc.y = boxTop + boxHeight + 20;
  if (hasZeroRatedLine(items)) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("black")
       .text(EXPORT_DECLARATION_TEXT, { align: "center" });
    doc.moveDown(0.5);
    doc.font("Helvetica");
  }
  doc.fontSize(9).fillColor("#888")
     .text("This is a system generated invoice.", { align: "center" });
  doc.fillColor("black");
}

/* ---- Template: minimal (ruled lines, no boxes, compact) ---- */
function renderMinimalTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal, seller, buyer }) {
  doc.fontSize(14).font("Helvetica-Bold").text("Tax Invoice");
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica");
  if (seller && seller.name) {
    let sellerLine = seller.name;
    if (seller.gstin) sellerLine += `    GSTIN: ${seller.gstin}`;
    doc.text(sellerLine);
    if (seller.address) doc.text(seller.address);
  }
  doc.text(`Invoice No: ${invoiceNo}    Date: ${date}`);
  let billedToLine = `Billed To: ${customer}`;
  if (buyer && buyer.gstin) billedToLine += `    GSTIN: ${buyer.gstin}`;
  doc.text(billedToLine);
  if (buyer && buyer.address) doc.text(buyer.address);

  doc.moveDown(0.8);
  doc.moveTo(40, doc.y).lineTo(550, doc.y).strokeColor("#000").lineWidth(0.5).stroke();
  doc.moveDown(0.4);

  let y = doc.y;
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Sr", 40, y);
  doc.text("Description", 70, y);
  doc.text("Qty", 340, y, { width: 45, align: "right" });
  doc.text("Rate", 390, y, { width: 65, align: "right" });
  doc.text("Amount", 465, y, { width: 85, align: "right" });
  doc.font("Helvetica");
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(550, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
  doc.moveDown(0.3);

  let startY = doc.y;

  items.forEach((item, i) => {
    const displayDesc = describeLineForPdf(item);
    const descHeight = doc.heightOfString(displayDesc, { width: 260 });
    const rowHeight = Math.max(descHeight, 14);

    if (startY + rowHeight > doc.page.height - 90) {
      doc.addPage();
      startY = 50;
    }

    doc.fontSize(9);
    doc.text(i + 1, 40, startY);
    doc.text(displayDesc, 70, startY, { width: 260 });
    doc.text(item.qty, 340, startY, { width: 45, align: "right" });
    doc.text(item.rate.toFixed(2), 390, startY, { width: 65, align: "right" });
    doc.text(item.amount.toFixed(2), 465, startY, { width: 85, align: "right" });

    startY += rowHeight + 4;
  });

  doc.y = startY;
  doc.moveTo(40, doc.y).lineTo(550, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(9)
     .text(`Taxable Amount: ₹ ${amount.toFixed(2)}`, { align: "right" });

  if (gstBreakup) {
    if (gstBreakup.igst) {
      doc.text(`IGST: ₹ ${gstBreakup.igst.toFixed(2)}`, { align: "right" });
    } else {
      doc.text(`CGST: ₹ ${gstBreakup.cgst.toFixed(2)}`, { align: "right" });
      doc.text(`SGST: ₹ ${gstBreakup.sgst.toFixed(2)}`, { align: "right" });
    }
  }
  doc.font("Helvetica-Bold")
     .text(`Grand Total: ₹ ${grandTotal.toFixed(2)}`, { align: "right" });

  doc.moveDown(1);
  if (hasZeroRatedLine(items)) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("black")
       .text(EXPORT_DECLARATION_TEXT, { align: "center" });
    doc.moveDown(0.5);
  }
  doc.font("Helvetica").fontSize(8).fillColor("#666")
     .text("This is a system generated invoice.", { align: "center" });
  doc.fillColor("black");
}

// Indian digit grouping, e.g. 4130 -> "4,130.00", 3500 -> "3,500.00", 315 -> "315.00"
function formatINR(num) {
  num = Number(num) || 0;
  const negative = num < 0;
  const fixed = Math.abs(num).toFixed(2);
  let [intPart, dec] = fixed.split(".");
  let lastThree = intPart.slice(-3);
  let other = intPart.slice(0, -3);
  if (other !== "") {
    other = other.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    lastThree = "," + lastThree;
  }
  return (negative ? "-" : "") + other + lastThree + "." + dec;
}

/* ---- Template: gst_tabular (Tally / e-Invoice style bordered grid) ----
   Fields our system doesn't currently capture (consignee/ship-to, delivery
   note, dispatch details, terms of payment/delivery, discount %, IRN/
   e-Invoice QR) are rendered as blank cells rather than invented. Seller
   and buyer GSTIN/address ARE captured (Settings → Company profile, and
   the Client master respectively) and are printed below. */
function renderGstTabularTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, isInterState, grandTotal, seller, buyer }) {
  const L = 40, R = 555; // left / right content edges
  const W = R - L;       // usable width (515)

  doc.font("Helvetica");

  // ---------- TITLE ----------
  doc.fontSize(16).font("Helvetica-Bold").text("Tax Invoice", L, 40, { width: W, align: "center" });

  // ---------- SELLER BLOCK ----------
  // A tax invoice is only legally valid with the supplier's own name,
  // address and GSTIN on it, so this is drawn above the rest of the
  // header grid rather than left blank.
  let sellerBottom = 62;
  if (seller && (seller.name || seller.gstin || seller.address)) {
    let sy = sellerBottom + 2;
    if (seller.name) {
      doc.font("Helvetica-Bold").fontSize(11).text(seller.name, L, sy, { width: W });
      sy += 13;
    }
    doc.font("Helvetica").fontSize(8);
    if (seller.address) {
      doc.text(seller.address, L, sy, { width: W });
      sy += doc.heightOfString(seller.address, { width: W }) + 2;
    }
    if (seller.gstin) {
      doc.text(`GSTIN: ${seller.gstin}`, L, sy, { width: W });
      sy += 11;
    }
    sellerBottom = sy + 3;
    doc.moveTo(L, sellerBottom).lineTo(R, sellerBottom).lineWidth(0.5).strokeColor("#000").stroke();
  }

  // ---------- HEADER GRID ----------
  const headerTop = sellerBottom + 6;
  const leftColW = 300;          // seller/buyer block
  const rightColX = L + leftColW; // start of invoice-meta block
  const rightColW = W - leftColW;

  doc.fontSize(9);

  // Helper to draw a labelled line pair like Tally's right-hand meta grid:
  // returns the y after the row.
  function metaRow(y, h, leftLabel, leftValue, rightLabel, rightValue) {
    doc.moveTo(rightColX, y).lineTo(R, y).lineWidth(0.5).strokeColor("#000").stroke();
    const midX = rightColX + rightColW / 2;
    doc.moveTo(midX, y).lineTo(midX, y + h).stroke();
    doc.moveTo(rightColX, y).lineTo(rightColX, y + h).stroke();
    doc.moveTo(R, y).lineTo(R, y + h).stroke();

    doc.font("Helvetica").fontSize(8).fillColor("#000")
       .text(leftLabel, rightColX + 4, y + 3, { width: rightColW / 2 - 8 });
    if (leftValue) doc.font("Helvetica-Bold").text(leftValue, rightColX + 4, y + 14, { width: rightColW / 2 - 8 });

    if (rightLabel) {
      doc.font("Helvetica").fontSize(8)
         .text(rightLabel, midX + 4, y + 3, { width: rightColW / 2 - 8 });
      if (rightValue) doc.font("Helvetica-Bold").text(rightValue, midX + 4, y + 14, { width: rightColW / 2 - 8 });
    }
    return y + h;
  }

  const rowH = 30;
  let ry = headerTop;
  ry = metaRow(ry, rowH, "Invoice No.", invoiceNo, "Dated", date);
  ry = metaRow(ry, rowH, "Delivery Note", "", "Mode/Terms of Payment", "");
  ry = metaRow(ry, rowH, "Reference No. & Date.", "", "Other References", "");
  ry = metaRow(ry, rowH, "Buyer's Order No.", "", "Dated", "");
  ry = metaRow(ry, rowH, "Dispatch Doc No.", "", "Delivery Note Date", "");
  ry = metaRow(ry, rowH, "Dispatched through", "", "Destination", "");

  // Terms of Delivery — full width row
  const termsH = 26;
  doc.moveTo(rightColX, ry).lineTo(R, ry).lineWidth(0.5).stroke();
  doc.moveTo(rightColX, ry).lineTo(rightColX, ry + termsH).stroke();
  doc.moveTo(R, ry).lineTo(R, ry + termsH).stroke();
  doc.font("Helvetica").fontSize(8).text("Terms of Delivery", rightColX + 4, ry + 3, { width: rightColW - 8 });
  ry += termsH;
  doc.moveTo(rightColX, ry).lineTo(R, ry).lineWidth(0.5).stroke();

  const headerBottom = ry;

  // ---- Left block: Buyer (Bill to) ----
  // (No separate consignee/ship-to is stored in this system, so only the
  // single buyer name/address/GSTIN we do have is shown here.)
  doc.moveTo(L, headerTop).lineTo(L + leftColW, headerTop).lineWidth(0.5).stroke();
  doc.moveTo(L, headerTop).lineTo(L, headerBottom).stroke();
  doc.moveTo(L + leftColW, headerTop).lineTo(L + leftColW, headerBottom).stroke();
  doc.moveTo(L, headerBottom).lineTo(L + leftColW, headerBottom).stroke();

  doc.font("Helvetica").fontSize(9).text("Buyer (Bill to)", L + 6, headerTop + 8);
  doc.font("Helvetica-Bold").fontSize(11).text(customer, L + 6, headerTop + 22, { width: leftColW - 12 });

  let buyerY = headerTop + 22 + 14;
  doc.font("Helvetica").fontSize(8);
  if (buyer && buyer.address) {
    doc.text(buyer.address, L + 6, buyerY, { width: leftColW - 12 });
    buyerY += doc.heightOfString(buyer.address, { width: leftColW - 12 }) + 2;
  }
  if (buyer && buyer.gstin) {
    doc.text(`GSTIN/UIN: ${buyer.gstin}`, L + 6, buyerY, { width: leftColW - 12 });
  }

  // ---------- ITEMS TABLE ----------
  const cols = [
    { key: "sl", label: "Sl\nNo.", x: L, w: 25, align: "center" },
    { key: "desc", label: "Description of Goods", x: L + 25, w: 155, align: "left" },
    { key: "hsn", label: "HSN/SAC", x: L + 180, w: 50, align: "center" },
    { key: "qty", label: "Quantity", x: L + 230, w: 55, align: "right" },
    { key: "rate", label: "Rate", x: L + 285, w: 55, align: "right" },
    { key: "per", label: "per", x: L + 340, w: 30, align: "center" },
    { key: "disc", label: "Disc. %", x: L + 370, w: 35, align: "center" },
    { key: "amount", label: "Amount", x: L + 405, w: 110, align: "right" }
  ];

  function drawRowBorders(y, h) {
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor("#000").stroke();
    cols.forEach(c => doc.moveTo(c.x, y).lineTo(c.x, y + h).stroke());
    doc.moveTo(R, y).lineTo(R, y + h).stroke();
  }

  let y = headerBottom;
  const tblHeadH = 24;
  drawRowBorders(y, tblHeadH);
  doc.font("Helvetica-Bold").fontSize(8);
  cols.forEach(c => doc.text(c.label, c.x + 3, y + 6, { width: c.w - 6, align: c.align }));
  y += tblHeadH;

  doc.font("Helvetica").fontSize(9);

  let totalQty = 0;
  const hsnSummary = {}; // "<hsn>|<supplyType>" -> { hsn, taxable, gstRate, supplyType }

  items.forEach((item, i) => {
    const displayDesc = describeLineForPdf(item);
    const descHeight = doc.heightOfString(displayDesc || "", { width: cols[1].w - 6 });
    const rowHeight = Math.max(descHeight + 8, 22);

    if (y + rowHeight > doc.page.height - 130) {
      doc.addPage();
      y = 50;
      drawRowBorders(y, tblHeadH);
      doc.font("Helvetica-Bold").fontSize(8);
      cols.forEach(c => doc.text(c.label, c.x + 3, y + 6, { width: c.w - 6, align: c.align }));
      y += tblHeadH;
      doc.font("Helvetica").fontSize(9);
    }

    drawRowBorders(y, rowHeight);

    const vals = {
      sl: String(i + 1),
      desc: displayDesc || "",
      hsn: item.hsn || "",
      qty: `${item.qty} ${item.unit || ""}`.trim(),
      rate: formatINR(item.rate),
      per: item.unit || "",
      disc: "",
      amount: formatINR(item.amount)
    };
    cols.forEach(c => doc.text(vals[c.key], c.x + 3, y + 5, { width: c.w - 6, align: c.align }));

    totalQty += Number(item.qty) || 0;

    const supplyType = normalizeSupplyType(item.supply_type) || "TAXABLE";
    const hsnKey = `${item.hsn || "—"}|${supplyType}`;
    if (!hsnSummary[hsnKey]) {
      hsnSummary[hsnKey] = { hsn: item.hsn || "—", taxable: 0, gstRate: Number(item.gst_rate) || 0, supplyType };
    }
    hsnSummary[hsnKey].taxable += Number(item.amount) || 0;

    y += rowHeight;
  });

  // GST breakup rows (CGST/SGST or IGST), right-aligned under Amount column
  const gstLineH = 16;
  const gstLines = [];
  if (gstBreakup) {
    if (gstBreakup.igst) {
      gstLines.push(["IGST", gstBreakup.igst]);
    } else {
      gstLines.push(["CGST", gstBreakup.cgst]);
      gstLines.push(["SGST", gstBreakup.sgst]);
    }
  }

  const gstBlockH = Math.max(gstLines.length * gstLineH + 10, 20);
  if (y + gstBlockH > doc.page.height - 130) {
    doc.addPage();
    y = 50;
  }
  drawRowBorders(y, gstBlockH);
  let gy = y + 6;
  doc.font("Helvetica-Oblique").fontSize(9);
  gstLines.forEach(([label, val]) => {
    doc.text(label, cols[1].x + 3, gy, { width: cols[1].w - 6 });
    doc.text(formatINR(val), cols[7].x + 3, gy, { width: cols[7].w - 6, align: "right" });
    gy += gstLineH;
  });
  y += gstBlockH;

  // Totals row
  const totalRowH = 24;
  drawRowBorders(y, totalRowH);
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Total", cols[1].x + 3, y + 6, { width: cols[1].w - 6, align: "right" });
  doc.text(`${totalQty} ${items[0]?.unit || ""}`.trim(), cols[3].x + 3, y + 6, { width: cols[3].w - 6, align: "right" });
  doc.text(`Rs. ${formatINR(grandTotal)}`, cols[7].x + 3, y + 6, { width: cols[7].w - 6, align: "right" });
  y += totalRowH;

  // ---------- AMOUNT IN WORDS ----------
  const wordsBoxH = 34;
  doc.rect(L, y, W, wordsBoxH).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8)
     .text("Amount Chargeable (in words)", L + 6, y + 5);
  doc.font("Helvetica-Oblique").fontSize(8)
     .text("E. & O.E", L + 6, y + 5, { width: W - 12, align: "right" });
  doc.font("Helvetica-Bold").fontSize(10)
     .text(amountInWords(grandTotal), L + 6, y + 18, { width: W - 12 });
  y += wordsBoxH;

  // ---------- HSN-WISE TAX SUMMARY ----------
  // Column layout (Integrated Tax vs Central+State Tax) reflects whether
  // the SUPPLY is inter-state, not whether any tax was actually collected
  // on it — an all-zero-rated export invoice is still an inter-state
  // (export) transaction even though gstBreakup is null, so this can't be
  // inferred from gstBreakup.igst the way it used to be.
  const isInter = isInterState != null ? !!isInterState : !!(gstBreakup && gstBreakup.igst);
  const taxCols = isInter
    ? [
        { key: "hsn", label: "HSN/SAC", x: L, w: 150, align: "left" },
        { key: "taxable", label: "Taxable\nValue", x: L + 150, w: 100, align: "right" },
        { key: "igstRate", label: "Integrated Tax\nRate", x: L + 250, w: 70, align: "center" },
        { key: "igstAmt", label: "Integrated Tax\nAmount", x: L + 320, w: 100, align: "right" },
        { key: "totalTax", label: "Total\nTax Amount", x: L + 420, w: 95, align: "right" }
      ]
    : [
        { key: "hsn", label: "HSN/SAC", x: L, w: 110, align: "left" },
        { key: "taxable", label: "Taxable\nValue", x: L + 110, w: 85, align: "right" },
        { key: "cRate", label: "Central Tax\nRate", x: L + 195, w: 50, align: "center" },
        { key: "cAmt", label: "Central Tax\nAmount", x: L + 245, w: 65, align: "right" },
        { key: "sRate", label: "State Tax\nRate", x: L + 310, w: 50, align: "center" },
        { key: "sAmt", label: "State Tax\nAmount", x: L + 360, w: 65, align: "right" },
        { key: "totalTax", label: "Total\nTax Amount", x: L + 425, w: 90, align: "right" }
      ];

  function drawTaxRowBorders(yy, h) {
    doc.moveTo(L, yy).lineTo(R, yy).lineWidth(0.5).stroke();
    taxCols.forEach(c => doc.moveTo(c.x, yy).lineTo(c.x, yy + h).stroke());
    doc.moveTo(R, yy).lineTo(R, yy + h).stroke();
  }

  const taxHeadH = 30;
  if (y + taxHeadH + 40 > doc.page.height - 60) { doc.addPage(); y = 50; }
  drawTaxRowBorders(y, taxHeadH);
  doc.font("Helvetica-Bold").fontSize(7);
  taxCols.forEach(c => doc.text(c.label, c.x + 3, y + 4, { width: c.w - 6, align: c.align }));
  y += taxHeadH;

  doc.font("Helvetica").fontSize(8);
  let sumTaxable = 0, sumTax = 0;

  Object.values(hsnSummary).forEach(s => {
    const label = supplyTypeLabel(s.supplyType);
    const rowTax = label ? 0 : s.taxable * (s.gstRate / 100);
    const rowH2 = 18;
    drawTaxRowBorders(y, rowH2);

    if (label) {
      // EXEMPT / NIL_RATED / ZERO_RATED — no GST breakup to show, so the
      // classification is printed spanning the rate/amount columns instead.
      doc.text(s.hsn, taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6 });
      doc.text(formatINR(s.taxable), taxCols[1].x + 3, y + 5, { width: taxCols[1].w - 6, align: "right" });
      const spanStart = taxCols[2].x;
      const spanEnd = taxCols[taxCols.length - 1].x + taxCols[taxCols.length - 1].w;
      doc.font("Helvetica-Oblique")
         .text(label, spanStart + 3, y + 5, { width: spanEnd - spanStart - 6, align: "center" });
      doc.font("Helvetica");
    } else if (isInter) {
      doc.text(s.hsn, taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6 });
      doc.text(formatINR(s.taxable), taxCols[1].x + 3, y + 5, { width: taxCols[1].w - 6, align: "right" });
      doc.text(`${s.gstRate}%`, taxCols[2].x + 3, y + 5, { width: taxCols[2].w - 6, align: "center" });
      doc.text(formatINR(rowTax), taxCols[3].x + 3, y + 5, { width: taxCols[3].w - 6, align: "right" });
      doc.text(formatINR(rowTax), taxCols[4].x + 3, y + 5, { width: taxCols[4].w - 6, align: "right" });
    } else {
      const half = rowTax / 2;
      doc.text(s.hsn, taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6 });
      doc.text(formatINR(s.taxable), taxCols[1].x + 3, y + 5, { width: taxCols[1].w - 6, align: "right" });
      doc.text(`${s.gstRate / 2}%`, taxCols[2].x + 3, y + 5, { width: taxCols[2].w - 6, align: "center" });
      doc.text(formatINR(half), taxCols[3].x + 3, y + 5, { width: taxCols[3].w - 6, align: "right" });
      doc.text(`${s.gstRate / 2}%`, taxCols[4].x + 3, y + 5, { width: taxCols[4].w - 6, align: "center" });
      doc.text(formatINR(half), taxCols[5].x + 3, y + 5, { width: taxCols[5].w - 6, align: "right" });
      doc.text(formatINR(rowTax), taxCols[6].x + 3, y + 5, { width: taxCols[6].w - 6, align: "right" });
    }

    sumTaxable += s.taxable;
    sumTax += rowTax;
    y += rowH2;
  });

  // Tax summary total row
  const taxTotalH = 18;
  drawTaxRowBorders(y, taxTotalH);
  doc.font("Helvetica-Bold").fontSize(8);
  doc.text("Total", taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6, align: "right" });
  doc.text(formatINR(sumTaxable), taxCols[1].x + 3, y + 5, { width: taxCols[1].w - 6, align: "right" });
  const lastCol = taxCols[taxCols.length - 1];
  doc.text(formatINR(sumTax), lastCol.x + 3, y + 5, { width: lastCol.w - 6, align: "right" });
  y += taxTotalH;

  // Tax amount in words
  const taxWordsH = 20;
  if (y + taxWordsH > doc.page.height - 60) { doc.addPage(); y = 50; }
  doc.font("Helvetica").fontSize(8).text("Tax Amount (in words) : ", L, y + 4, { continued: true });
  doc.font("Helvetica-Bold").text(amountInWords(sumTax));
  y += taxWordsH;

  // ---------- EXPORT DECLARATION (Rule 46) ----------
  // Mandatory statutory text on any invoice carrying a zero-rated
  // (export/SEZ under LUT) supply.
  if (hasZeroRatedLine(items)) {
    const exportDeclH = 22;
    if (y + exportDeclH > doc.page.height - 60) { doc.addPage(); y = 50; }
    doc.rect(L, y, W, exportDeclH).lineWidth(0.5).stroke();
    doc.font("Helvetica-Bold").fontSize(8.5)
       .text(EXPORT_DECLARATION_TEXT, L + 6, y + 6, { width: W - 12, align: "center" });
    doc.font("Helvetica");
    y += exportDeclH;
  }

  // ---------- DECLARATION / SIGNATORY ----------
  const declH = 60;
  if (y + declH > doc.page.height - 40) { doc.addPage(); y = 50; }
  const declW = W * 0.6;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).stroke();
  doc.moveTo(L, y).lineTo(L, y + declH).stroke();
  doc.moveTo(L + declW, y).lineTo(L + declW, y + declH).stroke();
  doc.moveTo(R, y).lineTo(R, y + declH).stroke();
  doc.moveTo(L, y + declH).lineTo(R, y + declH).stroke();

  doc.font("Helvetica").fontSize(8).text("Declaration", L + 6, y + 5);
  doc.fontSize(7.5).text(
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
    L + 6, y + 17, { width: declW - 12 }
  );

  // Seller signatory block
  if (seller && seller.name) {
    doc.font("Helvetica").fontSize(8)
       .text(`for ${seller.name}`, L + declW + 6, y + 5, { width: W - declW - 12, align: "center" });
  }
  doc.font("Helvetica").fontSize(8)
     .text("Authorised Signatory", L + declW + 6, y + declH - 16, { width: W - declW - 12, align: "center" });

  y += declH;

  // ---------- FOOTER ----------
  doc.font("Helvetica").fontSize(8).fillColor("#666")
     .text("This is a Computer Generated Invoice", L, y + 15, { width: W, align: "center" });
  doc.fillColor("black");
}

const INVOICE_TEMPLATE_RENDERERS = {
  classic: renderClassicTemplate,
  modern: renderModernTemplate,
  minimal: renderMinimalTemplate,
  gst_tabular: renderGstTabularTemplate
};

async function generateSalesInvoicePDF({ invoiceNo, date, customer, items, amount, gstBreakup, isInterState, grandTotal, template, seller, buyer }) {
  const dir = path.join(DATA_DIR, "invoices", "sales");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${invoiceNo}.pdf`);
  console.log("PDF directory:", dir);
  console.log("PDF file path:", filePath);

  // Use the template passed in, otherwise fall back to whatever is saved in Settings.
  const templateId = template || await getSetting("invoice_template", "classic");
  const renderer = INVOICE_TEMPLATE_RENDERERS[templateId] || renderClassicTemplate;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    renderer(doc, { invoiceNo, date, customer, items, amount, gstBreakup, isInterState, grandTotal, seller, buyer });

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

/* -------------------- PURCHASE INVOICE -------------------- */

function getNextPurchaseInvoiceNo(cb) {
  db.get(
    `
    SELECT MAX(
      CAST(SUBSTR(narration, INSTR(narration, 'PINV-') + 5) AS INTEGER)
    ) AS maxInv
    FROM journal_voucher
    WHERE narration LIKE 'Purchase Invoice PINV-%'
    `,
    [],
    (err, row) => {
      if (err) return cb(err);
      const next = (row?.maxInv || 0) + 1;
      cb(null, "PINV-" + String(next).padStart(4, "0"));
    }
  );
}

/* -------------------- PURCHASE ORDER (PO CYCLE) -------------------- */

function getNextPONo(cb) {
  db.get(
    `SELECT po_no FROM purchase_order ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "PO/0001");

      const lastNo = row.po_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `PO/${nextNo}`);
    }
  );
}

/* -------------------- DEBIT NOTE NUMBERING -------------------- */

function getNextDebitNoteNo(cb) {
  db.get(
    `SELECT note_no FROM debit_note ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "DN-0001");

      const lastNo = row.note_no.split("-")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `DN-${nextNo}`);
    }
  );
}

/* -------------------- CREDIT NOTE NUMBERING -------------------- */

function getNextCreditNoteNo(cb) {
  db.get(
    `SELECT note_no FROM credit_note ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "CN-0001");

      const lastNo = row.note_no.split("-")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `CN-${nextNo}`);
    }
  );
}

// Recomputes a PO's status from the qty/received_qty/invoiced_qty of its
// line items, and writes it back. Called after every receipt or invoice
// that touches the PO, so the register always reflects reality instead of
// a status flag someone forgot to flip.
function recomputePOStatus(poId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT qty, received_qty, invoiced_qty FROM purchase_order_items WHERE po_id = ?`,
      [poId],
      (err, rows) => {
        if (err) return reject(err);

        const totalQty = rows.reduce((s, r) => s + r.qty, 0);
        const totalReceived = rows.reduce((s, r) => s + r.received_qty, 0);
        const totalInvoiced = rows.reduce((s, r) => s + r.invoiced_qty, 0);

        let status;
        if (totalQty > 0 && totalInvoiced >= totalQty - 1e-6) status = "CLOSED";
        else if (totalInvoiced > 0) status = "PARTIALLY_INVOICED";
        else if (totalQty > 0 && totalReceived >= totalQty - 1e-6) status = "RECEIVED";
        else if (totalReceived > 0) status = "PARTIALLY_RECEIVED";
        else status = "OPEN";

        db.run(
          `UPDATE purchase_order SET status = ? WHERE id = ?`,
          [status, poId],
          err => (err ? reject(err) : resolve(status))
        );
      }
    );
  });
}

/* -------------------- SALES ORDER NUMBERING -------------------- */
// Mirrors getNextPONo exactly, just on the sales_order table (SO/0001, SO/0002...)
function getNextSONo(cb) {
  db.get(
    `SELECT so_no FROM sales_order ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "SO/0001");

      const lastNo = row.so_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `SO/${nextNo}`);
    }
  );
}

/* -------------------- DELIVERY CHALLAN NUMBERING -------------------- */
// Delivery challans get their own document series (DC/0001...) — unlike a
// GRN, a DC is handed to the transporter/customer as a standalone document,
// so it needs a number of its own rather than just borrowing the SO number.
function getNextDCNo(cb) {
  db.get(
    `SELECT dc_no FROM delivery_challan ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "DC/0001");

      const lastNo = row.dc_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `DC/${nextNo}`);
    }
  );
}

// Next stock transfer number (TRF/0001, TRF/0002...). Same pattern as
// getNextDCNo — a transfer is its own standalone document, not borrowed
// from another voucher's number, so it needs its own counter keyed off
// stock_transfer.transfer_no.
function getNextTransferNo(cb) {
  db.get(
    `SELECT transfer_no FROM stock_transfer ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "TRF/0001");

      const lastNo = row.transfer_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `TRF/${nextNo}`);
    }
  );
}

// Next BOM number (BOM/0001, BOM/0002...). One bom_no per FG item, shared
// across every version of that item's BOM (see the bom table comment
// below) — so this only gets called when creating version 1 for an FG
// that has no BOM yet. A new version of an existing BOM (Step 2/3) reuses
// the parent version's bom_no directly instead of calling this.
function getNextBOMNo(cb) {
  db.get(
    `SELECT bom_no FROM bom ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "BOM/0001");

      const lastNo = row.bom_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `BOM/${nextNo}`);
    }
  );
}

// Next Work Order number (WO/0001, WO/0002...). Same pattern as
// getNextBOMNo/getNextTransferNo — its own counter keyed off
// work_order.wo_no, since a WO is its own standalone voucher.
function getNextWONo(cb) {
  db.get(
    `SELECT wo_no FROM work_order ORDER BY id DESC LIMIT 1`,
    [],
    (err, row) => {
      if (err) return cb(err);
      if (!row) return cb(null, "WO/0001");

      const lastNo = row.wo_no.split("/")[1];
      const nextNo = String(Number(lastNo) + 1).padStart(4, "0");

      cb(null, `WO/${nextNo}`);
    }
  );
}

// Recomputes a Sales Order's status from the qty/delivered_qty/invoiced_qty
// of its line items, and writes it back — same shape as recomputePOStatus.
// invoiced_qty is carried on sales_order_items ready for when Sales Invoice
// is wired to consume against a SO/DC (mirroring how purchase_invoice draws
// down purchase_order_items today); until then it just stays at 0.
function recomputeSOStatus(soId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT qty, delivered_qty, invoiced_qty FROM sales_order_items WHERE so_id = ?`,
      [soId],
      (err, rows) => {
        if (err) return reject(err);

        const totalQty = rows.reduce((s, r) => s + r.qty, 0);
        const totalDelivered = rows.reduce((s, r) => s + r.delivered_qty, 0);
        const totalInvoiced = rows.reduce((s, r) => s + r.invoiced_qty, 0);

        let status;
        if (totalQty > 0 && totalInvoiced >= totalQty - 1e-6) status = "CLOSED";
        else if (totalInvoiced > 0) status = "PARTIALLY_INVOICED";
        else if (totalQty > 0 && totalDelivered >= totalQty - 1e-6) status = "DELIVERED";
        else if (totalDelivered > 0) status = "PARTIALLY_DELIVERED";
        else status = "OPEN";

        db.run(
          `UPDATE sales_order SET status = ? WHERE id = ?`,
          [status, soId],
          err => (err ? reject(err) : resolve(status))
        );
      }
    );
  });
}


/* -------------------- DATABASE -------------------- */

// DATA_DIR lets you point the database (and invoices) at a Railway Volume
// mount so data survives redeploys. Defaults to the backend folder itself.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(
  path.join(DATA_DIR, "accounts.db"),
  err => {
    if (err) console.error("DB Error:", err.message);
    else console.log("Database connected");
  }
);

console.log("USING DB FILE:", path.join(DATA_DIR, "accounts.db"));

/* Enforce constraints */
db.run("PRAGMA foreign_keys = ON");

/* -------------------- TABLES -------------------- */

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ledger_group_master (
      group_name TEXT PRIMARY KEY,
      nature TEXT CHECK(nature IN ('ASSET','LIABILITY','INCOME','EXPENSE')) NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ledger_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger TEXT UNIQUE NOT NULL,
      ledger_group TEXT NOT NULL,
      is_system INTEGER DEFAULT 0,
      FOREIGN KEY (ledger_group) REFERENCES ledger_group_master(group_name)
    )
  `);

  function seedSystemLedgers() {
    db.run(`
      INSERT OR IGNORE INTO ledger_master
      (ledger, ledger_group, is_system)
      VALUES
      ('Capital A/c','Capital Account',1),

      ('Sales A/c','Direct Income',1),
      ('Purchases A/c','Direct Expense',1),

      ('Opening Stock','Current Assets',1),
      ('Closing Stock','Current Assets',1),
      ('Stock Adjustment','Direct Expense',1),

      ('Input IGST','Duties & Taxes - Input',1),
      ('Input CGST','Duties & Taxes - Input',1),
      ('Input SGST','Duties & Taxes - Input',1),

      ('Output IGST','Duties & Taxes - Output',1),
      ('Output CGST','Duties & Taxes - Output',1),
      ('Output SGST','Duties & Taxes - Output',1),

      ('Cash A/c','Cash & Bank',1),
      ('Bank A/c','Cash & Bank',1),

      -- Fixed Asset Management (FAM Step 2): one asset ledger per starter
      -- category (matches the category set asset_category_master is seeded
      -- with below), plus the three ledgers the depreciation/disposal
      -- postings in later steps (7 & 8) will debit/credit. Accumulated
      -- Depreciation is deliberately its own ledger under its own group
      -- (see 'Accumulated Depreciation' group below) rather than folded
      -- into 'Fixed Assets', since it's a contra-asset that must net
      -- against the gross asset cost on the Balance Sheet, not add to it.
      ('Plant & Machinery A/c','Fixed Assets',1),
      ('Furniture & Fixtures A/c','Fixed Assets',1),
      ('Vehicles A/c','Fixed Assets',1),
      ('Computers A/c','Fixed Assets',1),
      ('Buildings A/c','Fixed Assets',1),

      ('Accumulated Depreciation A/c','Accumulated Depreciation',1),
      ('Depreciation A/c','Indirect Expense',1),
      ('Profit on Sale of Asset A/c','Indirect Income',1),
      ('Loss on Sale of Asset A/c','Indirect Expense',1)
    `);
  }

  db.run(
    `
    INSERT OR IGNORE INTO ledger_group_master (group_name, nature) VALUES
    ('Capital Account','LIABILITY'),
    ('Current Liabilities','LIABILITY'),
    ('Loans','LIABILITY'),
    ('Sundry Debtors','ASSET'),
    ('Sundry Creditors','LIABILITY'),
    ('Fixed Assets','ASSET'),
    ('Current Assets','ASSET'),
    ('Direct Income','INCOME'),
    ('Indirect Income','INCOME'),
    ('Direct Expense','EXPENSE'),
    ('Indirect Expense','EXPENSE'),
    ('Duties & Taxes - Input','ASSET'),
    ('Duties & Taxes - Output','LIABILITY'),
    ('Cash & Bank','ASSET'),
    ('Accumulated Depreciation','ASSET')
    `,
    err => {
      if (err) {
        console.error("GROUP INSERT ERROR:", err.message);
      } else {
        console.log("Ledger groups ensured");
      }
      // Queued right after the groups insert (same connection, same tick)
      // so ledger_master's FK reference always finds its groups, whether
      // this is a brand-new database or an existing one being upgraded.
      seedSystemLedgers();
    }
  );



  db.run(`
    CREATE TABLE IF NOT EXISTS journal_voucher (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      voucher_no TEXT NOT NULL,
      narration TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id INTEGER NOT NULL,
      ledger TEXT NOT NULL,
      lf TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      FOREIGN KEY (voucher_id) REFERENCES journal_voucher(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger TEXT NOT NULL,
      date TEXT,
      voucher_no TEXT,
      narration TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS item_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT UNIQUE,
      item_name TEXT NOT NULL,
      hsn TEXT,
      unit TEXT NOT NULL,
      gst_rate REAL NOT NULL,
      selling_price REAL,
      opening_qty REAL DEFAULT 0,
      opening_rate REAL DEFAULT 0
    )
  `);
  
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_name
    ON item_master(item_name)
  `);

  // supply_type: the item's DEFAULT GST classification — 'TAXABLE'
  // (normal rated supply, the historical/only behaviour), 'EXEMPT'
  // (exempt supply under a notification, GSTR-1 Table 8), 'NIL_RATED'
  // (nil-rated goods/services, also Table 8), or 'ZERO_RATED' (export/SEZ
  // supply, GSTR-1 Table 6A). This is only the item's default — the
  // actual classification that gets billed is decided per invoice line
  // (see sales_invoice_items.supply_type below), since the same item can
  // be sold domestically most of the time and exported occasionally.
  // Stored as plain TEXT rather than a CHECK constraint (ALTER TABLE
  // ADD COLUMN + CHECK is version-fragile in SQLite); validity is
  // enforced in the API layer instead, same as GSTIN format elsewhere.
  db.run(`ALTER TABLE item_master ADD COLUMN supply_type TEXT DEFAULT 'TAXABLE'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master ERROR:", err.message);
    }
  });

  // item_type: see the VALID_ITEM_TYPES comment above for what each value
  // means. Defaults every EXISTING row to FINISHED_GOOD on first migration —
  // that matches this app's original trading-item usage and is safe, but it
  // is a blanket default, not a real classification. Run the backfill
  // query (Phase 1, Step 3) afterwards to reclassify items that are
  // actually raw materials based on their purchase/sale history, before
  // relying on this field anywhere else (BOM pickers, etc).
  db.run(`ALTER TABLE item_master ADD COLUMN item_type TEXT DEFAULT 'FINISHED_GOOD'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master (item_type) ERROR:", err.message);
    }
  });

  // secondary_unit / conversion_factor: support items purchased/stocked in
  // one UQC but transacted in another (e.g. purchased by the BOX, consumed
  // by the NOS). conversion_factor is "how many primary `unit`s make one
  // secondary_unit" (e.g. unit=NOS, secondary_unit=BOX, conversion_factor=12
  // means 1 BOX = 12 NOS). NULL/0 means no secondary unit is configured —
  // callers must treat that as "primary unit only", not divide by zero.
  db.run(`ALTER TABLE item_master ADD COLUMN secondary_unit TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master (secondary_unit) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE item_master ADD COLUMN conversion_factor REAL`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master (conversion_factor) ERROR:", err.message);
    }
  });

  // reorder_level / reorder_qty (Scrap & Reorder Alerts, Step 1): the
  // low-stock threshold and suggested replenishment qty for this item.
  // Both default to 0 rather than NULL — same "safe blanket default"
  // reasoning as item_type above — so every existing item starts with
  // alerts effectively OFF (0 means "never flag this item as low") instead
  // of every item suddenly showing up on a low-stock dashboard the moment
  // this column exists. There's no separate "enabled" flag; a positive
  // reorder_level is what turns the alert on for that item, checked
  // against current balance by the low-stock report (Step 8) the same way
  // every other stock computation in this app already sums
  // qty_in - qty_out from stock_ledger — reorder_level/qty themselves are
  // just static thresholds on item_master, not stock movements.
  db.run(`ALTER TABLE item_master ADD COLUMN reorder_level REAL DEFAULT 0`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master (reorder_level) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE item_master ADD COLUMN reorder_qty REAL DEFAULT 0`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER item_master (reorder_qty) ERROR:", err.message);
    }
  });

  // locations: the warehouse/location dimension (Phase 2, Step 1). Every
  // stock movement will eventually be tied to one of these via
  // stock_ledger.location_id (Step 2 below). location_type is a loose
  // classifier ('STORE' / 'SHOP_FLOOR' / 'QC' / 'OTHER') used for filtering
  // in dropdowns — not a CHECK constraint, validated in the API layer,
  // same convention as item_master.supply_type / item_type above.
  db.run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_name TEXT UNIQUE NOT NULL,
      location_type TEXT DEFAULT 'STORE',
      is_active INTEGER DEFAULT 1
    )
  `);

  // Seed a sensible default set of locations on first run. INSERT OR IGNORE
  // means this is safe to re-run on every boot — it only inserts rows that
  // don't already exist (by location_name, which is UNIQUE), so a user who
  // has renamed/deleted one of these won't have it silently reappear...
  // except that a delete would just let it be re-seeded, which is fine for
  // now since Step 6/7 (locations CRUD, stock transfer) will introduce a
  // real deactivate flow instead of hard deletes.
  //
  // 'Scrap' (Scrap & Reorder Alerts, Step 2): where scrap/rejection
  // postings (Step 3's /work-order/:id/scrap) land. Modeled as a real
  // location rather than a straight write-off/delete from stock_ledger —
  // same reasoning as QC Hold — so scrapped qty stays valued, reportable,
  // and auditable (via the Item Wise Report, a future Scrap Register,
  // etc.) instead of just vanishing from the books. location_type 'SCRAP'
  // is its own classifier (not reused from item_master's SCRAP item_type,
  // a separate concept — a location scrap material sits at, vs. an item
  // classification for byproducts that get bought/sold/tracked as stock).
  db.run(`
    INSERT OR IGNORE INTO locations (location_name, location_type) VALUES
      ('RM Store', 'STORE'),
      ('Shop Floor', 'SHOP_FLOOR'),
      ('FG Store', 'STORE'),
      ('QC Hold', 'QC'),
      ('Scrap', 'SCRAP')
  `, err => {
    if (err) console.error("SEED locations ERROR:", err.message);
  });

  // wo_scrap (Scrap & Reorder Alerts, Step 3) — one header row per scrap/
  // rejection posting made against a Work Order via POST
  // /work-order/:id/scrap, alongside the stock_ledger movement(s) that
  // same call writes. Same "own header table next to the stock_ledger
  // postings it drives" shape as stock_transfer: stock_ledger is still the
  // source of truth for balances (this is what actually moves value into
  // the Scrap location), but a scrap call can fan out into several
  // stock_ledger row-pairs — one per FEFO-allocated batch — and qty/rate
  // here are the single total/rate the user actually entered on the Scrap
  // panel (Step 4), not any one batch's slice of it. Keeping one row per
  // call (not per batch) is what lets Step 5's history endpoint sum
  // "qty + value scrapped, per item" directly off this table instead of
  // re-deriving it from raw stock_ledger SCRAP rows.
  //
  // wo_no is denormalized alongside wo_id purely so a future scrap
  // register/report can list postings without joining back through
  // work_order, same reasoning stock_transfer/batch_genealogy already use
  // for their own denormalized number/wo_no columns. narration doubles as
  // the "reason" field the Scrap panel collects.
  db.run(`
    CREATE TABLE IF NOT EXISTS wo_scrap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wo_id INTEGER NOT NULL,
      wo_no TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      qty REAL NOT NULL,
      rate REAL DEFAULT 0,
      date TEXT NOT NULL,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wo_id) REFERENCES work_order(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      voucher_type TEXT,
      voucher_no TEXT,
      qty_in REAL DEFAULT 0,
      qty_out REAL DEFAULT 0,
      rate REAL,
      location_id INTEGER REFERENCES locations(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  // location_id on stock_ledger: added via ALTER TABLE (not just in the
  // CREATE TABLE above) so this also lands on existing databases where
  // stock_ledger already exists without the column — same duplicate-column
  // -safe pattern used for item_master's Phase 1 columns above. Nullable
  // for now; existing rows stay NULL until the Step 3 backfill script
  // assigns them a location, and callers (Step 4) must not assume
  // location_id is always set until that backfill has run.
  db.run(`ALTER TABLE stock_ledger ADD COLUMN location_id INTEGER REFERENCES locations(id)`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER stock_ledger (location_id) ERROR:", err.message);
    }
  });

  // batch_no / expiry_date on stock_ledger (Batch Tracking, Step 1). Same
  // duplicate-column-safe ALTER TABLE pattern as location_id above, so this
  // lands on existing databases too. Both nullable — existing rows and any
  // voucher type that never sets a batch (e.g. Delivery Challan, Stock
  // Transfer for non-batched items) stay NULL, so nothing downstream can
  // assume a batch is always present. Populated starting with GRN receipt
  // (Step 3) and carried forward from there (WO issue, WO complete, etc.)
  // by later steps.
  db.run(`ALTER TABLE stock_ledger ADD COLUMN batch_no TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER stock_ledger (batch_no) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE stock_ledger ADD COLUMN expiry_date TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER stock_ledger (expiry_date) ERROR:", err.message);
    }
  });

  /* batch_genealogy (Batch Tracking, Step 8) — one row per (fg_batch_no,
     component_batch_no) pair consumed into a completed FG batch. Written
     alongside the FG's qty_in row in /work-order/:id/complete: for every
     component batch WO_COMPLETE's FEFO allocation (Step 7) actually drew
     qty_out from, this records how much of THAT component batch fed into
     THIS fg_batch_no.

     This is the "full forward/backward traceability across multiple WOs
     per FG batch" option flagged in the Step 8 spec, chosen over inferring
     it later by re-querying stock_ledger — a genealogy table survives even
     if a later phase reworks how WO_COMPLETE rows are shaped, and answers
     both directions directly: "what went into fg batch X" (filter by
     fg_batch_no) and "which FG batches did component batch Y end up in"
     (filter by component_batch_no) without reconstructing WO_ISSUE/
     WO_COMPLETE joins each time.

     component_batch_no is nullable — a component consumed from un-batched
     stock (batch_no IS NULL on its WO_COMPLETE qty_out row) still produces
     a genealogy row, just with no batch identity on the component side, so
     "what fed into this FG batch" stays a complete picture even when some
     inputs predate batch tracking. wo_no is denormalized onto the row
     (rather than requiring a join back through work_order) purely so
     genealogy queries don't need to touch work_order at all. */
  db.run(`
    CREATE TABLE IF NOT EXISTS batch_genealogy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fg_item_id INTEGER NOT NULL,
      fg_batch_no TEXT NOT NULL,
      component_item_id INTEGER NOT NULL,
      component_batch_no TEXT,
      qty REAL NOT NULL,
      wo_no TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fg_item_id) REFERENCES item_master(id),
      FOREIGN KEY (component_item_id) REFERENCES item_master(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      supplier TEXT NOT NULL,
      tax_type TEXT DEFAULT 'INTRA',
      status TEXT DEFAULT 'OPEN',
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      qty REAL NOT NULL,
      rate REAL NOT NULL,
      gst_rate REAL DEFAULT 0,
      received_qty REAL DEFAULT 0,
      invoiced_qty REAL DEFAULT 0,
      FOREIGN KEY (po_id) REFERENCES purchase_order(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  /* Bill of Materials (Phase 3, Step 1) — bom is versioned per FG item:
     every edit to an ACTIVE BOM creates a NEW row (version = prevVersion+1)
     rather than mutating the existing one, so a completed work order or a
     historical cost rollup always points at the exact component list that
     was active when it ran. All versions of one FG's BOM share the same
     bom_no (assigned once, at version 1 — see getNextBOMNo) and are tied
     together by fg_item_id; the "current" one for any purpose is whichever
     row has status = 'ACTIVE' for that fg_item_id (Step 2's resolveActiveBOM
     helper, Step 3's /bom/:id/activate endpoint).

     status is a loose TEXT classifier ('DRAFT' / 'ACTIVE' / 'OBSOLETE'),
     validated in the API layer — same convention as item_master.item_type
     and locations.location_type, not a CHECK constraint (ALTER TABLE ADD
     COLUMN + CHECK is version-fragile in SQLite, per the item_type comment
     above). Enforcing "only one ACTIVE version per fg_item_id" is also an
     API-layer job (the /bom/:id/activate transaction), not a DB constraint,
     since SQLite has no partial-unique-index-via-CHECK equivalent that's
     safe to add via ALTER TABLE either.

     effective_date is when this version is/was meant to take over — distinct
     from created_at (when the row was saved), since a DRAFT can be authored
     well ahead of the date it should go live. */
  db.run(`
    CREATE TABLE IF NOT EXISTS bom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_no TEXT NOT NULL,
      fg_item_id INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT 'DRAFT',
      effective_date TEXT,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fg_item_id) REFERENCES item_master(id)
    )
  `);

  // One row per component line. qty_per_unit is "how much of this component
  // goes into ONE unit of the FG" — deliberately NOT a rate/cost column;
  // the cost rollup (Step 5) always prices this qty against the component's
  // CURRENT rate at rollup time, it never freezes a rate into the BOM
  // itself. That's what keeps "view BOM cost" a live standard-costing
  // view instead of a stale snapshot from whenever the line was drawn.
  //
  // unit is stored per-line (not just inherited from item_master.unit) so
  // a BOM can be authored in a different UQC than the component's primary
  // one — e.g. component stocked in NOS but consumed by the METER — without
  // forcing every item_master row to carry a secondary_unit for it. No
  // conversion is applied automatically; that's a deliberate scope cut for
  // Step 1, flagged again when the cost rollup (Step 5) is built.
  db.run(`
    CREATE TABLE IF NOT EXISTS bom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id INTEGER NOT NULL,
      component_item_id INTEGER NOT NULL,
      qty_per_unit REAL NOT NULL,
      unit TEXT,
      narration TEXT,
      FOREIGN KEY (bom_id) REFERENCES bom(id),
      FOREIGN KEY (component_item_id) REFERENCES item_master(id)
    )
  `);

  /* Work Order (Production Phase, Step 1) — the production voucher that
     turns a BOM into an actual run: pick an FG, a target qty, and this
     explodes the FG's ACTIVE BOM (Step 2's explodeBOMForQuantity) into a
     frozen component snapshot (work_order_components, below) at creation
     time. bom_id + bom_version are recorded on the header purely for
     traceability — "this WO was built against BOM version N" — the WO
     itself never looks back at bom_items again after creation.

     status is DRAFT / ISSUED / COMPLETED / CANCELLED, loose TEXT validated
     in the API layer — same convention as bom.status and
     locations.location_type, not a CHECK constraint.

     issue_location_id / receive_location_id default to RM Store / FG Store
     respectively (resolved via resolveLocationId at the API layer, same as
     Stock Transfer) but are stored per-WO since a run could issue from or
     receive into a non-default location. */
  db.run(`
    CREATE TABLE IF NOT EXISTS work_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wo_no TEXT UNIQUE NOT NULL,
      fg_item_id INTEGER NOT NULL,
      bom_id INTEGER NOT NULL,
      bom_version INTEGER NOT NULL,
      target_qty REAL NOT NULL,
      issue_location_id INTEGER REFERENCES locations(id),
      receive_location_id INTEGER REFERENCES locations(id),
      status TEXT DEFAULT 'DRAFT',
      date TEXT NOT NULL,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fg_item_id) REFERENCES item_master(id),
      FOREIGN KEY (bom_id) REFERENCES bom(id)
    )
  `);

  // One row per exploded component line, frozen at WO creation time —
  // qty_per_unit is COPIED from the bom_items row of the BOM version used
  // (not a live reference back to bom_items), and required_qty is that
  // qty_per_unit × target_qty, computed once at creation. This is
  // deliberately the same "snapshot at creation, track fulfillment against
  // the snapshot" shape as purchase_order_items.rate/received_qty: later
  // edits to the underlying BOM must never move this WO's requirement out
  // from under it.
  //
  // issued_qty accumulates via Step 4's partial-issue endpoint (same
  // pending = qty - received_qty shape as GRN against a PO). unit is
  // copied from the bom_items line for the same reason bom_items.unit
  // exists — the WO can be worked in a different UQC than the component's
  // primary unit without back-referencing item_master.
  db.run(`
    CREATE TABLE IF NOT EXISTS work_order_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wo_id INTEGER NOT NULL,
      component_item_id INTEGER NOT NULL,
      qty_per_unit REAL NOT NULL,
      required_qty REAL NOT NULL,
      issued_qty REAL DEFAULT 0,
      unit TEXT,
      narration TEXT,
      FOREIGN KEY (wo_id) REFERENCES work_order(id),
      FOREIGN KEY (component_item_id) REFERENCES item_master(id)
    )
  `);

  // completed_qty (Production Phase, Step 6): cumulative FG qty completed
  // against this WO so far, same "accumulates across repeat calls" shape
  // as work_order_components.issued_qty. Added via ALTER TABLE rather than
  // in the CREATE TABLE above since work_order already shipped without it
  // (Steps 1-4) — same "ALTER TABLE ADD COLUMN, ignore duplicate-column on
  // re-run" convention used everywhere else in this file. Status flips
  // DRAFT/ISSUED -> COMPLETED once this reaches target_qty (Step 6's
  // /work-order/:id/complete).
  db.run(`ALTER TABLE work_order ADD COLUMN completed_qty REAL DEFAULT 0`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER work_order (completed_qty) ERROR:", err.message);
    }
  });

  // completion_seq (Batch Tracking, Step 8): counts how many *successful*
  // /work-order/:id/complete calls have been made against this WO so far —
  // separate from completed_qty (which tracks cumulative FG QTY, not call
  // count), because one WO can complete in several partial calls and each
  // call needs its own distinct FG batch number even if two calls happen to
  // complete the same qty. fg_batch_no is built as `${wo_no}-B${seq}` at
  // write time (see /work-order/:id/complete), so seq must be reserved by
  // incrementing this counter in the same transaction that posts the FG
  // qty_in row — never derived by counting existing stock_ledger rows,
  // which would double-count if a completion is ever reversed/reissued
  // later. Same ALTER TABLE ADD COLUMN + ignore-duplicate-column pattern as
  // completed_qty above.
  db.run(`ALTER TABLE work_order ADD COLUMN completion_seq INTEGER DEFAULT 0`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER work_order (completion_seq) ERROR:", err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      gstin TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* Supplier master — mirrors "clients" exactly, just for the purchase
     side. Previously suppliers were nothing more than a free-text ledger
     name (auto-created in ledger_master on first purchase), with no GSTIN
     on file anywhere. That meant CGST+SGST vs IGST on every purchase,
     purchase order, and debit note had to be picked by hand from a
     dropdown — the exact mistake-prone situation Sales already solved by
     comparing GSTINs. This table lets purchases do the same thing. */
  db.run(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      gstin TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // purchase_order already exists by this point in the file, so its
  // supplier_id column can be added right away. purchase_invoice and
  // debit_note are created further down, so their ALTERs are queued
  // right after those CREATE TABLEs instead (db.serialize keeps
  // everything running in the order queued).
  db.run(`ALTER TABLE purchase_order ADD COLUMN supplier_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_order ERROR:", err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS sales_invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE,
      date TEXT,
      customer TEXT,
      client_id INTEGER,
      taxable_value REAL,
      cgst REAL,
      sgst REAL,
      igst REAL,
      total_amount REAL
    )
  `);

  // sales_invoice may already exist from before client_id was introduced.
  // ALTER TABLE ADD COLUMN has no "IF NOT EXISTS" in SQLite, so just try it
  // and ignore the "duplicate column" error on databases that already have it.
  db.run(`ALTER TABLE sales_invoice ADD COLUMN client_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER sales_invoice ERROR:", err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS sales_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      item_id INTEGER,
      description TEXT,
      hsn TEXT,
      qty REAL,
      rate REAL,
      taxable REAL,
      gst_rate REAL,
      gst_amount REAL,
      total REAL,
      FOREIGN KEY (invoice_id) REFERENCES sales_invoice(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  // supply_type on the LINE, not just the item: what actually got billed
  // on this specific invoice. Defaults to 'TAXABLE' so every historical
  // row (billed before this column existed) is correctly treated as a
  // normal taxable supply rather than silently becoming "unclassified".
  db.run(`ALTER TABLE sales_invoice_items ADD COLUMN supply_type TEXT DEFAULT 'TAXABLE'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER sales_invoice_items ERROR:", err.message);
    }
  });

  /* Purchase invoice header/lines — mirrors sales_invoice/sales_invoice_items.
     Previously purchases only existed as a journal voucher + narration
     string, with no first-class record to hang a payment/outstanding
     balance off of. */
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      supplier TEXT NOT NULL,
      po_id INTEGER,
      taxable_value REAL DEFAULT 0,
      cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0,
      igst REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (po_id) REFERENCES purchase_order(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      item_id INTEGER,
      item_name TEXT,
      qty REAL,
      rate REAL,
      taxable REAL,
      gst_rate REAL,
      gst_amount REAL,
      total REAL,
      FOREIGN KEY (invoice_id) REFERENCES purchase_invoice(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  // itc_category: what KIND of purchase this line is, for GSTR-3B Table 4(A)
  // (Eligible ITC) row selection — 'IMPORT_GOODS' (row 1), 'IMPORT_SERVICES'
  // (row 2), 'RCM' (reverse-charge inward supply, row 3 — also drives
  // Table 3.1(d), see computeRCMLiability), 'ISD' (Input Service Distributor
  // credit, row 4), or 'OTHER' (row 5, everything else — the default, since
  // the overwhelming majority of purchases are ordinary domestic buys with
  // forward-charge GST already on the supplier's invoice). Nothing in this
  // system currently distinguishes these cases, so every historical row
  // defaults to 'OTHER' and is treated as a normal purchase, same as before
  // this column existed. Plain TEXT rather than a CHECK constraint, same
  // reasoning as item_master.supply_type above (ALTER TABLE ADD COLUMN +
  // CHECK is version-fragile in SQLite); validity is enforced in the API
  // layer instead.
  db.run(`ALTER TABLE purchase_invoice_items ADD COLUMN itc_category TEXT DEFAULT 'OTHER'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_invoice_items (itc_category) ERROR:", err.message);
    }
  });

  // itc_eligible: whether ITC on this line can actually be claimed, for
  // GSTR-3B Table 4(D) (Ineligible ITC) — 'ELIGIBLE' (the default: normal
  // creditable purchase, nothing to report in 4(D)), 'INELIGIBLE_17_5'
  // (blocked credit under Sec 17(5) — motor vehicles, food & beverages,
  // club memberships, etc. — Table 4(D)(1)), or 'INELIGIBLE_OTHER' (any
  // other reason ITC isn't being claimed — Table 4(D)(2)). Defaults to
  // 'ELIGIBLE' so historical rows keep contributing to Table 4(A) exactly
  // as they always have; nothing here retroactively blocks credit nobody
  // flagged as blocked. Same TEXT-not-CHECK reasoning as itc_category above.
  db.run(`ALTER TABLE purchase_invoice_items ADD COLUMN itc_eligible TEXT DEFAULT 'ELIGIBLE'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_invoice_items (itc_eligible) ERROR:", err.message);
    }
  });

  // rcm_applicable: 0/1 flag — is GST on this purchase self-assessed by us
  // under reverse charge (Sec 9(3)/9(4)) rather than charged by the
  // supplier? Defaults to 0 (normal forward-charge purchase, i.e. today's
  // only behaviour) so nothing already in the system is retroactively
  // treated as RCM. This is intentionally a separate flag from
  // itc_category='RCM' rather than folded into it: itc_category decides
  // which row of Table 4(A) the ITC lands in, rcm_applicable decides
  // whether computeRCMLiability(month) picks the line up at all for
  // Table 3.1(d) — keeping them independent means a line can be flagged
  // rcm_applicable=1 before itc_category classification is even filled in,
  // without the two ever silently disagreeing with each other.
  db.run(`ALTER TABLE purchase_invoice_items ADD COLUMN rcm_applicable INTEGER DEFAULT 0`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_invoice_items (rcm_applicable) ERROR:", err.message);
    }
  });

  // purchase_invoice may already exist from before supplier_id was
  // introduced — same retrofit pattern as sales_invoice.client_id above.
  db.run(`ALTER TABLE purchase_invoice ADD COLUMN supplier_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_invoice ERROR:", err.message);
    }
  });

  /* Purchase Debit Note — issued BY US TO A SUPPLIER, either against a
     specific purchase_invoice (goods return / overcharge on a known bill)
     or standalone against a supplier with no invoice reference at all
     (e.g. a rate-difference credit the supplier has agreed to before any
     bill exists). purchase_invoice_id is therefore nullable by design. */
  db.run(`
    CREATE TABLE IF NOT EXISTS debit_note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      supplier TEXT NOT NULL,
      purchase_invoice_id INTEGER,
      reason TEXT,
      adjusts_stock INTEGER DEFAULT 1,
      taxable_value REAL DEFAULT 0,
      cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0,
      igst REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoice(id)
    )
  `);

  // debit_note may already exist from before supplier_id was introduced.
  db.run(`ALTER TABLE debit_note ADD COLUMN supplier_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER debit_note ERROR:", err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS debit_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER,
      item_id INTEGER,
      invoice_item_id INTEGER,
      item_name TEXT,
      qty REAL,
      rate REAL,
      taxable REAL,
      gst_rate REAL,
      gst_amount REAL,
      total REAL,
      FOREIGN KEY (note_id) REFERENCES debit_note(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id),
      FOREIGN KEY (invoice_item_id) REFERENCES purchase_invoice_items(id)
    )
  `);

  /* Sales Credit Note — issued BY US TO A CUSTOMER, either against a
     specific sales_invoice (goods return / overcharge on a known bill)
     or standalone against a customer with no invoice reference at all
     (e.g. a rate-difference credit agreed before any bill exists).
     sales_invoice_id is therefore nullable by design. Mirrors debit_note
     exactly, just from the sales side. */
  db.run(`
    CREATE TABLE IF NOT EXISTS credit_note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      customer TEXT NOT NULL,
      sales_invoice_id INTEGER,
      reason TEXT,
      adjusts_stock INTEGER DEFAULT 1,
      taxable_value REAL DEFAULT 0,
      cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0,
      igst REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sales_invoice_id) REFERENCES sales_invoice(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS credit_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER,
      item_id INTEGER,
      invoice_item_id INTEGER,
      item_name TEXT,
      qty REAL,
      rate REAL,
      taxable REAL,
      gst_rate REAL,
      gst_amount REAL,
      total REAL,
      FOREIGN KEY (note_id) REFERENCES credit_note(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id),
      FOREIGN KEY (invoice_item_id) REFERENCES sales_invoice_items(id)
    )
  `);

  // supply_type here should normally just mirror whatever the original
  // sales_invoice_items line it's crediting was classified as (Step 4
  // wires that lookup up) — this column and default just make sure a
  // credit note is never silently treated as taxable-by-default if that
  // lookup is ever skipped (e.g. a standalone credit note with no
  // invoice_item_id reference at all).
  db.run(`ALTER TABLE credit_note_items ADD COLUMN supply_type TEXT DEFAULT 'TAXABLE'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER credit_note_items ERROR:", err.message);
    }
  });

  /* Sales Order — mirrors purchase_order exactly, just from the sales side.
     Stock does NOT move here; it moves at the Delivery Challan stage. */
  db.run(`
    CREATE TABLE IF NOT EXISTS sales_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      so_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      customer TEXT NOT NULL,
      client_id INTEGER,
      tax_type TEXT DEFAULT 'INTRA',
      status TEXT DEFAULT 'OPEN',
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sales_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      so_id INTEGER NOT NULL,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      qty REAL NOT NULL,
      rate REAL NOT NULL,
      gst_rate REAL DEFAULT 0,
      delivered_qty REAL DEFAULT 0,
      invoiced_qty REAL DEFAULT 0,
      FOREIGN KEY (so_id) REFERENCES sales_order(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  /* Delivery Challan (DC) — record physical dispatch of goods against a
     Sales Order. This is the step that actually moves stock (qty_out);
     dispatch can be partial and repeated across multiple challans, same
     as Goods Receipt on the purchase side. Unlike a GRN, a DC is itself a
     document handed to the transporter/customer, so — like debit/credit
     notes — it gets its own header/items tables and document number
     rather than just updating the order in place. */
  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_challan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dc_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      customer TEXT NOT NULL,
      so_id INTEGER NOT NULL,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (so_id) REFERENCES sales_order(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dc_id INTEGER NOT NULL,
      so_item_id INTEGER NOT NULL,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      qty REAL NOT NULL,
      rate REAL,
      gst_rate REAL DEFAULT 0,
      FOREIGN KEY (dc_id) REFERENCES delivery_challan(id),
      FOREIGN KEY (so_item_id) REFERENCES sales_order_items(id),
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

  /* Payment / Receipt vouchers, and the allocation of each one across the
     specific sales/purchase invoices it settles. Outstanding balance for
     any invoice = its total_amount minus SUM(allocated_amount) here. */
  /* Stock Transfer (Phase 2, Step 7) — moves qty of a single item from one
     location to another (e.g. Shop Floor → FG Store after production).
     Unlike GRN/DC, a transfer isn't tied to a PO/SO — it's a standalone
     voucher, so it gets its own number (transfer_no) like debit/credit
     notes do. Deliberately one item per transfer row (not a header+items
     pair like PO/SO) since the source doc (Step_1-10) calls this out as
     "single-item-line" — a transfer is one item moving between two
     locations, not a multi-line document. */
  db.run(`
    CREATE TABLE IF NOT EXISTS stock_transfer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_no TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      qty REAL NOT NULL,
      from_location_id INTEGER NOT NULL,
      to_location_id INTEGER NOT NULL,
      rate REAL,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES item_master(id),
      FOREIGN KEY (from_location_id) REFERENCES locations(id),
      FOREIGN KEY (to_location_id) REFERENCES locations(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_voucher (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_no TEXT UNIQUE NOT NULL,
      type TEXT CHECK(type IN ('PAYMENT','RECEIPT')) NOT NULL,
      date TEXT NOT NULL,
      party TEXT NOT NULL,
      mode_ledger TEXT NOT NULL,
      amount REAL NOT NULL,
      narration TEXT,
      journal_voucher_no TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_allocation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL,
      invoice_type TEXT CHECK(invoice_type IN ('SALES','PURCHASE')) NOT NULL,
      invoice_id INTEGER NOT NULL,
      invoice_no TEXT NOT NULL,
      allocated_amount REAL NOT NULL,
      FOREIGN KEY (payment_id) REFERENCES payment_voucher(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT,
      client_id INTEGER,
      email TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT,
      client_id INTEGER,
      phone TEXT,
      status TEXT,
      error TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Added later (Meta WhatsApp integration) - safe no-op if the column
  // already exists on a fresh install where the CREATE TABLE above
  // already had it.
  db.run(`ALTER TABLE whatsapp_log ADD COLUMN provider TEXT`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT,
      payload TEXT,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_template', 'classic')`
  );

  /* -------------------- FIXED ASSET MANAGEMENT (FAM Step 3) --------------------
     Data model for the Fixed Asset module, following the 10-step plan.
     Only asset_category_master and fixed_asset are used by Step 4 (Asset
     Master module) below; asset_depreciation_schedule / asset_transfer /
     asset_disposal are created now (so the schema is stable from day one
     and later steps don't need migrations) but stay unused until the
     Depreciation Run (Step 7), Transfers/Disposals (Step 8) land. */

  // asset_category_master: one row per asset category (Plant & Machinery,
  // Furniture, Vehicles, ...). Carries the DEFAULT depreciation policy for
  // assets in that category — method/rate/useful life — so the Asset
  // Master form (Step 4) can pre-fill an individual asset's fields from
  // its category, same "sensible default, still overridable per-row"
  // pattern item_master.item_type uses. `ledger` stores the ledger NAME
  // (not an id) and is validated against ledger_master at the API layer
  // instead of a DB foreign key — same convention journal_entries.ledger /
  // ledger_entries.ledger already use everywhere else in this codebase
  // (see saveJournalInternal's own SELECT ... WHERE ledger IN (...) check).
  // A hard FK here would also be fragile against seed order: the system
  // ledgers seeded above are inserted from inside an async callback, so
  // they aren't guaranteed to exist yet at the moment this table's own
  // seed (below) runs.
  db.run(`
    CREATE TABLE IF NOT EXISTS asset_category_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_name TEXT UNIQUE NOT NULL,
      ledger TEXT NOT NULL,
      depreciation_method TEXT NOT NULL DEFAULT 'SLM' CHECK(depreciation_method IN ('SLM','WDV')),
      depreciation_rate REAL,
      useful_life_years REAL,
      is_active INTEGER DEFAULT 1
    )
  `);

  // fixed_asset: one row per individual physical asset (not per category —
  // buying 5 identical chairs is 5 rows, same as 5 separate item units
  // would be 5 stock movements). asset_name is intentionally NOT unique
  // (unlike item_master.item_name) since the same asset description
  // legitimately repeats across many individual units.
  // status starts every asset at ACTIVE; DISPOSED/WRITTEN_OFF are set by
  // the disposal flow (Step 8), never chosen at creation time.
  // depreciation_method/rate/useful_life_years are copied from the chosen
  // category at creation time (see /asset/create below) so each asset's
  // own depreciation basis is locked in even if the category's default is
  // edited later — mirrors why sales_invoice_items snapshots gst_rate
  // instead of re-reading item_master at report time.
  db.run(`
    CREATE TABLE IF NOT EXISTS fixed_asset (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_code TEXT UNIQUE,
      asset_name TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      location_id INTEGER,
      acquisition_date TEXT NOT NULL,
      acquisition_cost REAL NOT NULL,
      salvage_value REAL DEFAULT 0,
      useful_life_years REAL,
      depreciation_method TEXT NOT NULL DEFAULT 'SLM' CHECK(depreciation_method IN ('SLM','WDV')),
      depreciation_rate REAL,
      tag_code TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISPOSED','WRITTEN_OFF')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES asset_category_master(id),
      FOREIGN KEY (location_id) REFERENCES locations(id)
    )
  `);

  // asset_depreciation_schedule: period-wise depreciation history per
  // asset, written by the Depreciation Run (Step 7). One row per
  // asset+period once that lands; unused until then.
  db.run(`
    CREATE TABLE IF NOT EXISTS asset_depreciation_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      period TEXT NOT NULL,
      opening_wdv REAL NOT NULL,
      depreciation_amount REAL NOT NULL,
      closing_wdv REAL NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES fixed_asset(id)
    )
  `);

  // asset_transfer: pure location-movement log for an asset, no journal
  // impact — same "movement only, no value impact" shape as Stock
  // Transfer. Written by Step 8.
  db.run(`
    CREATE TABLE IF NOT EXISTS asset_transfer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      from_location_id INTEGER,
      to_location_id INTEGER,
      date TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (asset_id) REFERENCES fixed_asset(id)
    )
  `);

  // asset_disposal: sale/write-off record for an asset, including the
  // computed profit or loss on disposal. Written by Step 8.
  db.run(`
    CREATE TABLE IF NOT EXISTS asset_disposal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      sale_value REAL DEFAULT 0,
      book_value_at_disposal REAL NOT NULL,
      profit_loss REAL NOT NULL,
      notes TEXT,
      FOREIGN KEY (asset_id) REFERENCES fixed_asset(id)
    )
  `);

  // Seed the starter category set named in the plan (Step 1), each pointed
  // at the ledger seeded above for it. useful_life_years follow Companies
  // Act Schedule II general rates as a sensible SLM-method default —
  // editable per category later, and each asset created against a
  // category snapshots these values rather than re-reading them live (see
  // fixed_asset comment above). INSERT OR IGNORE so this is safe to re-run
  // on every boot without clobbering a category a user has since edited.
  db.run(`
    INSERT OR IGNORE INTO asset_category_master
    (category_name, ledger, depreciation_method, depreciation_rate, useful_life_years) VALUES
    ('Plant & Machinery','Plant & Machinery A/c','SLM',NULL,15),
    ('Furniture & Fixtures','Furniture & Fixtures A/c','SLM',NULL,10),
    ('Vehicles','Vehicles A/c','SLM',NULL,8),
    ('Computers','Computers A/c','SLM',NULL,3),
    ('Buildings','Buildings A/c','SLM',NULL,30)
  `, err => {
    if (err) console.error("SEED asset_category_master ERROR:", err.message);
  });

  /* -------------------- FIXED ASSET ACQUISITION/CAPITALIZATION (FAM Step 5) --------------------
     fixed_asset predates these columns (Step 4 created it), so they're
     retrofitted with ALTER TABLE + swallow-duplicate-column, same pattern
     as sales_invoice.client_id / purchase_invoice.supplier_id elsewhere in
     this file. capitalization_mode records WHICH of the two Step 5 paths
     brought the asset in (see VALID_CAPITALIZATION_MODES above);
     journal_voucher_no is the voucher saveJournalInternal posted for it, if
     any (OPENING mode posts none, so this stays NULL for those rows). The
     source_purchase_invoice_* columns are only populated for the
     PURCHASE_INVOICE path and let a purchase invoice line be traced
     forward to the asset it became. */
  db.run(`ALTER TABLE fixed_asset ADD COLUMN capitalization_mode TEXT DEFAULT 'OPENING'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (capitalization_mode) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE fixed_asset ADD COLUMN journal_voucher_no TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (journal_voucher_no) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE fixed_asset ADD COLUMN source_purchase_invoice_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (source_purchase_invoice_id) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE fixed_asset ADD COLUMN source_purchase_invoice_item_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (source_purchase_invoice_item_id) ERROR:", err.message);
    }
  });

  // purchase_invoice_items.capitalized_asset_id: set the moment a line is
  // capitalized into a fixed_asset row (see
  // /asset/capitalize-from-purchase-invoice below), so the same purchase
  // line can never be capitalized twice and the "available to capitalize"
  // picker can filter it out with a plain `WHERE capitalized_asset_id IS
  // NULL` instead of a correlated EXISTS subquery.
  db.run(`ALTER TABLE purchase_invoice_items ADD COLUMN capitalized_asset_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER purchase_invoice_items (capitalized_asset_id) ERROR:", err.message);
    }
  });

  /* -------------------- FIXED ASSET DISPOSAL DATE (FAM Step 8) --------------------
     disposal_date is read by computeDepreciation() (Step 6 wrote the engine
     to accept it; Step 8 is the first caller that actually sets it) to clip
     an asset's depreciation at the date it leaves the register, and is also
     the human-visible "when did this asset go" field on the register. NULL
     for every asset still ACTIVE. Retrofitted via ALTER, same pattern as
     the Step 5 columns just above. */
  db.run(`ALTER TABLE fixed_asset ADD COLUMN disposal_date TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (disposal_date) ERROR:", err.message);
    }
  });

  /* -------------------- DEPRECIATION RUN (FAM Step 7) --------------------
     depreciation_run is the batch header — one row per period a Depreciation
     Run was generated for, DRAFT until /depreciation-run/:id/process posts
     one consolidated journal for the whole period. Mirrors payroll_run's
     DRAFT -> PROCESSED lifecycle (see payroll.js) rather than posting one
     journal per asset, so the ledger gets a single "Depreciation for
     <period>" voucher instead of hundreds of tiny ones.
     asset_depreciation_schedule (table created in Step 3) is the per-asset
     line detail computeDepreciation()'s engine (Step 6) feeds into — run_id
     ties each row back to the run that produced it, and period_start/
     period_end (added here) are the actual computation window, since the
     original 'period' column is just a display label. run_id is nullable:
     a NULL-run schedule row is a one-off "stub" charge posted directly by
     /asset/:id/dispose (Step 8) for the partial period between the last
     Depreciation Run and an asset's disposal date, not part of any batch. */
  db.run(`
    CREATE TABLE IF NOT EXISTS depreciation_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PROCESSED')),
      journal_voucher_no TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      UNIQUE(period_start, period_end)
    )
  `);
  db.run(`ALTER TABLE asset_depreciation_schedule ADD COLUMN run_id INTEGER`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_depreciation_schedule (run_id) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE asset_depreciation_schedule ADD COLUMN period_start TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_depreciation_schedule (period_start) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE asset_depreciation_schedule ADD COLUMN period_end TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_depreciation_schedule (period_end) ERROR:", err.message);
    }
  });

  /* -------------------- ASSET DISPOSAL COLUMNS (FAM Step 8) --------------------
     asset_disposal predates these columns (Step 3 created it, unused until
     now). mode records SALE vs WRITE_OFF — a write-off is just a disposal
     with sale_value forced to 0 and no credit_ledger leg, not a separate
     code path. journal_voucher_no is the main disposal journal (Dr
     Accumulated Depreciation, Dr credit_ledger if any, Dr Loss/Cr Profit on
     Sale / Cr the category's asset ledger) — see /asset/:id/dispose below.
     stub_depreciation_voucher_no is the SEPARATE journal (if any) for the
     partial-period depreciation charged up to the disposal date, posted
     just before the disposal journal so book value is current as of the
     actual disposal date rather than stale as of the last Depreciation Run. */
  db.run(`ALTER TABLE asset_disposal ADD COLUMN mode TEXT DEFAULT 'SALE'`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_disposal (mode) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE asset_disposal ADD COLUMN journal_voucher_no TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_disposal (journal_voucher_no) ERROR:", err.message);
    }
  });
  db.run(`ALTER TABLE asset_disposal ADD COLUMN stub_depreciation_voucher_no TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER asset_disposal (stub_depreciation_voucher_no) ERROR:", err.message);
    }
  });

  /* -------------------- PHYSICAL VERIFICATION (FAM Step 9) --------------------
     last_verified_date backs the Physical Verification checklist report —
     asset code, location, last verified date — named in the plan's Step 9.
     Set by /asset/:id/verify (added alongside the reports below) whenever
     someone actually walks the floor and confirms an asset's tag is where
     the register says it should be. NULL means "never verified", which the
     checklist report surfaces as-is rather than hiding, since "never
     verified" is exactly the thing an auditor wants flagged. Retrofitted
     via ALTER, same pattern as every other FAM column added after the
     table's original CREATE. */
  db.run(`ALTER TABLE fixed_asset ADD COLUMN last_verified_date TEXT`, err => {
    if (err && !/duplicate column/i.test(err.message)) {
      console.error("ALTER fixed_asset (last_verified_date) ERROR:", err.message);
    }
  });

});

/* -------------------- LEDGER MASTER -------------------- */

/* Create ledger */
app.post("/ledger/create", (req, res) => {
  const { ledger, group } = req.body;

  if (!ledger || !group) {
    return res.status(400).json({ error: "Ledger and group required" });
  }

  db.get(
    `SELECT group_name FROM ledger_group_master WHERE group_name = ?`,
    [group],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!row) {
        return res.status(400).json({
          error: `Invalid ledger group: ${group}`
        });
      }

      db.run(
        `INSERT INTO ledger_master (ledger, ledger_group)
         VALUES (?, ?)`,
        [ledger.trim(), group],
        err => {
          if (err) {
            if (err.message.includes("UNIQUE")) {
              return res.status(409).json({ error: "Ledger already exists" });
            }
            return res.status(500).json({ error: err.message });
          }
          res.json({ status: "success" });
        }
      );
    }
  );
});


/* ---------------Ledger master list (SINGLE SOURCE OF TRUTH)-----------------*/
app.get("/ledger/master", (req, res) => {
  db.all(
    `
    SELECT
      lm.ledger,
      lm.ledger_group,
      lg.nature
    FROM ledger_master lm
    JOIN ledger_group_master lg
      ON lm.ledger_group = lg.group_name
    ORDER BY lm.ledger
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- SAVE JOURNAL -------------------- */

app.post("/save-journal", async (req, res) => {
  const { date, narration, entries } = req.body;

  if (!date || !entries?.length) {
    return res.status(400).json({ error: "Invalid journal data" });
  }

  try {
    db.run("BEGIN TRANSACTION");

    const voucherNo = await saveJournalInternal({
      date,
      narration,
      entries
    });

    db.run("COMMIT");

    res.json({
      status: "success",
      voucher_no: voucherNo
    });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* -------------------- LEDGER MASTER GROUP DATA -------------------- */
app.get("/ledger/groups", (req, res) => {
  db.all(
    "SELECT name FROM sqlite_master WHERE type='table'",
    [],
    (e, tables) => {
      console.log("TABLES IN DB:", tables.map(t => t.name));
    }
  );

  db.all(
    "SELECT group_name, nature FROM ledger_group_master",
    [],
    (err, rows) => {
      if (err) {
        console.error("GROUP FETCH ERROR:", err.message);
        return res.status(500).json([]);
      }

      console.log("GROUP ROWS RETURNED:", rows);
      res.json(rows);
    }
  );
});

/* -------------------- LEDGER VIEWS -------------------- */

app.get("/ledger/all", (req, res) => {
  db.all(
    `SELECT * FROM ledger_entries ORDER BY ledger, date, id`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get("/ledger/:name", (req, res) => {
  db.all(
    `SELECT * FROM ledger_entries
     WHERE ledger = ?
     ORDER BY date, id`,
    [req.params.name],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- JOURNAL LIST -------------------- */

app.get("/journal/all", (req, res) => {
  db.all(
    `
    SELECT 
      j.id,
      j.date,
      j.voucher_no,
      j.narration,
      SUM(e.debit) AS total_debit,
      SUM(e.credit) AS total_credit
    FROM journal_voucher j
    JOIN journal_entries e ON j.id = e.voucher_id
    GROUP BY j.id
    ORDER BY j.date, j.id
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- DELETE JOURNAL -------------------- */

app.delete("/journal/:id", (req, res) => {
  const voucherId = req.params.id;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.get(
      `SELECT voucher_no FROM journal_voucher WHERE id = ?`,
      [voucherId],
      (err, row) => {
        if (err || !row) {
          db.run("ROLLBACK");
          return res.status(404).json({ error: "Voucher not found" });
        }

        const voucherNo = row.voucher_no;

        db.run(`DELETE FROM journal_entries WHERE voucher_id = ?`, [voucherId]);
        db.run(`DELETE FROM journal_voucher WHERE id = ?`, [voucherId]);
        db.run(`DELETE FROM ledger_entries WHERE voucher_no = ?`, [voucherNo]);

        db.run("COMMIT");
        res.json({ status: "deleted" });
      }
    );
  });
});

/* -------------------- JOURNAL DETAILS -------------------- */

app.get("/journal/:id/details", (req, res) => {
  const voucherId = req.params.id;

  db.all(
    `
    SELECT 
      j.date,
      j.voucher_no,
      j.narration,
      e.ledger,
      e.lf,
      e.debit,
      e.credit
    FROM journal_voucher j
    JOIN journal_entries e ON j.id = e.voucher_id
    WHERE j.id = ?
    ORDER BY e.id
    `,
    [voucherId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- GET CURRENT SALES INVOICE -------------------- */

app.get("/sales/next-invoice", (req, res) => {
  getNextInvoiceNo((err, inv) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ invoiceNo: inv });
  });
});




/* -------------------- CLIENTS -------------------- */

/* List all clients */
app.get("/clients", (req, res) => {
  db.all(`SELECT * FROM clients ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/* Autocomplete search by name (used on the Sales Invoice page) */
app.get("/clients/search", (req, res) => {
  const q = `%${req.query.q || ""}%`;
  db.all(
    `SELECT * FROM clients WHERE name LIKE ? ORDER BY name LIMIT 10`,
    [q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Get one client */
app.get("/clients/:id", (req, res) => {
  db.get(`SELECT * FROM clients WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Client not found" });
    res.json(row);
  });
});

/* Create a client (dedicated Clients page AND the inline "+ New Client" on Sales Invoice both use this) */
app.post("/clients/create", (req, res) => {
  const { name, email, phone, address, gstin, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Client name is required" });
  }

  const cleanGstin = gstin ? normalizeGstin(gstin) : "";
  if (cleanGstin && !isValidGstin(cleanGstin)) {
    return res.status(400).json({
      error: "Invalid GSTIN. Expected a 15-character GSTIN like 27ABCDE1234F1Z5, or leave blank for an unregistered customer."
    });
  }

  db.run(
    `INSERT INTO clients (name, email, phone, address, gstin, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name.trim(), email || null, phone || null, address || null, cleanGstin || null, notes || null],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A client with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      db.get(`SELECT * FROM clients WHERE id = ?`, [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* Update a client */
app.put("/clients/:id", (req, res) => {
  const { name, email, phone, address, gstin, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Client name is required" });
  }

  const cleanGstin = gstin ? normalizeGstin(gstin) : "";
  if (cleanGstin && !isValidGstin(cleanGstin)) {
    return res.status(400).json({
      error: "Invalid GSTIN. Expected a 15-character GSTIN like 27ABCDE1234F1Z5, or leave blank for an unregistered customer."
    });
  }

  db.run(
    `UPDATE clients
     SET name = ?, email = ?, phone = ?, address = ?, gstin = ?, notes = ?
     WHERE id = ?`,
    [name.trim(), email || null, phone || null, address || null, cleanGstin || null, notes || null, req.params.id],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A client with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: "Client not found" });
      db.get(`SELECT * FROM clients WHERE id = ?`, [req.params.id], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* -------------------- SUPPLIERS -------------------- */
// Mirrors the /clients endpoints exactly — see those for the reasoning
// behind the GSTIN validation.

app.get("/suppliers", (req, res) => {
  db.all(`SELECT * FROM suppliers ORDER BY name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/* Autocomplete search by name (used on Purchase Book, Purchase Order, Debit Note) */
app.get("/suppliers/search", (req, res) => {
  const q = `%${req.query.q || ""}%`;
  db.all(
    `SELECT * FROM suppliers WHERE name LIKE ? ORDER BY name LIMIT 10`,
    [q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Get one supplier */
app.get("/suppliers/:id", (req, res) => {
  db.get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Supplier not found" });
    res.json(row);
  });
});

/* Create a supplier (dedicated Suppliers page AND the inline "+ New Supplier" on purchase screens both use this) */
app.post("/suppliers/create", (req, res) => {
  const { name, email, phone, address, gstin, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Supplier name is required" });
  }

  const cleanGstin = gstin ? normalizeGstin(gstin) : "";
  if (cleanGstin && !isValidGstin(cleanGstin)) {
    return res.status(400).json({
      error: "Invalid GSTIN. Expected a 15-character GSTIN like 27ABCDE1234F1Z5, or leave blank for an unregistered supplier."
    });
  }

  db.run(
    `INSERT INTO suppliers (name, email, phone, address, gstin, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name.trim(), email || null, phone || null, address || null, cleanGstin || null, notes || null],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A supplier with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      db.get(`SELECT * FROM suppliers WHERE id = ?`, [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* Update a supplier */
app.put("/suppliers/:id", (req, res) => {
  const { name, email, phone, address, gstin, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Supplier name is required" });
  }

  const cleanGstin = gstin ? normalizeGstin(gstin) : "";
  if (cleanGstin && !isValidGstin(cleanGstin)) {
    return res.status(400).json({
      error: "Invalid GSTIN. Expected a 15-character GSTIN like 27ABCDE1234F1Z5, or leave blank for an unregistered supplier."
    });
  }

  db.run(
    `UPDATE suppliers
     SET name = ?, email = ?, phone = ?, address = ?, gstin = ?, notes = ?
     WHERE id = ?`,
    [name.trim(), email || null, phone || null, address || null, cleanGstin || null, notes || null, req.params.id],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A supplier with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: "Supplier not found" });
      db.get(`SELECT * FROM suppliers WHERE id = ?`, [req.params.id], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* -------------------- LOCATIONS CRUD (Phase 2, Step 5) --------------------
   The warehouse/location master. Follows the exact same shape as the
   suppliers/clients endpoints above: GET list (+ optional /:id and
   /search), POST /create, PUT /:id. There's no DELETE — locations are
   referenced by stock_ledger rows (often years of history), so removing
   one for real would either orphan those rows or cascade-delete real
   transactions. "Deactivate" is just PUT with is_active: false, same as
   toggling any other field; the Locations screen (Step 6) hides inactive
   locations from new-transaction dropdowns but still shows them in
   historical reports. */

/* List locations. ?active=1 filters to only active ones — used by dropdowns
   on transaction screens (GRN, DC, Stock Transfer) so a deactivated
   location can't be picked for new stock movements but still shows up on
   the full Locations master screen and in historical reports. */
app.get("/locations", (req, res) => {
  const activeOnly = req.query.active === "1" || req.query.active === "true";
  db.all(
    `SELECT * FROM locations ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY location_name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Get one location */
app.get("/locations/:id", (req, res) => {
  db.get(`SELECT * FROM locations WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Location not found" });
    res.json(row);
  });
});

/* Create a location */
app.post("/locations/create", (req, res) => {
  const { location_name } = req.body;

  if (!location_name || !location_name.trim()) {
    return res.status(400).json({ error: "Location name is required" });
  }

  const locationType = normalizeLocationType(req.body.location_type);
  if (!locationType) {
    return res.status(400).json({
      error: `location_type must be one of ${VALID_LOCATION_TYPES.join(", ")}. Got "${req.body.location_type}".`
    });
  }

  const isActive = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;

  db.run(
    `INSERT INTO locations (location_name, location_type, is_active) VALUES (?, ?, ?)`,
    [location_name.trim(), locationType, isActive],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A location with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      db.get(`SELECT * FROM locations WHERE id = ?`, [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* Update a location — also how deactivation happens (PUT with
   is_active: false). Renaming is safe: every stock_ledger reference is by
   location_id, not by name, so a rename doesn't orphan history. */
app.put("/locations/:id", (req, res) => {
  const { location_name } = req.body;

  if (!location_name || !location_name.trim()) {
    return res.status(400).json({ error: "Location name is required" });
  }

  const locationType = normalizeLocationType(req.body.location_type);
  if (!locationType) {
    return res.status(400).json({
      error: `location_type must be one of ${VALID_LOCATION_TYPES.join(", ")}. Got "${req.body.location_type}".`
    });
  }

  const isActive = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;

  db.run(
    `UPDATE locations SET location_name = ?, location_type = ?, is_active = ? WHERE id = ?`,
    [location_name.trim(), locationType, isActive, req.params.id],
    function (err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(400).json({ error: "A location with this name already exists" });
        }
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: "Location not found" });
      db.get(`SELECT * FROM locations WHERE id = ?`, [req.params.id], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    }
  );
});

/* -------------------- BOM GUARDRAILS (Phase 3, Step 10) --------------------
   Cheap validation layered on top of the CRUD routes below rather than
   built into the table schema (same "loose TEXT classifier / API-layer
   enforcement" stance as bom.status — see the bom table comment, Step 1).
   Three checks:

     - no self-reference: a component line can't name the same item as
       the FG/WIP the BOM is for. A BOM that "consumes itself" can never
       price out to a real cost and would loop forever if BOMs were ever
       allowed to nest.
     - no duplicate components: each component_item_id may appear at
       most once per BOM version. A repeated line is almost certainly a
       copy-paste mistake rather than an intentional qty split across two
       rows — left unchecked, computeBOMCost (Step 5) would silently
       double-count that component in the rollup.
     - fg_item_id must still resolve: /activate and /new-version both act
       on "the BOM for this FG item", so if that FG item id no longer
       resolves to a real item_master row, activating it (or branching a
       new version off it) would produce a BOM for nothing. item_master
       has no soft-delete flag (items are never removed once created —
       see the item_master schema above), so in practice this is a plain
       existence check today; it's still worth asking explicitly rather
       than assuming, since a bad fg_item_id could otherwise reach here
       from stale client state. */

/* Validates one BOM's full set of component lines against the two rules
   above. Called by both /bom/create and PUT /bom/:id, since both routes
   write a fresh set of bom_items and need the same checks — /bom/create
   against the fgItemId in its request body, PUT /bom/:id against the
   fg_item_id already fixed on the row being edited. Returns an error
   string to surface as a 400, or null if the lines are clean. */
function validateBOMComponentLines(items, fgItemId) {
  const fgId = Number(fgItemId);
  const seen = new Set();
  for (const item of items) {
    const componentId = Number(item.component_item_id);
    if (componentId === fgId) {
      return "A component can't be the same item as the FG/WIP this BOM is for.";
    }
    if (seen.has(componentId)) {
      return "Each component can only appear once in a BOM — remove the duplicate line.";
    }
    seen.add(componentId);
  }
  return null;
}

/* Existence check behind the fg_item_id guardrail on /activate and
   /new-version — see the section comment above for why this matters and
   why it's currently just a row lookup. */
function fgItemStillResolves(fgItemId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id FROM item_master WHERE id = ?`, [fgItemId], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

/* -------------------- BOM CRUD (Phase 3, Step 3) --------------------
   Follows the exact same shape as the Suppliers/Locations CRUD above: GET
   list (+ /:id), POST /create, PUT /:id. Two things make BOM different
   from a plain master though, both flowing from the versioning model
   Step 1/2 set up:

     - There's no generic PUT-anything — PUT /bom/:id only ever replaces
       the item lines, and only while the row is still DRAFT. Every other
       field (fg_item_id, version, bom_no) is fixed for the life of a row;
       "changing" them means /new-version, not an edit.
     - Status transitions are their own endpoints (/new-version, /activate)
       rather than a generic PUT { status } — each one has real
       transactional side effects (cloning rows, flipping the sibling
       ACTIVE row to OBSOLETE) that a bare status update would skip. */

/* One row per FG item: whichever version is currently ACTIVE for it, or
   (if it has no ACTIVE version yet — e.g. a brand-new BOM still sitting in
   DRAFT) its highest version, so a BOM never disappears from the register
   just because it hasn't been activated. other_versions/total_versions
   let the register show "+2 other versions" without a second round trip.

   Grouped in JS after a flat SQL fetch rather than a window-function
   query, matching this file's existing convention of aggregating in JS
   (see recomputePOStatus/recomputeSOStatus) rather than in SQL. */
app.get("/bom/list", (req, res) => {
  db.all(
    `
    SELECT b.id, b.bom_no, b.fg_item_id, b.version, b.status, b.effective_date,
           b.narration, b.created_at,
           im.item_name AS fg_item_name, im.unit AS fg_unit
    FROM bom b
    JOIN item_master im ON im.id = b.fg_item_id
    ORDER BY im.item_name, b.version DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const byFg = new Map();
      for (const row of rows) {
        if (!byFg.has(row.fg_item_id)) byFg.set(row.fg_item_id, []);
        byFg.get(row.fg_item_id).push(row);
      }

      const result = [];
      for (const versions of byFg.values()) {
        // versions is already sorted version DESC (from the ORDER BY above),
        // so versions[0] is the fallback "highest version" when none is ACTIVE.
        const active = versions.find(v => v.status === "ACTIVE");
        const headline = active || versions[0];
        result.push({
          ...headline,
          other_versions: versions.length - 1,
          total_versions: versions.length
        });
      }

      result.sort((a, b) => a.fg_item_name.localeCompare(b.fg_item_name));
      res.json(result);
    }
  );
});

/* One BOM version with its component lines. */
app.get("/bom/:id", (req, res) => {
  db.get(
    `
    SELECT b.*, im.item_name AS fg_item_name, im.unit AS fg_unit
    FROM bom b
    JOIN item_master im ON im.id = b.fg_item_id
    WHERE b.id = ?
    `,
    [req.params.id],
    (err, bomRow) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!bomRow) return res.status(404).json({ error: "BOM not found" });

      db.all(
        `
        SELECT bi.*, im.item_name AS component_item_name, im.unit AS component_unit
        FROM bom_items bi
        JOIN item_master im ON im.id = bi.component_item_id
        WHERE bi.bom_id = ?
        ORDER BY bi.id
        `,
        [req.params.id],
        (err2, items) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ ...bomRow, items });
        }
      );
    }
  );
});

/* Create the first version (version 1, DRAFT) of a BOM for an FG item.
   A second /bom/create for the same fg_item_id is NOT how you get version
   2 — that's /bom/:fgItemId/new-version, which clones forward from the
   ACTIVE row instead of starting blank. This endpoint doesn't check
   whether the FG already has a BOM; nothing stops two independent
   version-1 DRAFTs existing for one FG until one of them is activated
   (only /activate enforces the single-ACTIVE invariant).

   Component-line validation here covers the basics (must reference a
   component, qty_per_unit must be a positive number) plus the fuller
   guardrails from Step 10 (no self-reference, no duplicate components),
   layered on via validateBOMComponentLines below. */
app.post("/bom/create", async (req, res) => {
  const { fgItemId, effectiveDate, narration, items } = req.body;

  if (!fgItemId) {
    return res.status(400).json({ error: "fgItemId is required" });
  }
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }
  for (const item of items) {
    if (!item.component_item_id || item.qty_per_unit == null || Number(item.qty_per_unit) <= 0) {
      return res.status(400).json({
        error: "Each component line needs a component item and a qty_per_unit greater than 0"
      });
    }
  }
  const lineError = validateBOMComponentLines(items, fgItemId);
  if (lineError) {
    return res.status(400).json({ error: lineError });
  }

  let transactionStarted = false;
  try {
    const fgItem = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM item_master WHERE id = ?`, [fgItemId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!fgItem) throw new Error("FG item not found");

    const bomNo = await new Promise((resolve, reject) => {
      getNextBOMNo((err, no) => (err ? reject(err) : resolve(no)));
    });

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    const bomId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO bom (bom_no, fg_item_id, version, status, effective_date, narration)
        VALUES (?, ?, 1, 'DRAFT', ?, ?)
        `,
        [bomNo, fgItemId, effectiveDate || null, narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO bom_items (bom_id, component_item_id, qty_per_unit, unit, narration)
          VALUES (?, ?, ?, ?, ?)
          `,
          [bomId, item.component_item_id, Number(item.qty_per_unit), item.unit || null, item.narration || null],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", id: bomId, bom_no: bomNo, version: 1 });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* Items-only edit — replaces this DRAFT version's component lines wholesale
   (delete-then-reinsert, same "replace the set" shape as a line-items edit
   elsewhere in the app) rather than diffing individual rows. Blocked once
   the row isn't DRAFT: an ACTIVE or OBSOLETE version is a historical record
   at that point, and the only way to change what an FG's BOM contains is
   /new-version + edit-the-draft + /activate. */
app.put("/bom/:id", async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }
  for (const item of items) {
    if (!item.component_item_id || item.qty_per_unit == null || Number(item.qty_per_unit) <= 0) {
      return res.status(400).json({
        error: "Each component line needs a component item and a qty_per_unit greater than 0"
      });
    }
  }

  let transactionStarted = false;
  try {
    const bomRow = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM bom WHERE id = ?`, [req.params.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!bomRow) throw new Error("BOM not found");
    if (bomRow.status !== "DRAFT") {
      throw new Error(
        `This BOM is ${bomRow.status}, not DRAFT — only a DRAFT version's item lines can be edited. Start a new version instead.`
      );
    }
    const lineError = validateBOMComponentLines(items, bomRow.fg_item_id);
    if (lineError) throw new Error(lineError);

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM bom_items WHERE bom_id = ?`, [req.params.id], err =>
        err ? reject(err) : resolve()
      );
    });

    for (const item of items) {
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO bom_items (bom_id, component_item_id, qty_per_unit, unit, narration)
          VALUES (?, ?, ?, ?, ?)
          `,
          [req.params.id, item.component_item_id, Number(item.qty_per_unit), item.unit || null, item.narration || null],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", id: Number(req.params.id) });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* Clone-and-bump: starts a new DRAFT version from whatever's currently
   ACTIVE for this FG. All the actual mechanics (resolving the source
   version, cloning its lines, the transaction) live in Step 2's
   cloneBOMToNewVersion helper — this route is just the HTTP wrapper, same
   division of labour as resolveLocationId vs. the routes that call it. */
app.post("/bom/:fgItemId/new-version", async (req, res) => {
  try {
    const fgStillValid = await fgItemStillResolves(req.params.fgItemId);
    if (!fgStillValid) {
      return res.status(400).json({
        error: "This item no longer exists — can't create a new BOM version for it."
      });
    }
    const result = await cloneBOMToNewVersion(req.params.fgItemId);
    res.json({ status: "success", ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* Flips a DRAFT to ACTIVE, and — in the same transaction — flips whatever
   was previously ACTIVE for that fg_item_id to OBSOLETE. Same
   one-transaction shape as the GRN/Stock Transfer handlers: the two
   UPDATEs must land together, since a crash between them would otherwise
   leave either zero or two ACTIVE rows for the FG. The step-down runs
   first so the two writes never leave two ACTIVE rows visible at once. */
app.post("/bom/:id/activate", async (req, res) => {
  let transactionStarted = false;
  try {
    const bomRow = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM bom WHERE id = ?`, [req.params.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!bomRow) throw new Error("BOM not found");
    if (bomRow.status !== "DRAFT") {
      throw new Error(`This BOM is already ${bomRow.status} — only a DRAFT version can be activated`);
    }
    const fgStillValid = await fgItemStillResolves(bomRow.fg_item_id);
    if (!fgStillValid) {
      throw new Error("This BOM's finished-good item no longer exists — it can't be activated.");
    }

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE bom SET status = 'OBSOLETE' WHERE fg_item_id = ? AND status = 'ACTIVE'`,
        [bomRow.fg_item_id],
        err => (err ? reject(err) : resolve())
      );
    });

    await new Promise((resolve, reject) => {
      db.run(`UPDATE bom SET status = 'ACTIVE' WHERE id = ?`, [req.params.id], err =>
        err ? reject(err) : resolve()
      );
    });

    db.run("COMMIT");
    res.json({
      status: "success",
      id: Number(req.params.id),
      fg_item_id: bomRow.fg_item_id,
      version: bomRow.version
    });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- BOM COST ROLLUP (Phase 3, Step 5) --------------------
   Both routes below just resolve "which bom_id am I costing" and hand off
   to computeBOMCost() — the actual qty × rate summing lives there so the
   two entry points ("cost this specific version" vs. "cost whatever's
   currently active for this FG") can't drift apart. */

/* Cost a specific BOM version by its own id — used when you're looking at
   a particular version (e.g. from the BOM edit screen, Step 6/8), ACTIVE
   or not, and want to know what it would cost / did cost. */
app.get("/bom/:id/cost", async (req, res) => {
  try {
    const cost = await computeBOMCost(req.params.id);
    res.json(cost);
  } catch (err) {
    console.error(err);
    res.status(err.message === "BOM not found" ? 404 : 500).json({ error: err.message });
  }
});

/* Convenience wrapper: "what does it currently cost to make one of these"
   for an FG item, without the caller having to know a bom_id at all —
   resolves the active version first (Step 2's resolveActiveBOM), same as
   any other "current BOM for this FG" lookup elsewhere in the app would.
   This is the one a standard-cost lookup from outside the BOM feature
   itself (e.g. a future Work Order costing screen) should call. */
app.get("/bom/cost/by-item/:fgItemId", async (req, res) => {
  try {
    const activeBOM = await resolveActiveBOM(req.params.fgItemId);
    if (!activeBOM) {
      return res.status(404).json({
        error: "This item has no active BOM — nothing to cost yet"
      });
    }
    const cost = await computeBOMCost(activeBOM.id);
    res.json(cost);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER CRUD (Production Phase, Step 3) --------------------
   Work Order is the production voucher: an FG + a target qty, exploded
   against that FG's ACTIVE BOM into a frozen component snapshot (Step 1's
   work_order_components) at creation time. Issue (Step 4) and Complete
   (Step 6) are separate endpoints layered on top of this CRUD — this block
   is just create/list/get, same division as BOM's create/list/:id. */

app.get("/work-order/list", (req, res) => {
  db.all(
    `
    SELECT wo.id, wo.wo_no, wo.fg_item_id, wo.bom_id, wo.bom_version,
           wo.target_qty, wo.completed_qty, wo.issue_location_id, wo.receive_location_id,
           wo.status, wo.date, wo.narration, wo.created_at,
           im.item_name AS fg_item_name, im.unit AS fg_unit
    FROM work_order wo
    JOIN item_master im ON im.id = wo.fg_item_id
    ORDER BY wo.id DESC
    `,
    [],
    (err, headers) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(
        `SELECT wo_id, required_qty, issued_qty FROM work_order_components`,
        [],
        (err2, compRows) => {
          if (err2) return res.status(500).json({ error: err2.message });

          // Same JS-side aggregation style as /bom/list — roll the
          // component lines up into a required/issued total per WO rather
          // than a SQL-level GROUP BY join against the header query.
          const byWO = new Map();
          for (const c of compRows) {
            if (!byWO.has(c.wo_id)) byWO.set(c.wo_id, { required: 0, issued: 0 });
            const agg = byWO.get(c.wo_id);
            agg.required += c.required_qty;
            agg.issued += c.issued_qty;
          }

          const result = headers.map(h => ({
            ...h,
            required_qty_total: byWO.get(h.id)?.required ?? 0,
            issued_qty_total: byWO.get(h.id)?.issued ?? 0
          }));

          res.json(result);
        }
      );
    }
  );
});

/* One Work Order with its component lines. Mirrors GET /bom/:id. */
app.get("/work-order/:id", (req, res) => {
  db.get(
    `
    SELECT wo.*, im.item_name AS fg_item_name, im.unit AS fg_unit
    FROM work_order wo
    JOIN item_master im ON im.id = wo.fg_item_id
    WHERE wo.id = ?
    `,
    [req.params.id],
    (err, woRow) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!woRow) return res.status(404).json({ error: "Work Order not found" });

      db.all(
        `
        SELECT wc.*, im.item_name AS component_item_name, im.unit AS component_unit
        FROM work_order_components wc
        JOIN item_master im ON im.id = wc.component_item_id
        WHERE wc.wo_id = ?
        ORDER BY wc.id
        `,
        [req.params.id],
        (err2, items) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ ...woRow, items });
        }
      );
    }
  );
});

/* Creates a Work Order: explodes the FG's ACTIVE BOM for targetQty (Step
   2's explodeBOMForQuantity) and writes the header (DRAFT) plus the
   exploded component rows as a frozen snapshot, in one transaction — same
   "resolve first, BEGIN, write everything, COMMIT" shape as /bom/create.

   locations is optional and defaults via resolveLocationId the same way
   Stock Transfer does: issue_location_id -> RM Store, receive_location_id
   -> FG Store, so a WO always has concrete location ids even when the
   caller doesn't pick one. bom_id/bom_version are stamped onto the header
   from whichever BOM row explodeBOMForQuantity resolved, for traceability.

   item_type gating (FG picker must be WIP/FINISHED_GOOD) is a Step 7
   guardrail, not enforced here. */
app.post("/work-order/create", async (req, res) => {
  const { fgItemId, targetQty, date, locations, narration } = req.body;

  if (!fgItemId) {
    return res.status(400).json({ error: "fgItemId is required" });
  }
  if (targetQty == null || Number(targetQty) <= 0) {
    return res.status(400).json({ error: "targetQty must be greater than 0" });
  }
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }

  let transactionStarted = false;
  try {
    // item_type gating (Step 7): mirrors the BOM screen's own FG picker
    // filter (Phase 3 Step 6) at the API layer, so a WO can't be raised
    // for a plain trading/RAW_MATERIAL item even if something bypasses the
    // client-side dropdown filter.
    const fgItem = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM item_master WHERE id = ?`, [fgItemId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!fgItem) throw new Error("FG item not found");
    if (fgItem.item_type !== "WIP" && fgItem.item_type !== "FINISHED_GOOD") {
      throw new Error(
        `Work orders can only be raised for WIP or FINISHED_GOOD items — "${fgItem.item_name}" is ${fgItem.item_type || "unclassified"}`
      );
    }

    const { bom, lines } = await explodeBOMForQuantity(fgItemId, Number(targetQty));
    if (!lines.length) {
      throw new Error("This item's active BOM has no component lines to build from.");
    }

    const issueLocationId = await resolveLocationId(locations?.issue_location_id, "RM Store");
    const receiveLocationId = await resolveLocationId(locations?.receive_location_id, "FG Store");

    const woNo = await new Promise((resolve, reject) => {
      getNextWONo((err, no) => (err ? reject(err) : resolve(no)));
    });

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    const woId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO work_order
          (wo_no, fg_item_id, bom_id, bom_version, target_qty,
           issue_location_id, receive_location_id, status, date, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
        `,
        [
          woNo,
          fgItemId,
          bom.id,
          bom.version,
          Number(targetQty),
          issueLocationId,
          receiveLocationId,
          date,
          narration || null
        ],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const line of lines) {
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO work_order_components
            (wo_id, component_item_id, qty_per_unit, required_qty, issued_qty, unit, narration)
          VALUES (?, ?, ?, ?, 0, ?, ?)
          `,
          [woId, line.component_item_id, line.qty_per_unit, line.required_qty, line.unit, line.narration],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", id: woId, wo_no: woNo });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    const notFound = /no active BOM/i.test(err.message);
    res.status(notFound ? 400 : 500).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER — RM ISSUE (Production Phase, Step 4) --------------------
   Issues raw material against a DRAFT/ISSUED Work Order's frozen component
   snapshot (work_order_components, Step 1). Takes a set of
   {component_item_id, qty} lines — partial issue allowed, and callable more
   than once, same "pending = qty - received_qty" shape GRN already uses
   against a PO (here: pending = required_qty - issued_qty per component
   line).

   Batch Tracking Step 5: a line can now carry a batch_no, or a list of
   {batch_no, qty} sub-lines when one issue line needs to draw from more
   than one batch (e.g. half the qty from an older batch, half from a
   newer one) — same "one or more sub-lines per line" shape Step 3 gave
   GRN. Each sub-line is validated against getAvailableStockAtBatchLocation
   (Step 2) instead of the item-wide getAvailableStockAtLocation, so a line
   can't draw more of a specific batch than is actually sitting at the
   issue location under that batch_no. This is the point where batch
   identity starts riding on voucher_no (the WO's own wo_no) the same way
   it already does for everything else in this flow — both the qty_out row
   at the issue location and the qty_in row at Shop Floor carry the
   sub-line's batch_no, so Step 7's completion endpoint can pull the batch
   breakdown per component straight off these WO_ISSUE rows.

   Callers that omit batch info entirely (no `batches` array and no
   `batch_no` field — i.e. the Work Order screen before Step 6 wires up its
   batch picker) fall back to the old item-wide getAvailableStockAtLocation
   check and post a single un-batched (batch_no NULL) pair of rows, exactly
   as before. This is a deliberate transitional safety net, not a general
   rule: it only kicks in when batch info is absent altogether, not when
   it's present but empty.

   For each valid sub-line this writes two stock_ledger rows sharing one
   voucher_no (the WO's own wo_no, same "reuse the header number as the
   voucher label across repeated partial postings" convention GRN uses with
   po_no) — qty_out at the WO's issue_location_id (RM Store by default, set
   at creation in Step 3) and qty_in at Shop Floor, the WIP holding location
   Phase 2 already seeded (location_type = 'SHOP_FLOOR'). Shop Floor is
   resolved fresh every call via resolveLocationId and is NOT one of the
   WO's own configurable locations — every WO issues onto the same WIP
   account regardless of which issue_location_id it was created against.

   Each line is priced via getCurrentComponentRate (the live-rate helper
   Phase 3 Step 5 built) at issue time — once per line, reused across all
   of that line's batch sub-lines since they're all issued in the same call
   — so the WIP-side qty_in carries a real rate rather than NULL. That
   valuation is what Step 6's completion endpoint will sum back out of Shop
   Floor.

   Runs as one transaction covering every line in the request (all lines
   post together or none do), and flips the WO DRAFT -> ISSUED on the first
   successful issue. Locations are resolved before BEGIN, same "resolve
   first, then open the transaction" ordering GRN's grnLocationId lookup
   uses, so a bad lookup can't leave a half-open transaction behind.

   Blocks issue against a CANCELLED/COMPLETED WO (Step 7's guardrail). */
app.post("/work-order/:id/issue", async (req, res) => {
  const woId = req.params.id;
  const { date, lines } = req.body;

  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }
  if (!lines?.length) {
    return res.status(400).json({ error: "At least one issue line is required" });
  }

  let transactionStarted = false;
  try {
    const wo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM work_order WHERE id = ?`, [woId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!wo) throw new Error("Work Order not found");
    if (wo.status === "CANCELLED" || wo.status === "COMPLETED") {
      throw new Error(`Cannot issue against a ${wo.status} Work Order`);
    }

    // Resolved before BEGIN: the WO's own issue_location_id (set at
    // creation, but routed through resolveLocationId again for the same
    // "trust it if given, otherwise fall back to RM Store" safety net every
    // other caller of this helper gets) and Shop Floor as the fixed WIP
    // destination — never the WO's receive_location_id, which is the FG
    // side used later by Step 6.
    const issueLocationId = await resolveLocationId(wo.issue_location_id, "RM Store");
    const wipLocationId = await resolveLocationId(null, "Shop Floor");

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    let anyIssued = false;

    for (const line of lines) {
      // Batch Tracking Step 5: normalize into one or more batch sub-lines,
      // same pattern Step 3 used for GRN. `hasBatchInfo` distinguishes a
      // genuinely batch-aware call (new Work Order screen, Step 6) from a
      // legacy call that never mentions batches at all — those two cases
      // are validated differently below.
      const hasBatchInfo =
        (Array.isArray(line.batches) && line.batches.length > 0) ||
        (line.batch_no !== undefined && line.batch_no !== null && line.batch_no !== "");

      const subLines = Array.isArray(line.batches) && line.batches.length
        ? line.batches
        : [{ batch_no: line.batch_no ?? null, qty: line.qty }];

      const qty = subLines.reduce((sum, sub) => sum + (Number(sub.qty) || 0), 0);
      if (qty <= 0) continue;

      const compRow = await new Promise((resolve, reject) => {
        db.get(
          `
          SELECT wc.*, im.item_name AS component_item_name
          FROM work_order_components wc
          JOIN item_master im ON im.id = wc.component_item_id
          WHERE wc.wo_id = ? AND wc.component_item_id = ?
          `,
          [woId, line.component_item_id],
          (err, row) => (err ? reject(err) : resolve(row))
        );
      });
      if (!compRow) {
        throw new Error(`Component ${line.component_item_id} is not part of this Work Order`);
      }

      const pending = compRow.required_qty - compRow.issued_qty;
      if (qty > pending + 1e-6) {
        throw new Error(
          `Cannot issue ${qty} of "${compRow.component_item_name}" — only ${pending} still pending`
        );
      }

      const rate = await getCurrentComponentRate(compRow.component_item_id);

      if (hasBatchInfo) {
        // Batch-aware path: each sub-line is checked against — and draws
        // down — its own batch at the issue location, via Step 2's helper,
        // instead of the item-wide total.
        for (const sub of subLines) {
          const subQty = Number(sub.qty) || 0;
          if (subQty <= 0) continue;

          const batchNo = sub.batch_no || null;

          const available = await getAvailableStockAtBatchLocation(
            compRow.component_item_id, issueLocationId, batchNo
          );
          if (subQty > available + 1e-6) {
            throw new Error(
              `Insufficient stock for "${compRow.component_item_name}"` +
              (batchNo ? ` in batch "${batchNo}"` : " with no batch") +
              ` at issue location. Available: ${available}`
            );
          }

          await new Promise((resolve, reject) => {
            db.run(
              `
              INSERT INTO stock_ledger
              (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id, batch_no)
              VALUES (?, ?, 'WO_ISSUE', ?, ?, ?, ?, ?)
              `,
              [compRow.component_item_id, date, wo.wo_no, subQty, rate, issueLocationId, batchNo],
              err => (err ? reject(err) : resolve())
            );
          });

          await new Promise((resolve, reject) => {
            db.run(
              `
              INSERT INTO stock_ledger
              (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id, batch_no)
              VALUES (?, ?, 'WO_ISSUE', ?, ?, ?, ?, ?)
              `,
              [compRow.component_item_id, date, wo.wo_no, subQty, rate, wipLocationId, batchNo],
              err => (err ? reject(err) : resolve())
            );
          });
        }
      } else {
        // Legacy path (no batch info sent at all): same item-wide stock
        // check and single un-batched pair of rows this endpoint always
        // wrote before Step 5. Kept so the Work Order screen keeps working
        // unchanged until Step 6 gives it a batch picker.
        const available = await getAvailableStockAtLocation(compRow.component_item_id, issueLocationId);
        if (qty > available + 1e-6) {
          throw new Error(
            `Insufficient stock for "${compRow.component_item_name}" at issue location. Available: ${available}`
          );
        }

        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id)
            VALUES (?, ?, 'WO_ISSUE', ?, ?, ?, ?)
            `,
            [compRow.component_item_id, date, wo.wo_no, qty, rate, issueLocationId],
            err => (err ? reject(err) : resolve())
          );
        });

        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id)
            VALUES (?, ?, 'WO_ISSUE', ?, ?, ?, ?)
            `,
            [compRow.component_item_id, date, wo.wo_no, qty, rate, wipLocationId],
            err => (err ? reject(err) : resolve())
          );
        });
      }

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE work_order_components SET issued_qty = issued_qty + ? WHERE id = ?`,
          [qty, compRow.id],
          err => (err ? reject(err) : resolve())
        );
      });

      anyIssued = true;
    }

    if (!anyIssued) {
      throw new Error("At least one issue line with a quantity greater than zero is required");
    }

    if (wo.status === "DRAFT") {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE work_order SET status = 'ISSUED' WHERE id = ?`,
          [woId],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success" });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* Greedily allocates `qtyNeeded` across `batches` (already FEFO-sorted by
   the caller's query — earliest expiry first, un-batched stock last), same
   "earliest expiry consumed first, spill into the next batch once one runs
   out" logic the Work Order screen's allocateFEFO (Step 6) uses client-side
   for issue defaults — this is the server-side equivalent used at
   completion time (Step 7), where it drives what's actually written rather
   than just a pre-filled qty box. The guardrail already checked before this
   runs (requiredForNewTotal <= issued_qty) guarantees SUM(batches.available)
   is enough to cover qtyNeeded barring floating-point noise; the tiny
   `remaining` leftover fallback below exists only to absorb that noise
   without throwing, not to handle a real shortfall. */
function allocateBatchesFEFO(batches, qtyNeeded) {
  let remaining = qtyNeeded;
  const allocations = [];
  for (const b of batches) {
    if (remaining <= 1e-9) break;
    const avail = Number(b.available) || 0;
    const alloc = Math.min(avail, remaining);
    if (alloc > 1e-9) {
      allocations.push({ batch_no: b.batch_no, qty: alloc });
      remaining -= alloc;
    }
  }
  if (remaining > 1e-6) {
    allocations.push({ batch_no: null, qty: remaining });
  }
  return allocations;
}

/* -------------------- WORK ORDER — FG COMPLETION (Production Phase, Step 6) --------------------
   Turns issued-to-Shop-Floor WIP value into finished goods. Takes a
   completedQty and, for each component line, works out how much of that
   component's requirement is consumed for THIS batch — qty_per_unit ×
   completedQty, the same per-unit ratio explodeBOMForQuantity (Step 2)
   used to derive required_qty in the first place.

   Each component is priced at the WEIGHTED AVERAGE rate it was actually
   pulled onto Shop Floor at: total value posted there for that component
   across every WO_ISSUE line so far (SUM(qty_in × rate) from
   stock_ledger, scoped to this WO's voucher_no), divided by its
   cumulative issued_qty. If a component has never been issued
   (issued_qty = 0), this falls back to getCurrentComponentRate — the same
   live-rate helper computeBOMCost (Phase 3 Step 5) uses — so completing
   without a full issue trail doesn't produce a zero-cost FG.

   Batch Tracking Step 7: each component's consumedThisCall qty is no
   longer written as one qty_out row — it's split across whatever batches
   are actually sitting on Shop Floor for this component under this WO's
   own wo_no (GROUP BY batch_no over that item+wo+location's WO_ISSUE/
   WO_COMPLETE rows, net of anything a prior completion call already
   consumed) and posted FEFO via allocateBatchesFEFO above, so each
   resulting qty_out row carries forward the batch_no of whichever batch
   was actually drawn down. Pricing is unchanged — every batch of a given
   component within one completion call still posts at that component's
   single weighted-average rate computed below; only the qty is split by
   batch, not the valuation.

   Every component posts its own qty_out row(s) at Shop Floor (its own
   item_id, the consumed-this-batch qty, at the rate above) — this is what
   actually relieves Shop Floor's held WIP value component by component,
   mirroring how it was built up component by component at issue time.
   The FG side is a single qty_in row at receive_location_id for
   completedQty of the FG item, valued at total_cost / completedQty — so
   the FG's cost per unit is whatever it actually cost in real component
   value, not a re-estimated BOM standard cost.

   Batch Tracking Step 8: that FG qty_in row now also carries a freshly
   generated batch_no — `${wo_no}-B${completion_seq + 1}` — since one WO
   can complete in several partial calls and each needs its own distinct
   FG batch identity, not one shared batch for the whole WO. The seq is
   reserved by bumping work_order.completion_seq in the same transaction
   that writes the row, so a later call never reuses a batch number even
   if two calls complete the exact same qty. Every component batch that
   fed into this FG batch (the same per-batch allocations Step 7 already
   computes for the WO_COMPLETE qty_out rows) is also recorded in a
   batch_genealogy table — fg_batch_no -> component_batch_no, qty — giving
   forward/backward traceability without having to re-derive it later by
   re-querying stock_ledger. See GET /work-order/:id/fg-batches.

   Guardrail (Step 7): a component can't be consumed past what's actually
   been issued for this WO — qty_per_unit × (this WO's completed_qty
   INCLUDING this call) must not exceed that component's issued_qty. This
   is checked, and every line priced, BEFORE BEGIN — same "resolve/validate
   first, then open the transaction" ordering /issue above uses — so a
   failed guardrail on any one line never leaves a half-open transaction
   or a partial completion behind.

   completed_qty accumulates on the work_order header (repeat calls
   allowed, same "can be called more than once, tracked cumulatively"
   shape as GRN against a PO); status flips to COMPLETED once
   completed_qty reaches target_qty. Blocked entirely against a
   CANCELLED/COMPLETED WO (Step 7).

   Pass `preview: true` to run every guardrail check and the full cost
   computation WITHOUT writing anything — no transaction is opened and no
   stock_ledger/work_order rows change. This is what the Work Order
   screen's "Complete" action (Step 8) calls first to show the computed
   cost/unit before the user confirms; the confirm step is the exact same
   request with `preview` omitted (or false). */
app.post("/work-order/:id/complete", async (req, res) => {
  const woId = req.params.id;
  const { date, completedQty, preview } = req.body;

  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }
  const qtyNow = Number(completedQty);
  if (!qtyNow || qtyNow <= 0) {
    return res.status(400).json({ error: "completedQty must be greater than 0" });
  }

  let transactionStarted = false;
  try {
    const wo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM work_order WHERE id = ?`, [woId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!wo) throw new Error("Work Order not found");
    if (wo.status === "CANCELLED" || wo.status === "COMPLETED") {
      throw new Error(`Cannot complete against a ${wo.status} Work Order`);
    }

    const components = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT wc.*, im.item_name AS component_item_name
        FROM work_order_components wc
        JOIN item_master im ON im.id = wc.component_item_id
        WHERE wc.wo_id = ?
        `,
        [woId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const completedSoFar = wo.completed_qty || 0;
    const newCompletedTotal = completedSoFar + qtyNow;
    if (newCompletedTotal > wo.target_qty + 1e-6) {
      throw new Error(
        `Cannot complete ${qtyNow} — only ${wo.target_qty - completedSoFar} still pending against the target qty`
      );
    }

    const receiveLocationId = await resolveLocationId(wo.receive_location_id, "FG Store");
    const wipLocationId = await resolveLocationId(null, "Shop Floor");

    // Price every line and check the issued-material guardrail up front —
    // nothing below this point writes anything, whether this call is a
    // real completion or just a preview.
    const linesToPost = [];
    let totalCost = 0;

    for (const c of components) {
      const consumedThisCall = c.qty_per_unit * qtyNow;
      if (consumedThisCall <= 0) continue;

      const requiredForNewTotal = c.qty_per_unit * newCompletedTotal;
      if (requiredForNewTotal > c.issued_qty + 1e-6) {
        throw new Error(
          `Cannot complete ${qtyNow} — "${c.component_item_name}" only has ${c.issued_qty} issued`
        );
      }

      let rate;
      if (c.issued_qty > 0) {
        const issuedValueRow = await new Promise((resolve, reject) => {
          db.get(
            `
            SELECT IFNULL(SUM(qty_in * rate), 0) AS total_value
            FROM stock_ledger
            WHERE voucher_type = 'WO_ISSUE' AND voucher_no = ? AND item_id = ? AND location_id = ?
            `,
            [wo.wo_no, c.component_item_id, wipLocationId],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });
        rate = issuedValueRow.total_value / c.issued_qty;
      } else {
        rate = await getCurrentComponentRate(c.component_item_id);
      }

      // Batch Tracking Step 7: this component's current batch breakdown on
      // Shop Floor for this WO — WO_ISSUE qty_in less anything a prior
      // completion call already consumed via WO_COMPLETE qty_out, net per
      // batch_no. Expiry (used to sort FEFO) isn't stored on the WIP-side
      // rows themselves — Step 5 deliberately kept those to just batch_no —
      // so it's looked up from wherever this item+batch_no combination was
      // first tagged with one (its GRN row).
      const batchRows = await new Promise((resolve, reject) => {
        db.all(
          `
          SELECT
            wip.batch_no,
            (SELECT MAX(expiry_date) FROM stock_ledger e
              WHERE e.item_id = wip.item_id AND e.batch_no = wip.batch_no) AS expiry_date,
            IFNULL(SUM(wip.qty_in),0) - IFNULL(SUM(wip.qty_out),0) AS available
          FROM stock_ledger wip
          WHERE wip.voucher_type IN ('WO_ISSUE','WO_COMPLETE')
            AND wip.voucher_no = ? AND wip.item_id = ? AND wip.location_id = ?
          GROUP BY wip.batch_no
          HAVING available > 0.000001
          ORDER BY (wip.batch_no IS NULL) ASC, (expiry_date IS NULL) ASC, expiry_date ASC
          `,
          [wo.wo_no, c.component_item_id, wipLocationId],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
      const batchAllocations = allocateBatchesFEFO(batchRows, consumedThisCall);

      const lineCost = consumedThisCall * rate;
      totalCost += lineCost;
      linesToPost.push({
        component_item_id: c.component_item_id,
        component_item_name: c.component_item_name,
        qty: consumedThisCall,
        rate,
        line_cost: lineCost,
        batches: batchAllocations
      });
    }

    if (!linesToPost.length) {
      throw new Error("This Work Order has no component requirement to consume for that quantity");
    }

    const fgRate = totalCost / qtyNow;

    // Batch Tracking Step 8: the FG batch this call would produce, reserved
    // as (completion_seq + 1) — computed here (before the preview check) so
    // preview can show the user what batch number they're about to create,
    // without actually reserving/writing it. wo_no + a per-WO completion
    // sequence, since one WO can complete in several partial calls and each
    // needs its own distinct batch identity even at the same qty.
    const nextSeq = (wo.completion_seq || 0) + 1;
    const fgBatchNo = `${wo.wo_no}-B${nextSeq}`;

    if (preview) {
      return res.json({
        status: "preview",
        components: linesToPost,
        total_cost: totalCost,
        fg_rate: fgRate,
        completed_qty_total_if_confirmed: newCompletedTotal,
        fg_batch_no: fgBatchNo
      });
    }

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    for (const line of linesToPost) {
      // One qty_out row per batch this component's consumption was
      // allocated to (Step 7), each carrying that batch's batch_no
      // forward — instead of a single un-batched row for the whole line.
      for (const alloc of line.batches) {
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id, batch_no)
            VALUES (?, ?, 'WO_COMPLETE', ?, ?, ?, ?, ?)
            `,
            [line.component_item_id, date, wo.wo_no, alloc.qty, line.rate, wipLocationId, alloc.batch_no],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

    // FG qty_in row now carries batch_no = fgBatchNo (Step 8) — the FG
    // comes out of this completion call as one freshly-generated batch,
    // same as every other batch-tagged qty_in row (GRN, Step 3).
    await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO stock_ledger
        (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id, batch_no)
        VALUES (?, ?, 'WO_COMPLETE', ?, ?, ?, ?, ?)
        `,
        [wo.fg_item_id, date, wo.wo_no, qtyNow, fgRate, receiveLocationId, fgBatchNo],
        err => (err ? reject(err) : resolve())
      );
    });

    // Batch genealogy (Step 8): one row per component batch this FG batch
    // actually drew from — straight off the same per-batch allocations
    // (line.batches, from Step 7's allocateBatchesFEFO) that were just
    // posted as WO_COMPLETE qty_out rows above, so genealogy always matches
    // what the ledger says was consumed. A component batch allocation of
    // batch_no: null (un-batched stock) still gets a row, just with
    // component_batch_no left NULL.
    for (const line of linesToPost) {
      for (const alloc of line.batches) {
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO batch_genealogy
            (fg_item_id, fg_batch_no, component_item_id, component_batch_no, qty, wo_no, date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [wo.fg_item_id, fgBatchNo, line.component_item_id, alloc.batch_no, alloc.qty, wo.wo_no, date],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

    // completed_qty and completion_seq both advance together — the qty
    // total for progress-against-target, the seq counter so the *next*
    // completion call (if any) reserves the next batch number after this
    // one, never reusing fgBatchNo.
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE work_order SET completed_qty = completed_qty + ?, completion_seq = completion_seq + 1 WHERE id = ?`,
        [qtyNow, woId],
        err => (err ? reject(err) : resolve())
      );
    });

    if (newCompletedTotal >= wo.target_qty - 1e-6) {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE work_order SET status = 'COMPLETED' WHERE id = ?`,
          [woId],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({
      status: "success",
      total_cost: totalCost,
      fg_rate: fgRate,
      completed_qty_total: newCompletedTotal,
      fg_batch_no: fgBatchNo
    });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER — SCRAP / REJECTION (Scrap & Reorder Alerts, Step 3) --------------------
   Posts a scrap/wastage entry against a Work Order — either the FG itself
   (rejected finished output) or one of its BOM components (material
   spoiled/rejected mid-production) — as a real stock movement INTO the
   'Scrap' location (Step 2) rather than a silent delete from stock_ledger,
   same "stays valued, reportable, auditable" reasoning QC Hold already
   established for quality-hold stock.

   item_id is validated against this WO's own frozen snapshot — it must be
   either the WO's fg_item_id or one of its work_order_components rows
   (component_item_id) — so scrap can't be posted for an arbitrary item
   through this door; only what the WO actually touches.

   "Wherever that item currently sits for this WO" resolves to one of two
   fixed locations, mirroring the issue/complete flow (Steps 6/7): the FG
   sits at the WO's own receive_location_id (FG Store by default) once
   completed; a component sits at Shop Floor (wipLocationId) once issued.
   There's no location param on this endpoint — scrap of the FG always
   debits FG Store, scrap of a component always debits Shop Floor.

   Batch Tracking reuse (Step 2/7): rather than writing a single un-batched
   qty_out, this pulls the FEFO-sorted batch breakdown actually sitting at
   that location for this item (same shape GET /stock/:itemId/batches
   already exposes to the UI) and allocates the scrap qty across it via
   Step 7's allocateBatchesFEFO — so a batched item's scrap debits a real
   batch (or several, oldest first), not an arbitrary/un-batched row. The
   total-at-location is guarded up front (same "check the sum before
   allocating" ordering /issue and /complete both use), and
   getAvailableStockAtBatchLocation (Step 2) is re-checked per allocated
   batch immediately before each insert — the same defensive "re-verify
   with the shared helper right before writing" pattern /issue's
   batch-aware path uses, rather than trusting the batchRows snapshot
   fetched a moment earlier.

   For each batch allocation this writes a matching pair of stock_ledger
   rows — qty_out at the item's resolved location, qty_in at Scrap — both
   voucher_type = 'SCRAP', voucher_no = wo.wo_no (reusing the WO's own
   number as the voucher label, same convention WO_ISSUE/WO_COMPLETE
   already use), carrying the allocated batch_no forward on both sides so
   the Scrap location itself stays batch-traceable back to source.

   rate is caller-supplied (the Scrap panel, Step 4, lets the user set
   it — scrap is typically valued near-zero or at a write-off rate, not
   necessarily the item's live cost), defaulting to 0 if omitted so a pure
   write-off with no residual value doesn't force the caller to guess a
   number.

   A single wo_scrap header row (qty/rate as entered, not split per batch)
   is written alongside the stock_ledger postings — see that table's
   comment above for why.

   Does NOT touch work_order_components.issued_qty, work_order.completed_qty,
   or work_order.status — scrap is a side posting against material/FG that
   already exists in the ledger, not a correction to the WO's own
   production progress. A scrapped component still shows as "issued" (it
   was), a scrapped FG still counts toward "completed" (it was produced,
   then rejected); Step 5's scrap-history endpoint is what surfaces the
   wastage total alongside those figures rather than netting it out of
   them.

   Blocked only against a CANCELLED Work Order — unlike /issue and
   /complete, scrap against a COMPLETED WO is allowed (rejecting a finished
   unit, or writing off leftover issued material, can happen after the WO
   itself is done). */
app.post("/work-order/:id/scrap", async (req, res) => {
  const woId = req.params.id;
  const { item_id, qty, rate, date, narration } = req.body;

  const itemId = Number(item_id);
  const qtyNum = Number(qty);

  if (!itemId) {
    return res.status(400).json({ error: "item_id is required" });
  }
  if (!qtyNum || qtyNum <= 0) {
    return res.status(400).json({ error: "qty must be greater than 0" });
  }
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }

  const rateNum = (rate === undefined || rate === null || rate === "") ? 0 : Number(rate);

  let transactionStarted = false;
  try {
    const wo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM work_order WHERE id = ?`, [woId], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!wo) throw new Error("Work Order not found");
    if (wo.status === "CANCELLED") {
      throw new Error("Cannot post scrap against a CANCELLED Work Order");
    }

    // item_id must be the WO's own FG or one of its frozen component
    // lines — resolved here (rather than trusted from the request) both
    // to validate it and to get item_name for error messages below.
    const isFG = Number(wo.fg_item_id) === itemId;
    let itemName;

    if (isFG) {
      const fgRow = await new Promise((resolve, reject) => {
        db.get(`SELECT item_name FROM item_master WHERE id = ?`, [itemId], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (!fgRow) throw new Error("Item not found");
      itemName = fgRow.item_name;
    } else {
      const compRow = await new Promise((resolve, reject) => {
        db.get(
          `
          SELECT im.item_name
          FROM work_order_components wc
          JOIN item_master im ON im.id = wc.component_item_id
          WHERE wc.wo_id = ? AND wc.component_item_id = ?
          `,
          [woId, itemId],
          (err, row) => (err ? reject(err) : resolve(row))
        );
      });
      if (!compRow) {
        throw new Error("item_id must be this Work Order's FG item or one of its components");
      }
      itemName = compRow.item_name;
    }

    const sourceLocationId = isFG
      ? await resolveLocationId(wo.receive_location_id, "FG Store")
      : await resolveLocationId(null, "Shop Floor");
    const scrapLocationId = await resolveLocationId(null, "Scrap");
    const sourceLocationLabel = isFG ? "FG Store" : "Shop Floor";

    // FEFO-sorted batch breakdown for this item at its resolved location —
    // same query shape as GET /stock/:itemId/batches (Step 6), used here
    // server-side to drive allocateBatchesFEFO instead of just rendering a
    // picker.
    const batchRows = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          batch_no,
          MAX(expiry_date) AS expiry_date,
          IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
        FROM stock_ledger
        WHERE item_id = ? AND location_id = ?
        GROUP BY batch_no
        HAVING available > 0.000001
        ORDER BY (batch_no IS NULL) ASC, (expiry_date IS NULL) ASC, expiry_date ASC
        `,
        [itemId, sourceLocationId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const totalAvailable = batchRows.reduce((sum, b) => sum + (Number(b.available) || 0), 0);
    if (qtyNum > totalAvailable + 1e-6) {
      throw new Error(
        `Insufficient stock for "${itemName}" at ${sourceLocationLabel}. Available: ${totalAvailable}`
      );
    }

    const allocations = allocateBatchesFEFO(batchRows, qtyNum);

    db.run("BEGIN TRANSACTION");
    transactionStarted = true;

    const scrapId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO wo_scrap (wo_id, wo_no, item_id, qty, rate, date, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [woId, wo.wo_no, itemId, qtyNum, rateNum, date, narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const alloc of allocations) {
      const stillAvailable = await getAvailableStockAtBatchLocation(itemId, sourceLocationId, alloc.batch_no);
      if (alloc.qty > stillAvailable + 1e-6) {
        throw new Error(
          `Insufficient stock for "${itemName}"` +
          (alloc.batch_no ? ` in batch "${alloc.batch_no}"` : " with no batch") +
          ` at ${sourceLocationLabel}. Available: ${stillAvailable}`
        );
      }

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id, batch_no)
          VALUES (?, ?, 'SCRAP', ?, ?, ?, ?, ?)
          `,
          [itemId, date, wo.wo_no, alloc.qty, rateNum, sourceLocationId, alloc.batch_no],
          err => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id, batch_no)
          VALUES (?, ?, 'SCRAP', ?, ?, ?, ?, ?)
          `,
          [itemId, date, wo.wo_no, alloc.qty, rateNum, scrapLocationId, alloc.batch_no],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({
      status: "success",
      id: scrapId,
      item_id: itemId,
      qty: qtyNum,
      rate: rateNum,
      location: sourceLocationLabel,
      batches: allocations
    });
  } catch (err) {
    if (transactionStarted) db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER — SCRAP HISTORY (Scrap & Reorder Alerts, Step 5) --------------------
   GET /work-order/:id/scrap — this WO's cumulative scrap/rejection
   postings, one row per item (FG and/or components), so the WO screen can
   show "X units / ₹Y scrapped" without re-deriving it from raw
   stock_ledger SCRAP rows. Same "own header table next to the ledger
   postings it drives" reasoning as wo_scrap itself: Step 3 already writes
   one wo_scrap row per scrap call (qty/rate as entered, not split per
   FEFO batch), so summing straight off that table gives the right total
   directly — no need to reconstruct it from the (possibly multi-batch)
   stock_ledger pairs each call fans out into.

   Grouped by item_id (not one row per posting) since a WO can be scrapped
   against more than once for the same item over its life, and the screen
   wants one cumulative figure per item, same shape /fg-batches (Step 8,
   Batch Tracking) uses for "one row per thing that happened" but rolled
   up. value is SUM(qty*rate) per item — the actual total written off,
   not qty × a single rate, since different scrap calls for the same item
   can carry different rates (near-zero write-off vs a partial-value
   rate).

   Also returns wo-level total_qty/total_value (sums across items) so a
   caller that just wants the headline "₹Y scrapped" figure for this WO
   doesn't have to re-sum the items array itself. */
app.get("/work-order/:id/scrap", async (req, res) => {
  try {
    const wo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM work_order WHERE id = ?`, [req.params.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!wo) return res.status(404).json({ error: "Work Order not found" });

    const items = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT ws.item_id, im.item_name, im.unit,
               SUM(ws.qty) AS qty,
               SUM(ws.qty * ws.rate) AS value
        FROM wo_scrap ws
        JOIN item_master im ON im.id = ws.item_id
        WHERE ws.wo_id = ?
        GROUP BY ws.item_id
        ORDER BY MIN(ws.id) ASC
        `,
        [wo.id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const totals = items.reduce(
      (acc, r) => {
        acc.total_qty += Number(r.qty) || 0;
        acc.total_value += Number(r.value) || 0;
        return acc;
      },
      { total_qty: 0, total_value: 0 }
    );

    res.json({
      wo_no: wo.wo_no,
      items,
      total_qty: totals.total_qty,
      total_value: totals.total_value
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER — FG BATCH GENEALOGY (Batch Tracking, Step 8) --------------------
   Lists every FG batch this Work Order has produced (one row per
   completion call, oldest first) with its qty/date/rate straight off the
   WO_COMPLETE qty_in rows at the WO's receive location, plus — per FG
   batch — the component-batch breakdown that fed into it, straight off
   batch_genealogy. This is what the Work Order screen shows after each
   completion so a genuinely batch-tracked FG's ancestry is visible without
   the user having to go dig through the Item Wise Report. */
app.get("/work-order/:id/fg-batches", async (req, res) => {
  try {
    const wo = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM work_order WHERE id = ?`, [req.params.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!wo) return res.status(404).json({ error: "Work Order not found" });

    const receiveLocationId = await resolveLocationId(wo.receive_location_id, "FG Store");

    const batches = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT batch_no AS fg_batch_no, date, SUM(qty_in) AS qty,
               SUM(qty_in * rate) / SUM(qty_in) AS rate
        FROM stock_ledger
        WHERE voucher_type = 'WO_COMPLETE' AND voucher_no = ? AND item_id = ?
          AND location_id = ? AND batch_no IS NOT NULL
        GROUP BY batch_no, date
        ORDER BY id ASC
        `,
        [wo.wo_no, wo.fg_item_id, receiveLocationId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    for (const b of batches) {
      b.components = await new Promise((resolve, reject) => {
        db.all(
          `
          SELECT bg.component_item_id, im.item_name AS component_item_name,
                 bg.component_batch_no, bg.qty
          FROM batch_genealogy bg
          JOIN item_master im ON im.id = bg.component_item_id
          WHERE bg.fg_batch_no = ? AND bg.fg_item_id = ?
          ORDER BY bg.id ASC
          `,
          [b.fg_batch_no, wo.fg_item_id],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });
    }

    res.json({ wo_no: wo.wo_no, fg_item_id: wo.fg_item_id, batches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- WORK ORDER — CANCEL (Production Phase, Step 7) --------------------
   Only succeeds against a DRAFT Work Order. Status flips DRAFT -> ISSUED
   on the very first successful issue (Step 4), so "status is still DRAFT"
   and "nothing has been issued yet" are the same condition here — no
   separate SUM(issued_qty) check needed. An ISSUED/COMPLETED WO has
   already moved real stock onto (or out of) Shop Floor; unwinding that
   isn't a clean no-op the way cancelling an untouched DRAFT is, so this
   deliberately does NOT attempt to reverse ledger entries — it just
   refuses, the same way PO cancel refuses once anything's been received
   or invoiced against it. */
app.post("/work-order/:id/cancel", (req, res) => {
  const woId = req.params.id;

  db.get(`SELECT * FROM work_order WHERE id = ?`, [woId], (err, wo) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!wo) return res.status(404).json({ error: "Work Order not found" });
    if (wo.status !== "DRAFT") {
      return res.status(400).json({
        error: `Cannot cancel — this Work Order is ${wo.status}. Only a DRAFT Work Order with nothing issued can be cancelled.`
      });
    }

    db.run(`UPDATE work_order SET status = 'CANCELLED' WHERE id = ?`, [woId], err2 => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ status: "success" });
    });
  });
});

/* -------------------- SAVE SALES INVOICE -------------------- */

app.post("/sales/save", async (req, res) => {
  const { date, customer, invoiceNo, items, taxType, clientId, so_id, location_id } = req.body;

  if (!date || !customer || !invoiceNo || !items?.length) {
    return res.status(400).json({ error: "Invalid sales data" });
  }

  let companyName, companyGstin, companyAddress, companyState, client, clientState;
  try {
    // Seller (our own) GST profile, for the invoice PDF and for deriving
    // CGST+SGST vs IGST below.
    [companyName, companyGstin, companyAddress] = await Promise.all([
      getSetting("company_name", ""),
      getSetting("company_gstin", ""),
      getSetting("company_address", "")
    ]);
    companyState = getGstStateFromGstin(companyGstin);

    client = clientId
      ? await new Promise((resolve, reject) => {
          db.get(`SELECT * FROM clients WHERE id = ?`, [clientId], (err, row) =>
            err ? reject(err) : resolve(row)
          );
        })
      : null;
    clientState = client ? getGstStateFromGstin(client.gstin) : null;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Whenever both our GSTIN (Settings) and the client's GSTIN (Client
  // master) are on file and valid, derive CGST+SGST vs IGST definitively
  // by comparing their state codes — this is what the invoice is legally
  // required to reflect, and it shouldn't depend on someone remembering to
  // pick the right dropdown option. The manual "Sale Type" selection is
  // only used as a fallback for unregistered/B2C customers (no GSTIN on
  // file) or before a company GSTIN has been set up in Settings.
  const isInterState = (companyState && clientState)
    ? companyState.code !== clientState.code
    : taxType === "INTER";

  // Every line must resolve to a valid supply_type before any totals are
  // computed off it — EXEMPT/NIL_RATED/ZERO_RATED lines bill at 0% GST
  // regardless of whatever gst_rate the item master (or a stale frontend
  // form) happens to be carrying. Defaults to TAXABLE when the line
  // doesn't specify one, so invoices from a frontend that hasn't been
  // updated to send supply_type yet keep behaving exactly as before.
  for (const item of items) {
    const supplyType = normalizeSupplyType(item.supply_type);
    if (!supplyType) {
      return res.status(400).json({
        error: `Invalid supply_type "${item.supply_type}" on line "${item.description || item.item_id}". Must be one of ${VALID_SUPPLY_TYPES.join(", ")}.`
      });
    }
    item.supply_type = supplyType;
    item.gst_rate = supplyType === "TAXABLE" ? (Number(item.gst_rate) || 0) : 0;
  }

  const totalAmount = items.reduce((s, i) => s + i.amount, 0);
  const totalGst = items.reduce(
    (s, i) => s + i.amount * ((Number(i.gst_rate) || 0) / 100),
    0
  );
  const grandTotal = totalAmount + totalGst;

  try {
    // Guard: an invoice raised against a Sales Order can never invoice more
    // than has actually been delivered via Delivery Challan. Without this
    // check, a customer could be invoiced — and booked as a debtor — for
    // goods that were never dispatched. Mirrors the received_qty guard on
    // the purchase side.
    if (so_id) {
      for (const item of items) {
        if (!item.so_item_id) continue;
        const soItem = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM sales_order_items WHERE id = ? AND so_id = ?`,
            [item.so_item_id, so_id],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });
        if (!soItem) {
          return res.status(400).json({ error: "Sales order line item not found" });
        }
        const availableToInvoice = soItem.delivered_qty - soItem.invoiced_qty;
        if (Number(item.qty) > availableToInvoice + 1e-6) {
          return res.status(400).json({
            error: `Cannot invoice ${item.qty} of "${soItem.item_name}" — only ${availableToInvoice} delivered and not yet invoiced. Record a Delivery Challan first if more has actually gone out.`
          });
        }
      }
    }

    db.run("BEGIN TRANSACTION");

    /* 🔒 FINAL STOCK CHECK — skipped for items coming off a Sales Order,
       since that stock already left at the Delivery Challan stage and
       re-checking availability here would be checking against stock that
       isn't there to check (it's already gone, correctly). */
    if (!so_id) {
      for (const item of items) {
        const available = await getAvailableStock(item.item_id);
        if (available < item.qty) {
          throw new Error(
            `Insufficient stock for ${item.description}. Available: ${available}`
          );
        }
      }
    }

  await new Promise((resolve, reject) => {
    db.run(
      `
      INSERT OR IGNORE INTO ledger_master
      (ledger, ledger_group)
      VALUES (?, 'Sundry Debtors')
      `,
      [customer],
      err => err ? reject(err) : resolve()
    );
  });




    /* 1️⃣ ACCOUNTING ENTRY (customer debited full value, Sales + Output GST credited) */
    const entries = [
      { particulars: customer, debit: grandTotal, credit: 0 },
      { particulars: "Sales A/c", debit: 0, credit: totalAmount }
    ];

    if (totalGst > 0) {
      if (isInterState) {
        entries.push({ particulars: "Output IGST", debit: 0, credit: totalGst });
      } else {
        entries.push({ particulars: "Output CGST", debit: 0, credit: totalGst / 2 });
        entries.push({ particulars: "Output SGST", debit: 0, credit: totalGst / 2 });
      }
    }

    await saveJournalInternal({
      date,
      narration: `Sales Invoice ${invoiceNo}`,
      entries
    });

    /* 1️⃣b INVOICE HEADER + LINES — this is the first-class record that
       Receivables tracking (outstanding balance, ageing, payment
       allocation) hangs off of. The journal entry above books the
       accounting impact; this row is what lets us later ask "how much of
       invoice INV-0004 is still unpaid". */
    const cgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const sgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const igstAmt = isInterState ? totalGst : 0;

    const salesInvoiceId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO sales_invoice
        (invoice_no, date, customer, client_id, taxable_value, cgst, sgst, igst, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [invoiceNo, date, customer, clientId || null, totalAmount, cgstAmt, sgstAmt, igstAmt, grandTotal],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      const itemGst = item.amount * ((Number(item.gst_rate) || 0) / 100);
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO sales_invoice_items
          (invoice_id, item_id, description, hsn, qty, rate, taxable, gst_rate, gst_amount, total, supply_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [salesInvoiceId, item.item_id, item.description, item.hsn || null, item.qty, item.rate,
           item.amount, Number(item.gst_rate) || 0, itemGst, item.amount + itemGst, item.supply_type],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    /* 2️⃣ STOCK DEDUCTION — skipped when this invoice is against a Sales
       Order, because the goods already left at the Delivery Challan stage.
       Deducting again here would double-count the stock movement. */
    if (!so_id) {
      // Direct sales invoices (no SO) ship out of FG Store by default —
      // same convention the Step 3 backfill used for historical SALE rows.
      // A per-line item.location_id (future multi-location sale) wins over
      // the invoice-level location_id, which wins over the default.
      const defaultSaleLocationId = await resolveLocationId(location_id, "FG Store");
      for (const item of items) {
        const lineLocationId = item.location_id
          ? await resolveLocationId(item.location_id, "FG Store")
          : defaultSaleLocationId;
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id)
            VALUES (?, ?, 'SALE', ?, ?, ?, ?)
            `,
            [item.item_id, date, invoiceNo, item.qty, item.rate, lineLocationId],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

    /* 2️⃣b LINK BACK TO THE SALES ORDER, IF THIS INVOICE IS AGAINST ONE */
    if (so_id) {
      for (const item of items) {
        if (!item.so_item_id) continue;
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE sales_order_items SET invoiced_qty = invoiced_qty + ? WHERE id = ?`,
            [item.qty, item.so_item_id],
            err => (err ? reject(err) : resolve())
          );
        });
      }
      await recomputeSOStatus(so_id);
    }

    /* 3️⃣ PDF */
    await generateSalesInvoicePDF({
      invoiceNo,
      date,
      customer,
      items,
      amount: totalAmount,
      gstBreakup: totalGst > 0
        ? (isInterState
            ? { igst: totalGst }
            : { cgst: totalGst / 2, sgst: totalGst / 2 })
        : null,
      // Passed separately from gstBreakup so templates can tell "no GST
      // breakup because this is an intra-state supply" apart from "no GST
      // breakup because everything on this invoice is EXEMPT/NIL_RATED/
      // ZERO_RATED" — an all-zero-rated export invoice is still an
      // inter-state (export) transaction even though gstBreakup is null.
      isInterState,
      grandTotal,
      seller: { name: companyName, gstin: companyGstin, address: companyAddress },
      buyer: client ? { address: client.address, gstin: client.gstin } : null
    });

    db.run("COMMIT");
    res.json({
      status: "success",
      pdf: `/invoices/sales/${invoiceNo}.pdf`
    });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});


/* -------------------- SETTINGS API -------------------- */

// List of selectable invoice templates (id/name/description) for the frontend dropdown.
app.get("/settings/invoice-templates", (req, res) => {
  res.json({ templates: INVOICE_TEMPLATES });
});

// Get all current settings as a flat object, e.g. { invoice_template: "modern" }
app.get("/settings", (req, res) => {
  db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  });
});

// Save one or more settings at once, e.g. { invoice_template: "modern" }
app.post("/settings", async (req, res) => {
  const updates = req.body || {};
  const keys = Object.keys(updates);

  if (!keys.length) {
    return res.status(400).json({ error: "No settings provided" });
  }

  if (
    updates.invoice_template &&
    !INVOICE_TEMPLATES.some(t => t.id === updates.invoice_template)
  ) {
    return res.status(400).json({ error: "Unknown invoice_template" });
  }

  if (updates.whatsapp_provider && !["twilio", "meta"].includes(updates.whatsapp_provider)) {
    return res.status(400).json({ error: "whatsapp_provider must be 'twilio' or 'meta'" });
  }

  // Annual turnover drives the mandatory HSN digit-length rule (CBIC
  // Notification 78/2020) enforced on item creation/update below.
  if (updates.annual_turnover !== undefined && updates.annual_turnover !== "") {
    const turnover = Number(updates.annual_turnover);
    if (!Number.isFinite(turnover) || turnover < 0) {
      return res.status(400).json({ error: "annual_turnover must be a non-negative number (in rupees)." });
    }
    updates.annual_turnover = String(turnover);
  }

  // Company GSTIN (used as "our" GSTIN for the seller block on invoices and
  // to auto-determine CGST+SGST vs IGST against each client's GSTIN) must
  // be a properly formatted 15-character GSTIN if set at all.
  if (updates.company_gstin) {
    const cleanGstin = normalizeGstin(updates.company_gstin);
    if (!isValidGstin(cleanGstin)) {
      return res.status(400).json({
        error: "Invalid Company GSTIN. Expected a 15-character GSTIN like 27ABCDE1234F1Z5."
      });
    }
    updates.company_gstin = cleanGstin;
  }

  try {
    for (const key of keys) {
      await setSetting(key, updates[key]);
    }
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- EMAIL SENDING -------------------- */

// Send a quick test email to confirm the SMTP settings work.
app.post("/settings/test-email", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Recipient email required" });

  try {
    await sendEmail({
      to,
      subject: "Test email from your accounting software",
      text: "This is a test email. If you received this, your email settings are working correctly."
    });
    res.json({ status: "success" });
  } catch (err) {
    console.error("TEST EMAIL ERROR:", err);
    res.status(400).json({ error: err.message });
  }
});

// Email a generated sales invoice PDF to a client.
app.post("/invoices/send-email", async (req, res) => {
  const { invoiceNo, clientId, email: emailOverride, message } = req.body;

  if (!invoiceNo) {
    return res.status(400).json({ error: "invoiceNo is required" });
  }

  const pdfPath = path.join(DATA_DIR, "invoices", "sales", `${invoiceNo}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).json({ error: `No PDF found for invoice ${invoiceNo}` });
  }

  try {
    // Resolve recipient: explicit override wins, otherwise look up the linked client.
    let recipientEmail = emailOverride;
    let resolvedClientId = clientId || null;

    if (!recipientEmail && clientId) {
      const client = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM clients WHERE id = ?`, [clientId], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (!client) throw new Error("Client not found");
      if (!client.email) throw new Error(`${client.name} has no email address on file`);
      recipientEmail = client.email;
    }

    if (!recipientEmail) {
      throw new Error("No recipient email provided and no client linked to this invoice");
    }

    await sendEmail({
      to: recipientEmail,
      subject: `Invoice ${invoiceNo}`,
      text: message || `Please find attached invoice ${invoiceNo}.\n\nThank you for your business.`,
      attachments: [
        {
          filename: `${invoiceNo}.pdf`,
          path: pdfPath
        }
      ]
    });

    logEmailAttempt({
      invoice_no: invoiceNo,
      client_id: resolvedClientId,
      email: recipientEmail,
      status: "sent"
    });

    res.json({ status: "success", sentTo: recipientEmail });
  } catch (err) {
    console.error("SEND INVOICE EMAIL ERROR:", err);
    logEmailAttempt({
      invoice_no: invoiceNo,
      client_id: clientId || null,
      email: emailOverride || null,
      status: "failed",
      error: err.message
    });
    res.status(400).json({ error: err.message });
  }
});

// Delivery history for a given invoice (shown as a small status line in the UI).
app.get("/invoices/email-log/:invoiceNo", (req, res) => {
  db.all(
    `SELECT * FROM email_log WHERE invoice_no = ? ORDER BY id DESC`,
    [req.params.invoiceNo],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- WHATSAPP SENDING (Twilio + Meta) --------------------
   Which provider actually sends the message is picked at request time
   from the "whatsapp_provider" setting ("twilio", the default, or
   "meta"). Both integrations stay fully wired up regardless of which is
   currently selected - switching providers is just a Settings change.
------------------------------------------------------------------ */

// Send a quick test WhatsApp message to confirm the WhatsApp settings work.
app.post("/settings/test-whatsapp", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Recipient phone number required" });

  const metaCfg = await getMetaWhatsAppConfig();
  const provider = metaCfg.whatsapp_provider === "meta" ? "meta" : "twilio";

  try {
    if (provider === "meta") {
      const phone = normalizePhoneForMeta(to, "");
      // Uses whatever template is configured (falls back to Meta's
      // pre-approved "hello_world" sample template, which needs no
      // params), so this works out of the box before you've created a
      // custom invoice template.
      const hasCustomTemplate = !!metaCfg.meta_whatsapp_template_name;
      await sendWhatsAppMeta({
        to: phone,
        ...(hasCustomTemplate
          ? {
              bodyParams: [
                "Test",
                "SETTINGS-CHECK",
                new Date().toLocaleDateString("en-IN"),
                "If you received this, your WhatsApp settings are working correctly."
              ]
            }
          : {})
      });
      return res.json({ status: "success", sentTo: phone, provider });
    }

    const cfg = await getWhatsAppConfig();
    const phone = normalizePhoneForWhatsApp(to, cfg.whatsapp_default_country_code);
    // Uses the same Content Template as invoice sends, so this test
    // actually verifies the path you'll rely on in production.
    await sendWhatsApp({
      to: phone,
      contentVariables: {
        "1": "Test",
        "2": "SETTINGS-CHECK",
        "3": new Date().toLocaleDateString("en-IN"),
        "4": "If you received this, your WhatsApp settings are working correctly."
      }
    });
    res.json({ status: "success", sentTo: phone, provider });
  } catch (err) {
    console.error("TEST WHATSAPP ERROR:", err);
    res.status(400).json({ error: err.message });
  }
});

// WhatsApp a generated sales invoice PDF to a client.
app.post("/invoices/send-whatsapp", async (req, res) => {
  const { invoiceNo, clientId, phone: phoneOverride, message } = req.body;

  if (!invoiceNo) {
    return res.status(400).json({ error: "invoiceNo is required" });
  }

  const pdfPath = path.join(DATA_DIR, "invoices", "sales", `${invoiceNo}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).json({ error: `No PDF found for invoice ${invoiceNo}` });
  }

  let resolvedClientId = clientId || null;
  let recipientPhone = phoneOverride;
  const metaCfg = await getMetaWhatsAppConfig();
  const provider = metaCfg.whatsapp_provider === "meta" ? "meta" : "twilio";

  try {
    const cfg = provider === "meta" ? metaCfg : await getWhatsAppConfig();

    // Resolve recipient: explicit override wins, otherwise look up the linked client.
    if (!recipientPhone && clientId) {
      const client = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM clients WHERE id = ?`, [clientId], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (!client) throw new Error("Client not found");
      if (!client.phone) throw new Error(`${client.name} has no phone number on file`);
      recipientPhone = client.phone;
    }

    if (!recipientPhone) {
      throw new Error("No recipient phone number provided and no client linked to this invoice");
    }

    const publicBaseUrl = provider === "meta"
      ? (process.env.PUBLIC_BASE_URL || (await getSetting("public_base_url", "")))
      : cfg.public_base_url;
    const mediaUrl = publicBaseUrl
      ? `${publicBaseUrl.replace(/\/$/, "")}/invoices/sales/${invoiceNo}.pdf`
      : null;

    // Invoice notifications are business-initiated (the client hasn't just
    // messaged us), so WhatsApp requires an approved template rather than
    // a free-form message, on either provider.
    const bodyParams = [
      "Invoice",
      invoiceNo,
      new Date().toLocaleDateString("en-IN"),
      message || mediaUrl || `Invoice ${invoiceNo}`
    ];

    let normalizedPhone;
    if (provider === "meta") {
      normalizedPhone = normalizePhoneForMeta(recipientPhone, "");
      await sendWhatsAppMeta({
        to: normalizedPhone,
        bodyParams,
        documentHeaderLink: mediaUrl
      });
    } else {
      normalizedPhone = normalizePhoneForWhatsApp(recipientPhone, cfg.whatsapp_default_country_code);
      // In the Sandbox we're limited to Twilio's pre-approved "Order
      // Notifications" template: "Your {{1}} order of {{2}} has shipped
      // and should be delivered on {{3}}. Details: {{4}}" - repurposed
      // here for testing. Swap this mapping for your own template's
      // fields once you register a real WhatsApp Sender for production.
      await sendWhatsApp({
        to: normalizedPhone,
        contentVariables: {
          "1": bodyParams[0],
          "2": bodyParams[1],
          "3": bodyParams[2],
          "4": bodyParams[3]
        }
      });
    }

    logWhatsAppAttempt({
      invoice_no: invoiceNo,
      client_id: resolvedClientId,
      phone: normalizedPhone,
      status: "sent",
      provider
    });

    res.json({ status: "success", sentTo: normalizedPhone, provider });
  } catch (err) {
    console.error("SEND INVOICE WHATSAPP ERROR:", err);
    logWhatsAppAttempt({
      invoice_no: invoiceNo,
      client_id: resolvedClientId,
      phone: recipientPhone || null,
      status: "failed",
      error: err.message,
      provider
    });
    res.status(400).json({ error: err.message });
  }
});

// Delivery history for a given invoice (shown as a small status line in the UI).
app.get("/invoices/whatsapp-log/:invoiceNo", (req, res) => {
  db.all(
    `SELECT * FROM whatsapp_log WHERE invoice_no = ? ORDER BY id DESC`,
    [req.params.invoiceNo],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- WHATSAPP WEBHOOK (Meta) --------------------
   Meta requires a reachable webhook URL to finish connecting a WhatsApp
   number, even if you don't process inbound messages yet. Point it at
   `${PUBLIC_BASE_URL}/webhooks/whatsapp` in Meta App > WhatsApp >
   Configuration, using META_WHATSAPP_VERIFY_TOKEN as the verify token,
   subscribed to the "messages" field. Incoming events (delivery status
   updates and any replies) are stored as raw JSON in whatsapp_webhook_log
   for now - fetch that table if you need to build read receipts or a
   two-way chat later.
------------------------------------------------------------------ */

// Meta calls this once, synchronously, to verify you control the URL.
app.get("/webhooks/whatsapp", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const cfg = await getMetaWhatsAppConfig();
  if (mode === "subscribe" && token && cfg.meta_whatsapp_verify_token && token === cfg.meta_whatsapp_verify_token) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta POSTs every delivery status update and inbound message here.
app.post("/webhooks/whatsapp", (req, res) => {
  try {
    db.run(
      `INSERT INTO whatsapp_webhook_log (direction, payload) VALUES ('inbound', ?)`,
      [JSON.stringify(req.body || {})]
    );
  } catch (err) {
    console.error("WHATSAPP WEBHOOK LOG ERROR:", err);
  }
  // Must respond 200 quickly or Meta will retry/disable the webhook.
  res.sendStatus(200);
});

/* -------------------- EXPOSE INVOICES FOLDER (DOWNLOADABLE) -------------------- */

app.use(
  "/invoices",
  express.static(path.join(DATA_DIR, "invoices"))
);


/* -------------------- ITEM API (POST) -------------------- */


app.post("/item/create", async (req, res) => {
  const {
    item_code,
    item_name,
    unit,
    gst_rate,
    selling_price,
    opening_qty,
    opening_rate
  } = req.body;
  const hsn = String(req.body.hsn || "").trim();
  const unitUpper = String(unit || "").trim().toUpperCase();

  if (!item_name || !unit || gst_rate == null) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isValidUqc(unitUpper)) {
    return res.status(400).json({
      error: `Unit must be a standard GST Unit Quantity Code (UQC), e.g. NOS, KGS, PCS, BOX, MTR. Got "${unit}". See /reference/uqc for the full list.`
    });
  }

  const supplyType = normalizeSupplyType(req.body.supply_type);
  if (!supplyType) {
    return res.status(400).json({
      error: `supply_type must be one of ${VALID_SUPPLY_TYPES.join(", ")}. Got "${req.body.supply_type}".`
    });
  }
  // EXEMPT / NIL_RATED are 0% by definition — force it here so the item
  // master can never carry a non-zero rate against a non-taxable
  // classification. ZERO_RATED keeps whatever rate was submitted (see the
  // comment on normalizeSupplyType above for why).
  const effectiveGstRate = (supplyType === "EXEMPT" || supplyType === "NIL_RATED") ? 0 : gst_rate;

  // item_type: defaults to FINISHED_GOOD (see normalizeItemType) when not
  // supplied at all, but rejects anything sent that isn't a recognized
  // value — same "loud failure on bad input" behavior as supply_type.
  const itemType = normalizeItemType(req.body.item_type);
  if (!itemType) {
    return res.status(400).json({
      error: `item_type must be one of ${VALID_ITEM_TYPES.join(", ")}. Got "${req.body.item_type}".`
    });
  }

  const conversionCheck = validateUnitConversion(unitUpper, req.body.secondary_unit, req.body.conversion_factor);
  if (!conversionCheck.ok) {
    return res.status(400).json({ error: conversionCheck.error });
  }
  const { secondary_unit: secondaryUnit, conversion_factor: conversionFactor } = conversionCheck;

  // reorder_level / reorder_qty (Scrap & Reorder Alerts, Step 6): both
  // optional on create, defaulting to 0 — same "0 means low-stock alerts
  // are off for this item" convention the Step 1 schema migration
  // established, so an item created without either field simply opts out
  // rather than needing a separate enabled flag.
  const reorderLevel = req.body.reorder_level != null ? Number(req.body.reorder_level) : 0;
  const reorderQty = req.body.reorder_qty != null ? Number(req.body.reorder_qty) : 0;
  if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
    return res.status(400).json({ error: "reorder_level must be a non-negative number" });
  }
  if (!Number.isFinite(reorderQty) || reorderQty < 0) {
    return res.status(400).json({ error: "reorder_qty must be a non-negative number" });
  }

  let annualTurnover;
  try {
    annualTurnover = await getSetting("annual_turnover", 0);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const hsnCheck = validateHsnForTurnover(hsn, annualTurnover);
  if (!hsnCheck.ok) {
    return res.status(400).json({ error: hsnCheck.error });
  }

  // Resolved up front (RM Store default, matches the Step 3 backfill's
  // OPENING → RM Store rule) so it's ready before the transaction below —
  // avoids racing db.run("COMMIT") with an async lookup inside the
  // item_master insert callback.
  let openingLocationId = null;
  if (opening_qty && opening_qty > 0) {
    try {
      openingLocationId = await resolveLocationId(req.body.opening_location_id, "RM Store");
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `
      INSERT INTO item_master
      (item_code, item_name, hsn, unit, gst_rate, selling_price, opening_qty, opening_rate, supply_type, item_type, secondary_unit, conversion_factor, reorder_level, reorder_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        item_code,
        item_name,
        hsn,
        unitUpper,
        effectiveGstRate,
        selling_price || 0,
        opening_qty || 0,
        opening_rate || 0,
        supplyType,
        itemType,
        secondaryUnit,
        conversionFactor,
        reorderLevel,
        reorderQty
      ],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const itemId = this.lastID;

        // OPENING STOCK → STOCK LEDGER (location resolved above, before
        // the transaction started).
        if (opening_qty && opening_qty > 0) {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id)
            VALUES (?, DATE('now'), 'OPENING', 'OPENING', ?, ?, ?)
            `,
            [itemId, opening_qty, opening_rate || 0, openingLocationId]
          );
        }

        db.run("COMMIT");
        res.json({ status: "success", item_id: itemId });
      }
    );
  });
});


/* -------------------- ITEM UPDATE API (fix/backfill HSN, UQC, etc.) -------------------- */

app.put("/item/:id", async (req, res) => {
  const itemId = req.params.id;
  const { item_code, item_name, unit, gst_rate, selling_price } = req.body;
  const hsn = String(req.body.hsn || "").trim();
  const unitUpper = String(unit || "").trim().toUpperCase();

  if (!item_name || !unit || gst_rate == null) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isValidUqc(unitUpper)) {
    return res.status(400).json({
      error: `Unit must be a standard GST Unit Quantity Code (UQC), e.g. NOS, KGS, PCS, BOX, MTR. Got "${unit}". See /reference/uqc for the full list.`
    });
  }

  const supplyType = normalizeSupplyType(req.body.supply_type);
  if (!supplyType) {
    return res.status(400).json({
      error: `supply_type must be one of ${VALID_SUPPLY_TYPES.join(", ")}. Got "${req.body.supply_type}".`
    });
  }
  const effectiveGstRate = (supplyType === "EXEMPT" || supplyType === "NIL_RATED") ? 0 : gst_rate;

  // item_type is editable after creation — unlike gst_rate-adjacent fields,
  // an item's role in the business can legitimately change over its life
  // (e.g. a component that becomes sellable on its own as a spare part).
  // Same loud-failure-on-bad-input behavior as create.
  const itemType = normalizeItemType(req.body.item_type);
  if (!itemType) {
    return res.status(400).json({
      error: `item_type must be one of ${VALID_ITEM_TYPES.join(", ")}. Got "${req.body.item_type}".`
    });
  }

  const conversionCheck = validateUnitConversion(unitUpper, req.body.secondary_unit, req.body.conversion_factor);
  if (!conversionCheck.ok) {
    return res.status(400).json({ error: conversionCheck.error });
  }
  const { secondary_unit: secondaryUnit, conversion_factor: conversionFactor } = conversionCheck;

  // reorder_level / reorder_qty (Scrap & Reorder Alerts, Step 6): editable
  // after creation, same as every other item_master field this endpoint
  // touches. Same "optional, defaults to 0" behavior as create — an
  // update call that omits either field resets it to 0 (alerts off)
  // rather than leaving the previous value untouched, matching how this
  // endpoint already treats selling_price (`selling_price || 0`) rather
  // than doing a partial/PATCH-style merge.
  const reorderLevel = req.body.reorder_level != null ? Number(req.body.reorder_level) : 0;
  const reorderQty = req.body.reorder_qty != null ? Number(req.body.reorder_qty) : 0;
  if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
    return res.status(400).json({ error: "reorder_level must be a non-negative number" });
  }
  if (!Number.isFinite(reorderQty) || reorderQty < 0) {
    return res.status(400).json({ error: "reorder_qty must be a non-negative number" });
  }

  let annualTurnover;
  try {
    annualTurnover = await getSetting("annual_turnover", 0);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const hsnCheck = validateHsnForTurnover(hsn, annualTurnover);
  if (!hsnCheck.ok) {
    return res.status(400).json({ error: hsnCheck.error });
  }

  db.run(
    `
    UPDATE item_master
    SET item_code = ?, item_name = ?, hsn = ?, unit = ?, gst_rate = ?, selling_price = ?, supply_type = ?, item_type = ?, secondary_unit = ?, conversion_factor = ?, reorder_level = ?, reorder_qty = ?
    WHERE id = ?
    `,
    [item_code, item_name, hsn, unitUpper, effectiveGstRate, selling_price || 0, supplyType, itemType, secondaryUnit, conversionFactor, reorderLevel, reorderQty, itemId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Item not found" });
      res.json({ status: "success", item_id: Number(itemId) });
    }
  );
});


/* -------------------- FIXED ASSET API (FAM Step 4 + Step 5) --------------------
   Asset Master module — mirrors the Item Master pattern above (create,
   get-by-id, search), plus Step 5's two capitalization paths: manual entry
   (below, in /asset/create) and capitalizing an existing Purchase Invoice
   line (/asset/capitalize-from-purchase-invoice, further down). The
   Depreciation Run (Step 7) and Transfers/Disposals (Step 8) are later
   steps and are not implemented here — Step 6's computeDepreciation()
   engine above is ready for the Run to call once it lands. */

// Small local promise wrappers, same convention /purchase/save (path b's
// journal + invoice writes) already uses inline — lets these two new
// async-heavy endpoints read top-to-bottom instead of nesting callbacks.
function dbGetP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAllP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRunP(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

/* Category dropdown source for the Asset Master form. Read-only for now —
   categories are seeded in Step 3; a category CRUD screen can be added
   later the same way Locations got one, without changing this shape. */
app.get("/asset-categories", (req, res) => {
  db.all(
    `
    SELECT id, category_name, ledger, depreciation_method, depreciation_rate, useful_life_years
    FROM asset_category_master
    WHERE is_active = 1
    ORDER BY category_name
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Manual capitalization — Step 5 path (a). Two sub-modes, chosen by
   capitalization_mode:
     OPENING          — just registers the asset, no journal (see
                        VALID_CAPITALIZATION_MODES comment above).
     MANUAL_PURCHASE  — registers the asset AND posts Dr <category ledger>
                        / Cr credit_ledger for the acquisition cost, same
                        saveJournalInternal call payroll's loan disbursement
                        uses. credit_ledger is typically "Bank A/c" (paid
                        immediately) or a Sundry Creditors ledger (bought on
                        credit, matching the "reusing saveJournalInternal
                        exactly like payroll's loan disbursement" guidance
                        in the plan). */
app.post("/asset/create", async (req, res) => {
  const {
    asset_code,
    asset_name,
    category_id,
    location_id,
    acquisition_date,
    acquisition_cost,
    salvage_value,
    tag_code,
    credit_ledger
  } = req.body;

  if (!asset_name || !String(asset_name).trim()) {
    return res.status(400).json({ error: "Asset name is required" });
  }
  if (!category_id) {
    return res.status(400).json({ error: "Category is required" });
  }
  if (!acquisition_date) {
    return res.status(400).json({ error: "Acquisition date is required" });
  }
  const cost = Number(acquisition_cost);
  if (!Number.isFinite(cost) || cost < 0) {
    return res.status(400).json({ error: "Acquisition cost must be a non-negative number" });
  }
  const salvage = salvage_value != null ? Number(salvage_value) : 0;
  if (!Number.isFinite(salvage) || salvage < 0) {
    return res.status(400).json({ error: "Salvage value must be a non-negative number" });
  }
  if (salvage > cost) {
    return res.status(400).json({ error: "Salvage value cannot exceed acquisition cost" });
  }

  const capitalizationMode = normalizeCapitalizationMode(req.body.capitalization_mode);
  if (!capitalizationMode) {
    return res.status(400).json({
      error: `capitalization_mode must be one of ${VALID_CAPITALIZATION_MODES.join(", ")}. Got "${req.body.capitalization_mode}".`
    });
  }
  // Posting a journal only makes sense once the asset actually has cost —
  // an OPENING-mode entry at zero cost (e.g. a fully-depreciated legacy
  // asset kept on the register for tracking) is fine with no journal, but
  // MANUAL_PURCHASE with a positive cost needs somewhere for the credit
  // side to land.
  if (capitalizationMode === "MANUAL_PURCHASE" && cost > 0 && !credit_ledger) {
    return res.status(400).json({ error: "credit_ledger is required for capitalization_mode MANUAL_PURCHASE (e.g. \"Bank A/c\" or the supplier's ledger)" });
  }

  // depreciation_method / useful_life_years / depreciation_rate: if the
  // request overrides them, validate the override; otherwise fall through
  // to null here and backfill from the category row below once it's
  // fetched. This is the "snapshot the category's default onto the asset
  // at creation time" behavior described on the fixed_asset table comment.
  let depreciationMethod = null;
  if (req.body.depreciation_method != null && String(req.body.depreciation_method).trim() !== "") {
    depreciationMethod = normalizeDepreciationMethod(req.body.depreciation_method);
    if (!depreciationMethod) {
      return res.status(400).json({
        error: `depreciation_method must be one of ${VALID_DEPRECIATION_METHODS.join(", ")}. Got "${req.body.depreciation_method}".`
      });
    }
  }
  const usefulLifeOverride = req.body.useful_life_years != null && req.body.useful_life_years !== ""
    ? Number(req.body.useful_life_years) : null;
  const depreciationRateOverride = req.body.depreciation_rate != null && req.body.depreciation_rate !== ""
    ? Number(req.body.depreciation_rate) : null;

  try {
    const category = await dbGetP(
      `SELECT id, ledger, depreciation_method, depreciation_rate, useful_life_years FROM asset_category_master WHERE id = ? AND is_active = 1`,
      [category_id]
    );
    if (!category) return res.status(400).json({ error: `Invalid category_id: ${category_id}` });

    const finalMethod = depreciationMethod || category.depreciation_method;
    const finalUsefulLife = usefulLifeOverride != null ? usefulLifeOverride : category.useful_life_years;
    const finalRate = depreciationRateOverride != null ? depreciationRateOverride : category.depreciation_rate;

    // location_id is optional at asset-creation time (unlike opening
    // stock's RM Store default) — a newly acquired asset may not be
    // physically placed yet. Left NULL if not supplied, same "nullable
    // for now" stance resolveLocationId falls back to.
    const locationId = location_id || null;

    // Post the journal BEFORE inserting the asset row: saveJournalInternal
    // validates credit_ledger against ledger_master and rejects with an
    // Error if it's not a real ledger, and we'd rather fail loudly before
    // creating a fixed_asset row than create one with no matching journal.
    let voucherNo = null;
    if (capitalizationMode === "MANUAL_PURCHASE" && cost > 0) {
      voucherNo = await saveJournalInternal({
        date: acquisition_date,
        narration: `Capitalization of "${asset_name}" as Fixed Asset`,
        entries: [
          { particulars: category.ledger, debit: cost, credit: 0 },
          { particulars: credit_ledger, debit: 0, credit: cost }
        ]
      });
    }

    const result = await dbRunP(
      `
      INSERT INTO fixed_asset
      (asset_code, asset_name, category_id, location_id, acquisition_date, acquisition_cost, salvage_value, useful_life_years, depreciation_method, depreciation_rate, tag_code, capitalization_mode, journal_voucher_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        asset_code || null,
        asset_name,
        category_id,
        locationId,
        acquisition_date,
        cost,
        salvage,
        finalUsefulLife,
        finalMethod,
        finalRate,
        tag_code || null,
        capitalizationMode,
        voucherNo
      ]
    );

    res.json({ status: "success", asset_id: result.lastID, voucher_no: voucherNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Get one asset, with category name / ledger and location name resolved
   for display — same "join for display, store references" shape as the
   rest of the app's :id endpoints. */
app.get("/asset/:id", (req, res) => {
  db.get(
    `
    SELECT
      fa.*,
      ac.category_name,
      ac.ledger AS category_ledger,
      l.location_name
    FROM fixed_asset fa
    JOIN asset_category_master ac ON ac.id = fa.category_id
    LEFT JOIN locations l ON l.id = fa.location_id
    WHERE fa.id = ?
    `,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Asset not found" });
      res.json(row);
    }
  );
});

/* Asset search — same shape as /items/search (LIKE on code/name, top 20),
   plus category/location names resolved so the Assets.html results list
   doesn't need a second round-trip per row. capitalization_mode is
   included (FAM Step 5) so the register can show HOW each asset came in —
   Opening / Manual Purchase / Purchase Invoice. */
app.get("/assets/search", (req, res) => {
  const q = `%${req.query.q || ""}%`;

  db.all(
    `
    SELECT
      fa.id,
      fa.asset_code,
      fa.asset_name,
      fa.acquisition_date,
      fa.acquisition_cost,
      fa.status,
      fa.capitalization_mode,
      ac.category_name,
      l.location_name
    FROM fixed_asset fa
    JOIN asset_category_master ac ON ac.id = fa.category_id
    LEFT JOIN locations l ON l.id = fa.location_id
    WHERE fa.asset_name LIKE ? OR fa.asset_code LIKE ?
    ORDER BY fa.created_at DESC
    LIMIT 20
    `,
    [q, q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Purchase Invoice lines still available to capitalize — Step 5 path (b)'s
   picker source. WHERE capitalized_asset_id IS NULL excludes lines already
   turned into an asset (see the column comment above). Matches on item
   name, invoice number, or supplier so a user can find "that CNC lathe
   invoice from March" a few different ways, same LIKE-search shape as
   /items/search and /assets/search above. */
app.get("/purchase-invoice-items/capitalizable", (req, res) => {
  const q = `%${req.query.q || ""}%`;

  db.all(
    `
    SELECT
      pii.id AS purchase_invoice_item_id,
      pii.item_name,
      pii.qty,
      pii.rate,
      pii.taxable,
      pii.gst_amount,
      pii.total,
      pi.id AS invoice_id,
      pi.invoice_no,
      pi.date,
      pi.supplier
    FROM purchase_invoice_items pii
    JOIN purchase_invoice pi ON pi.id = pii.invoice_id
    WHERE pii.capitalized_asset_id IS NULL
      AND (pii.item_name LIKE ? OR pi.invoice_no LIKE ? OR pi.supplier LIKE ?)
    ORDER BY pi.date DESC, pi.id DESC
    LIMIT 20
    `,
    [q, q, q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Capitalize an existing Purchase Invoice line into a fixed_asset row —
   Step 5 path (b). The purchase was already booked to Purchases A/c when
   the invoice was saved (see /purchase/save), so this posts a
   RECLASSIFICATION journal — Dr <category ledger> / Cr Purchases A/c — for
   the line's taxable (pre-GST) value, moving it off the P&L and onto the
   Balance Sheet without touching the supplier or GST entries that invoice
   already posted. */
app.post("/asset/capitalize-from-purchase-invoice", async (req, res) => {
  const {
    purchase_invoice_item_id,
    asset_code,
    asset_name,
    category_id,
    location_id,
    tag_code
  } = req.body;

  if (!purchase_invoice_item_id) {
    return res.status(400).json({ error: "purchase_invoice_item_id is required" });
  }
  if (!category_id) {
    return res.status(400).json({ error: "Category is required" });
  }

  try {
    const line = await dbGetP(
      `
      SELECT pii.*, pi.invoice_no, pi.date AS invoice_date
      FROM purchase_invoice_items pii
      JOIN purchase_invoice pi ON pi.id = pii.invoice_id
      WHERE pii.id = ?
      `,
      [purchase_invoice_item_id]
    );
    if (!line) return res.status(404).json({ error: "Purchase invoice line not found" });
    if (line.capitalized_asset_id) {
      return res.status(400).json({ error: `This line was already capitalized as asset #${line.capitalized_asset_id}` });
    }

    const cost = Number(line.taxable) || 0;
    if (cost <= 0) {
      return res.status(400).json({ error: "This line has no positive taxable value to capitalize" });
    }

    const category = await dbGetP(
      `SELECT id, ledger, depreciation_method, depreciation_rate, useful_life_years FROM asset_category_master WHERE id = ? AND is_active = 1`,
      [category_id]
    );
    if (!category) return res.status(400).json({ error: `Invalid category_id: ${category_id}` });

    const salvageValue = req.body.salvage_value != null && req.body.salvage_value !== ""
      ? Number(req.body.salvage_value) : 0;
    if (!Number.isFinite(salvageValue) || salvageValue < 0 || salvageValue > cost) {
      return res.status(400).json({ error: "Salvage value must be a non-negative number not exceeding the acquisition cost" });
    }

    let depreciationMethod = null;
    if (req.body.depreciation_method != null && String(req.body.depreciation_method).trim() !== "") {
      depreciationMethod = normalizeDepreciationMethod(req.body.depreciation_method);
      if (!depreciationMethod) {
        return res.status(400).json({
          error: `depreciation_method must be one of ${VALID_DEPRECIATION_METHODS.join(", ")}. Got "${req.body.depreciation_method}".`
        });
      }
    }
    const usefulLifeOverride = req.body.useful_life_years != null && req.body.useful_life_years !== ""
      ? Number(req.body.useful_life_years) : null;
    const depreciationRateOverride = req.body.depreciation_rate != null && req.body.depreciation_rate !== ""
      ? Number(req.body.depreciation_rate) : null;

    const finalMethod = depreciationMethod || category.depreciation_method;
    const finalUsefulLife = usefulLifeOverride != null ? usefulLifeOverride : category.useful_life_years;
    const finalRate = depreciationRateOverride != null ? depreciationRateOverride : category.depreciation_rate;
    const finalAssetName = asset_name && String(asset_name).trim() ? asset_name : line.item_name;
    const locationId = location_id || null;

    const voucherNo = await saveJournalInternal({
      date: line.invoice_date,
      narration: `Capitalization of "${finalAssetName}" from Purchase Invoice ${line.invoice_no} as Fixed Asset`,
      entries: [
        { particulars: category.ledger, debit: cost, credit: 0 },
        { particulars: "Purchases A/c", debit: 0, credit: cost }
      ]
    });

    const result = await dbRunP(
      `
      INSERT INTO fixed_asset
      (asset_code, asset_name, category_id, location_id, acquisition_date, acquisition_cost, salvage_value, useful_life_years, depreciation_method, depreciation_rate, tag_code, capitalization_mode, journal_voucher_no, source_purchase_invoice_id, source_purchase_invoice_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PURCHASE_INVOICE', ?, ?, ?)
      `,
      [
        asset_code || null,
        finalAssetName,
        category_id,
        locationId,
        line.invoice_date,
        cost,
        salvageValue,
        finalUsefulLife,
        finalMethod,
        finalRate,
        tag_code || null,
        voucherNo,
        line.invoice_id,
        line.id
      ]
    );

    await dbRunP(
      `UPDATE purchase_invoice_items SET capitalized_asset_id = ? WHERE id = ?`,
      [result.lastID, line.id]
    );

    res.json({ status: "success", asset_id: result.lastID, voucher_no: voucherNo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- DEPRECIATION RUN HELPERS (FAM Step 7) --------------------
   Both helpers only look at FINAL schedule rows — rows from a PROCESSED
   depreciation_run, or a run_id-less "stub" row a disposal posted directly
   (see /asset/:id/dispose) — never a DRAFT run's rows, so re-generating an
   unprocessed draft can't leak into another asset's opening WDV. */

// Opening WDV for a window starting at `beforeDate`: the closing_wdv of the
// latest final schedule row that ended before it. NULL means "nothing has
// ever been depreciated for this asset" — computeDepreciation() then falls
// back to acquisition_cost, exactly as Step 6's engine documents.
async function getOpeningWDV(assetId, beforeDate) {
  const row = await dbGetP(
    `
    SELECT ads.closing_wdv
    FROM asset_depreciation_schedule ads
    LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
    WHERE ads.asset_id = ?
      AND ads.period_end < ?
      AND (ads.run_id IS NULL OR dr.status = 'PROCESSED')
    ORDER BY ads.period_end DESC
    LIMIT 1
    `,
    [assetId, beforeDate]
  );
  return row ? row.closing_wdv : null;
}

// The single most recent final schedule row for an asset, regardless of
// window — used by /asset/:id/dispose to find where to start the stub
// charge from (the day after this row's period_end), not just what the
// opening WDV as of some particular date was.
async function getLastDepreciationPoint(assetId) {
  const row = await dbGetP(
    `
    SELECT ads.period_end, ads.closing_wdv
    FROM asset_depreciation_schedule ads
    LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
    WHERE ads.asset_id = ?
      AND (ads.run_id IS NULL OR dr.status = 'PROCESSED')
    ORDER BY ads.period_end DESC
    LIMIT 1
    `,
    [assetId]
  );
  return row || null;
}

// 'YYYY-MM-DD' -> the next calendar day, also as 'YYYY-MM-DD'. Used to turn
// "depreciated up to and including X" into "the stub period starts the day
// after X". Reuses parseISODate (Step 6) for the same UTC-midnight-safe
// parsing every other date helper in this file relies on.
function addOneDayISO(dateISO) {
  const d = parseISODate(dateISO);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* -------------------- DEPRECIATION RUN API (FAM Step 7) --------------------
   Batch depreciation for a period, DRAFT -> PROCESSED, same shape as
   payroll.js's /hr/payroll/run/* lifecycle: create (or refresh) a draft
   that computes a schedule row per eligible asset without touching the
   ledger, review it, then process to post ONE consolidated journal for the
   whole run. Only ACTIVE assets are considered — computeDepreciation()
   would return 0 for a DISPOSED/WRITTEN_OFF asset anyway, but filtering in
   the query means the schedule never even gets a zero-charge row for one.

   NOTE (deliberate simplification, same spirit as the leap-year comment on
   computeDepreciation): this does not detect or reject overlapping periods
   across different runs (e.g. a monthly run for July followed by an annual
   run spanning the same July) — a business is expected to run one
   consistent cadence (monthly XOR annual), same as computeDepreciation's
   own periodStart/periodEnd window is left to the caller to choose
   sensibly. */

app.post("/depreciation-run/create", async (req, res) => {
  const { period_start, period_end } = req.body || {};
  if (!period_start || !period_end) {
    return res.status(400).json({ error: "period_start and period_end are required" });
  }
  if (period_end < period_start) {
    return res.status(400).json({ error: "period_end cannot be before period_start" });
  }

  try {
    let run = await dbGetP(
      `SELECT * FROM depreciation_run WHERE period_start = ? AND period_end = ?`,
      [period_start, period_end]
    );
    let runId;
    if (run) {
      if (run.status !== "DRAFT") {
        return res.status(400).json({ error: `A run for ${period_start} to ${period_end} already exists and is ${run.status}` });
      }
      runId = run.id;
      // Re-generating a draft: wipe its old schedule rows first, same
      // delete-and-recompute-fresh pattern payroll_run/create uses.
      await dbRunP(`DELETE FROM asset_depreciation_schedule WHERE run_id = ?`, [runId]);
    } else {
      const r = await dbRunP(
        `INSERT INTO depreciation_run (period_start, period_end, status) VALUES (?, ?, 'DRAFT')`,
        [period_start, period_end]
      );
      runId = r.lastID;
    }

    const assets = await dbAllP(`SELECT * FROM fixed_asset WHERE status = 'ACTIVE'`);
    let assetsProcessed = 0;

    for (const asset of assets) {
      const openingWDV = await getOpeningWDV(asset.id, period_start);
      const charge = computeDepreciation(asset, period_start, period_end, openingWDV);
      if (charge <= 0) continue; // not yet acquired, fully depreciated, etc. — no row for it

      const base = openingWDV != null ? openingWDV : Number(asset.acquisition_cost);
      const closing = round2(base - charge);

      await dbRunP(
        `
        INSERT INTO asset_depreciation_schedule
        (asset_id, period, opening_wdv, depreciation_amount, closing_wdv, run_id, period_start, period_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [asset.id, `${period_start} to ${period_end}`, base, charge, closing, runId, period_start, period_end]
      );
      assetsProcessed++;
    }

    res.json({ status: "success", run_id: runId, assets_processed: assetsProcessed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/depreciation-run/list", (req, res) => {
  db.all(`SELECT * FROM depreciation_run ORDER BY period_start DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/depreciation-run/:id", async (req, res) => {
  try {
    const run = await dbGetP(`SELECT * FROM depreciation_run WHERE id = ?`, [req.params.id]);
    if (!run) return res.status(404).json({ error: "Not found" });

    const details = await dbAllP(
      `
      SELECT ads.*, fa.asset_code, fa.asset_name, ac.category_name
      FROM asset_depreciation_schedule ads
      JOIN fixed_asset fa ON fa.id = ads.asset_id
      JOIN asset_category_master ac ON ac.id = fa.category_id
      WHERE ads.run_id = ?
      ORDER BY fa.asset_name
      `,
      [req.params.id]
    );
    const total = round2(details.reduce((s, d) => s + d.depreciation_amount, 0));

    res.json({ run, details, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/depreciation-run/:id/process", async (req, res) => {
  try {
    const run = await dbGetP(`SELECT * FROM depreciation_run WHERE id = ?`, [req.params.id]);
    if (!run) return res.status(404).json({ error: "Not found" });
    if (run.status !== "DRAFT") return res.status(400).json({ error: `Run already ${run.status}` });

    const details = await dbAllP(`SELECT * FROM asset_depreciation_schedule WHERE run_id = ?`, [req.params.id]);
    if (!details.length) {
      return res.status(400).json({ error: "No depreciation to post for this period — no active asset accrued a charge" });
    }

    const total = round2(details.reduce((s, d) => s + d.depreciation_amount, 0));

    const voucherNo = await saveJournalInternal({
      date: run.period_end,
      narration: `Depreciation for ${run.period_start} to ${run.period_end} — Depreciation Run #${run.id}`,
      entries: [
        { particulars: "Depreciation A/c", debit: total, credit: 0 },
        { particulars: "Accumulated Depreciation A/c", debit: 0, credit: total }
      ]
    });

    await dbRunP(
      `UPDATE depreciation_run SET status = 'PROCESSED', journal_voucher_no = ?, processed_at = datetime('now') WHERE id = ?`,
      [voucherNo, req.params.id]
    );

    res.json({ status: "success", voucher_no: voucherNo, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/depreciation-run/:id/cancel", async (req, res) => {
  try {
    const run = await dbGetP(`SELECT * FROM depreciation_run WHERE id = ?`, [req.params.id]);
    if (!run) return res.status(404).json({ error: "Not found" });
    if (run.status !== "DRAFT") return res.status(400).json({ error: "Only DRAFT runs can be cancelled" });

    await dbRunP(`DELETE FROM asset_depreciation_schedule WHERE run_id = ?`, [req.params.id]);
    await dbRunP(`DELETE FROM depreciation_run WHERE id = ?`, [req.params.id]);

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Per-asset depreciation history — every final schedule row (batch runs
   AND disposal stubs), for the asset detail view in Assets.html. */
app.get("/asset/:id/depreciation-schedule", async (req, res) => {
  try {
    const rows = await dbAllP(
      `
      SELECT ads.*, dr.status AS run_status
      FROM asset_depreciation_schedule ads
      LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
      WHERE ads.asset_id = ?
      ORDER BY ads.period_end
      `,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- ASSET TRANSFERS & DISPOSALS (FAM Step 8) --------------------
   Transfers are pure location movement, no journal impact — same shape as
   Stock Transfer. Disposals post real money: a stub depreciation charge
   (if any depreciation has accrued since the last final schedule row) to
   bring the book value current as of the disposal date, then the disposal
   journal itself (remove accumulated depreciation and original cost from
   the books, recognize sale proceeds if any, and the resulting profit or
   loss). WRITE_OFF is simply SALE with sale_value forced to 0. */

app.post("/asset/:id/transfer", async (req, res) => {
  const { to_location_id, date, notes } = req.body || {};
  if (!to_location_id) return res.status(400).json({ error: "to_location_id is required" });
  if (!date) return res.status(400).json({ error: "date is required" });

  try {
    const asset = await dbGetP(`SELECT * FROM fixed_asset WHERE id = ?`, [req.params.id]);
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    if (asset.status !== "ACTIVE") return res.status(400).json({ error: `Cannot transfer a ${asset.status} asset` });

    const toLocation = await dbGetP(`SELECT id FROM locations WHERE id = ?`, [to_location_id]);
    if (!toLocation) return res.status(400).json({ error: `Invalid to_location_id: ${to_location_id}` });

    await dbRunP(
      `INSERT INTO asset_transfer (asset_id, from_location_id, to_location_id, date, notes) VALUES (?, ?, ?, ?, ?)`,
      [asset.id, asset.location_id, to_location_id, date, notes || null]
    );
    await dbRunP(`UPDATE fixed_asset SET location_id = ? WHERE id = ?`, [to_location_id, asset.id]);

    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/asset/:id/transfers", (req, res) => {
  db.all(
    `
    SELECT at.*, fl.location_name AS from_location_name, tl.location_name AS to_location_name
    FROM asset_transfer at
    LEFT JOIN locations fl ON fl.id = at.from_location_id
    LEFT JOIN locations tl ON tl.id = at.to_location_id
    WHERE at.asset_id = ?
    ORDER BY at.date DESC, at.id DESC
    `,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

const VALID_DISPOSAL_MODES = ["SALE", "WRITE_OFF"];

app.post("/asset/:id/dispose", async (req, res) => {
  const { date, sale_value, mode, credit_ledger, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });

  const disposalMode = String(mode || "SALE").trim().toUpperCase();
  if (!VALID_DISPOSAL_MODES.includes(disposalMode)) {
    return res.status(400).json({ error: `mode must be one of ${VALID_DISPOSAL_MODES.join(", ")}. Got "${mode}".` });
  }

  // WRITE_OFF is SALE with proceeds forced to 0 — no separate code path.
  const saleValue = disposalMode === "WRITE_OFF" ? 0 : (Number(sale_value) || 0);
  if (!Number.isFinite(saleValue) || saleValue < 0) {
    return res.status(400).json({ error: "sale_value cannot be negative" });
  }
  if (disposalMode === "SALE" && saleValue > 0 && !credit_ledger) {
    return res.status(400).json({ error: "credit_ledger is required when sale_value is greater than 0 (e.g. \"Bank A/c\" or the buyer's ledger)" });
  }

  try {
    const asset = await dbGetP(
      `
      SELECT fa.*, ac.ledger AS category_ledger
      FROM fixed_asset fa
      JOIN asset_category_master ac ON ac.id = fa.category_id
      WHERE fa.id = ?
      `,
      [req.params.id]
    );
    if (!asset) return res.status(404).json({ error: "Asset not found" });
    if (asset.status !== "ACTIVE") return res.status(400).json({ error: `Asset is already ${asset.status}` });
    if (date < asset.acquisition_date) return res.status(400).json({ error: "Disposal date cannot be before acquisition date" });

    // Stub charge: depreciate from wherever the last final schedule row
    // left off (or acquisition_date, if this asset was never depreciated)
    // up to the disposal date, so book value reflects depreciation right
    // up to disposal rather than stopping wherever the last completed
    // Depreciation Run (Step 7) happened to land.
    const lastPoint = await getLastDepreciationPoint(asset.id);
    const stubStart = lastPoint ? addOneDayISO(lastPoint.period_end) : asset.acquisition_date;
    const stubOpeningWDV = lastPoint ? lastPoint.closing_wdv : null;

    let stubCharge = 0;
    if (stubStart <= date) {
      stubCharge = computeDepreciation(asset, stubStart, date, stubOpeningWDV);
    }

    const baseWDV = stubOpeningWDV != null ? stubOpeningWDV : Number(asset.acquisition_cost);
    const bookValue = round2(baseWDV - stubCharge);
    const accumulatedDepreciation = round2(Number(asset.acquisition_cost) - bookValue);

    let stubVoucherNo = null;
    if (stubCharge > 0) {
      stubVoucherNo = await saveJournalInternal({
        date,
        narration: `Depreciation up to disposal of "${asset.asset_name}" (${stubStart} to ${date})`,
        entries: [
          { particulars: "Depreciation A/c", debit: stubCharge, credit: 0 },
          { particulars: "Accumulated Depreciation A/c", debit: 0, credit: stubCharge }
        ]
      });
      await dbRunP(
        `
        INSERT INTO asset_depreciation_schedule
        (asset_id, period, opening_wdv, depreciation_amount, closing_wdv, run_id, period_start, period_end)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        `,
        [asset.id, `Stub to disposal (${stubStart} to ${date})`, baseWDV, stubCharge, bookValue, stubStart, date]
      );
    }

    // Disposal journal: Dr Accumulated Depreciation (reverse what's been
    // charged so far), Dr credit_ledger for sale proceeds if any, Dr Loss /
    // Cr Profit on Sale for the balancing figure, Cr the category's asset
    // ledger for the full original cost (removes the asset from the books
    // at gross value). See the FAM Step 8 table comment above for why
    // this always balances.
    const profitLoss = round2(saleValue - bookValue);
    const entries = [];
    if (accumulatedDepreciation > 0) {
      entries.push({ particulars: "Accumulated Depreciation A/c", debit: accumulatedDepreciation, credit: 0 });
    }
    if (saleValue > 0) {
      entries.push({ particulars: credit_ledger, debit: saleValue, credit: 0 });
    }
    if (profitLoss > 0) {
      entries.push({ particulars: "Profit on Sale of Asset A/c", debit: 0, credit: profitLoss });
    } else if (profitLoss < 0) {
      entries.push({ particulars: "Loss on Sale of Asset A/c", debit: -profitLoss, credit: 0 });
    }
    if (Number(asset.acquisition_cost) > 0) {
      entries.push({ particulars: asset.category_ledger, debit: 0, credit: Number(asset.acquisition_cost) });
    }

    let disposalVoucherNo = null;
    if (entries.length) {
      disposalVoucherNo = await saveJournalInternal({
        date,
        narration: `${disposalMode === "WRITE_OFF" ? "Write-off" : "Disposal"} of "${asset.asset_name}" as Fixed Asset`,
        entries
      });
    }

    await dbRunP(
      `
      INSERT INTO asset_disposal
      (asset_id, date, sale_value, book_value_at_disposal, profit_loss, notes, mode, journal_voucher_no, stub_depreciation_voucher_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [asset.id, date, saleValue, bookValue, profitLoss, notes || null, disposalMode, disposalVoucherNo, stubVoucherNo]
    );

    await dbRunP(
      `UPDATE fixed_asset SET status = ?, disposal_date = ? WHERE id = ?`,
      [disposalMode === "WRITE_OFF" ? "WRITTEN_OFF" : "DISPOSED", date, asset.id]
    );

    res.json({
      status: "success",
      book_value_at_disposal: bookValue,
      profit_loss: profitLoss,
      stub_depreciation_voucher_no: stubVoucherNo,
      voucher_no: disposalVoucherNo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/asset/:id/disposal", (req, res) => {
  db.get(`SELECT * FROM asset_disposal WHERE asset_id = ? ORDER BY id DESC LIMIT 1`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || null);
  });
});

/* -------------------- FIXED ASSET REPORTS (FAM Step 9) --------------------
   Four reports named in the plan, following the same report-endpoint
   pattern as payroll's /hr/report/* (see payroll.js): each is a plain
   GET, does its own joins/aggregation in SQL where possible, and returns
   a flat rows array (plus a totals object where a report needs one) for
   the frontend to render straight into a table — no server-side PDF/HTML,
   same division of labor as the payroll reports. */

/* Fixed Asset Register: every asset with cost, accumulated depreciation,
   and WDV. accumulated_depreciation is summed from asset_depreciation_
   schedule's FINAL rows only (a PROCESSED run's rows, or a run_id-less
   disposal stub — see the FAM Step 7 helpers above) so a re-generated
   DRAFT run never inflates the figure. Summing the schedule (rather than
   re-deriving from acquisition_cost - book value some other way) means
   the same number this report shows is exactly what the Depreciation
   Run and Disposal journals actually posted to the Accumulated
   Depreciation ledger — the register can't drift from the books.
   For a DISPOSED/WRITTEN_OFF asset this naturally freezes at the book
   value/accumulated depreciation as of its disposal date (the disposal
   stub is the last schedule row ever written for it), which is the
   correct historical figure to show even though the asset has since
   left the books. ?status=ACTIVE|DISPOSED|WRITTEN_OFF filters; omitted
   returns all. */
app.get("/fam/report/asset-register", async (req, res) => {
  const { status, category_id, location_id } = req.query;
  try {
    const where = [];
    const params = [];
    if (status) { where.push("fa.status = ?"); params.push(status); }
    if (category_id) { where.push("fa.category_id = ?"); params.push(category_id); }
    if (location_id) { where.push("fa.location_id = ?"); params.push(location_id); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await dbAllP(
      `
      SELECT
        fa.id, fa.asset_code, fa.asset_name, fa.status, fa.acquisition_date,
        fa.acquisition_cost, fa.salvage_value, fa.depreciation_method, fa.depreciation_rate,
        ac.category_name, l.location_name,
        COALESCE((
          SELECT SUM(ads.depreciation_amount)
          FROM asset_depreciation_schedule ads
          LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
          WHERE ads.asset_id = fa.id AND (ads.run_id IS NULL OR dr.status = 'PROCESSED')
        ), 0) AS accumulated_depreciation
      FROM fixed_asset fa
      JOIN asset_category_master ac ON ac.id = fa.category_id
      LEFT JOIN locations l ON l.id = fa.location_id
      ${whereSql}
      ORDER BY ac.category_name, fa.asset_name
      `,
      params
    );

    const out = rows.map(r => ({
      ...r,
      accumulated_depreciation: round2(r.accumulated_depreciation),
      wdv: round2(Number(r.acquisition_cost) - r.accumulated_depreciation)
    }));

    const total = out.reduce((a, r) => ({
      acquisition_cost: round2(a.acquisition_cost + Number(r.acquisition_cost)),
      accumulated_depreciation: round2(a.accumulated_depreciation + r.accumulated_depreciation),
      wdv: round2(a.wdv + r.wdv)
    }), { acquisition_cost: 0, accumulated_depreciation: 0, wdv: 0 });

    res.json({ rows: out, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Depreciation Schedule report: period-wise, for audit — every FINAL
   schedule row (batch runs and disposal stubs), across all assets,
   optionally narrowed to a date window and/or a single asset/run.
   Unlike /asset/:id/depreciation-schedule (Step 7, one asset's own
   history for the Assets.html detail view) this is the cross-asset audit
   view: "show me everything that hit Accumulated Depreciation between
   these dates." from/to filter on period_end so a row is included if its
   period ENDED inside the window. */
app.get("/fam/report/depreciation-schedule", async (req, res) => {
  const { from, to, asset_id, run_id } = req.query;
  try {
    const where = ["(ads.run_id IS NULL OR dr.status = 'PROCESSED')"];
    const params = [];
    if (from) { where.push("ads.period_end >= ?"); params.push(from); }
    if (to) { where.push("ads.period_end <= ?"); params.push(to); }
    if (asset_id) { where.push("ads.asset_id = ?"); params.push(asset_id); }
    if (run_id) { where.push("ads.run_id = ?"); params.push(run_id); }

    const rows = await dbAllP(
      `
      SELECT
        ads.id, ads.asset_id, ads.period, ads.period_start, ads.period_end,
        ads.opening_wdv, ads.depreciation_amount, ads.closing_wdv, ads.run_id,
        fa.asset_code, fa.asset_name, ac.category_name
      FROM asset_depreciation_schedule ads
      LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
      JOIN fixed_asset fa ON fa.id = ads.asset_id
      JOIN asset_category_master ac ON ac.id = fa.category_id
      WHERE ${where.join(" AND ")}
      ORDER BY ads.period_end, fa.asset_name
      `,
      params
    );
    const total = round2(rows.reduce((s, r) => s + r.depreciation_amount, 0));
    res.json({ rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Asset-wise Profit/Loss on Disposal: every disposal (sale or write-off)
   with the asset's identity and category alongside the figures already
   computed and stored at disposal time (see /asset/:id/dispose, FAM Step
   8) — this report doesn't recompute anything, it just presents the
   asset_disposal rows. ?from/?to filter on disposal date. */
app.get("/fam/report/disposals", async (req, res) => {
  const { from, to } = req.query;
  try {
    const where = [];
    const params = [];
    if (from) { where.push("adisp.date >= ?"); params.push(from); }
    if (to) { where.push("adisp.date <= ?"); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await dbAllP(
      `
      SELECT
        adisp.id, adisp.date, adisp.mode, adisp.sale_value,
        adisp.book_value_at_disposal, adisp.profit_loss, adisp.journal_voucher_no,
        fa.asset_code, fa.asset_name, ac.category_name
      FROM asset_disposal adisp
      JOIN fixed_asset fa ON fa.id = adisp.asset_id
      JOIN asset_category_master ac ON ac.id = fa.category_id
      ${whereSql}
      ORDER BY adisp.date DESC, adisp.id DESC
      `,
      params
    );
    const total = round2(rows.reduce((s, r) => s + r.profit_loss, 0));
    res.json({ rows, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Physical Verification checklist: asset code, location, last verified
   date, for every ACTIVE asset (a DISPOSED/WRITTEN_OFF asset isn't on the
   floor to verify anymore). last_verified_date is NULL until someone
   calls /asset/:id/verify below — shown as-is (never hidden or defaulted)
   so "never verified" stays visible to whoever is running the audit.
   ?location_id narrows to one site for a location-by-location walk. */
app.get("/fam/report/physical-verification", async (req, res) => {
  const { location_id } = req.query;
  try {
    const where = ["fa.status = 'ACTIVE'"];
    const params = [];
    if (location_id) { where.push("fa.location_id = ?"); params.push(location_id); }

    const rows = await dbAllP(
      `
      SELECT fa.id, fa.asset_code, fa.asset_name, fa.tag_code, fa.last_verified_date,
             ac.category_name, l.location_name
      FROM fixed_asset fa
      JOIN asset_category_master ac ON ac.id = fa.category_id
      LEFT JOIN locations l ON l.id = fa.location_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.location_name, fa.asset_name
      `,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Mark an asset physically verified as of a date (defaults to today) —
   the write side the Physical Verification checklist report reads back.
   No journal impact, same "pure record-keeping" shape as asset_transfer. */
app.post("/asset/:id/verify", async (req, res) => {
  try {
    const asset = await dbGetP(`SELECT id, status FROM fixed_asset WHERE id = ?`, [req.params.id]);
    if (!asset) return res.status(404).json({ error: "Asset not found" });

    const date = req.body && req.body.date ? req.body.date : new Date().toISOString().slice(0, 10);
    await dbRunP(`UPDATE fixed_asset SET last_verified_date = ? WHERE id = ?`, [date, asset.id]);

    res.json({ status: "success", last_verified_date: date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* -------------------- FIXED ASSET RECONCILIATION (FAM Step 10) --------------------
   "Reconcile the module's Fixed Assets ledger total against your existing
   Balance Sheet before trusting it" — this is that check, done in software
   instead of by hand. For each category ledger (and for Accumulated
   Depreciation A/c), it compares what the Fixed Asset Register SAYS is
   there against what the general ledger ACTUALLY holds, using the exact
   same debit-credit convention Balance Sheet.html uses for ASSET-nature
   ledgers (balance = SUM(debit) - SUM(credit) from ledger_entries — see
   Balance Sheet.html's natureMap logic, which this mirrors rather than
   reimplements differently).

   Why these two numbers CAN legitimately differ even when nothing is
   broken:
     - An asset capitalized with capitalization_mode OPENING posts no
       journal at all (see /asset/create), so its cost sits in the
       register but never reaches the ledger — by design, for assets a
       business already owned before adopting this module. A variance
       here is expected, not a bug, until those opening balances are
       journaled in separately.
     - A DRAFT depreciation run's schedule rows are deliberately excluded
       (same filter the reports above use) — only PROCESSED runs and
       posted disposal stubs count, since only those touched the ledger.
   A genuine MISMATCH after accounting for the above usually means a
   journal failed to post, or a ledger name was typed differently
   somewhere outside this module (e.g. a manual journal against "Computer
   A/c" instead of "Computers A/c").

   register_value / ledger_value are both signed the way they'd appear on
   the Balance Sheet's Assets side: positive for the category (gross
   cost) ledgers, negative for the contra-asset Accumulated Depreciation
   row — so net_block (gross - accumulated depreciation) is just their
   sum, register and ledger side each. */
app.get("/fam/report/reconciliation", async (req, res) => {
  try {
    const categories = await dbAllP(
      `SELECT id, category_name, ledger FROM asset_category_master WHERE is_active = 1 ORDER BY category_name`
    );

    const rows = [];
    for (const cat of categories) {
      const reg = await dbGetP(
        `SELECT COALESCE(SUM(acquisition_cost),0) AS cost, COUNT(*) AS asset_count
         FROM fixed_asset WHERE category_id = ? AND status = 'ACTIVE'`,
        [cat.id]
      );
      const ledgerBal = await dbGetP(
        `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
         FROM ledger_entries WHERE ledger = ?`,
        [cat.ledger]
      );
      const registerValue = round2(reg.cost);
      const ledgerValue = round2(ledgerBal.balance);
      const variance = round2(registerValue - ledgerValue);
      rows.push({
        category_name: cat.category_name,
        ledger: cat.ledger,
        asset_count: reg.asset_count,
        register_value: registerValue,
        ledger_value: ledgerValue,
        variance,
        status: Math.abs(variance) < 0.01 ? "MATCH" : "MISMATCH"
      });
    }

    // Accumulated Depreciation: register total is the sum of every FINAL
    // schedule row (PROCESSED runs + disposal stubs) still attributable to
    // an ACTIVE asset — a DISPOSED/WRITTEN_OFF asset's accumulated
    // depreciation was already reversed out of the ledger by its disposal
    // journal (see /asset/:id/dispose), so it must drop out of this
    // comparison too, exactly like the asset-register report's WDV logic.
    const regAccumDep = await dbGetP(
      `
      SELECT COALESCE(SUM(ads.depreciation_amount),0) AS total
      FROM asset_depreciation_schedule ads
      LEFT JOIN depreciation_run dr ON dr.id = ads.run_id
      JOIN fixed_asset fa ON fa.id = ads.asset_id
      WHERE fa.status = 'ACTIVE' AND (ads.run_id IS NULL OR dr.status = 'PROCESSED')
      `
    );
    const accumDepLedgerBal = await dbGetP(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance
       FROM ledger_entries WHERE ledger = 'Accumulated Depreciation A/c'`
    );
    const accumDepRegisterValue = round2(-regAccumDep.total); // contra-asset: negative on the Assets side
    const accumDepLedgerValue = round2(accumDepLedgerBal.balance);
    const accumDepVariance = round2(accumDepRegisterValue - accumDepLedgerValue);
    rows.push({
      category_name: "Accumulated Depreciation (contra)",
      ledger: "Accumulated Depreciation A/c",
      asset_count: null,
      register_value: accumDepRegisterValue,
      ledger_value: accumDepLedgerValue,
      variance: accumDepVariance,
      status: Math.abs(accumDepVariance) < 0.01 ? "MATCH" : "MISMATCH"
    });

    const grossRows = rows.filter(r => r.ledger !== "Accumulated Depreciation A/c");
    const totalGrossRegister = round2(grossRows.reduce((s, r) => s + r.register_value, 0));
    const totalGrossLedger = round2(grossRows.reduce((s, r) => s + r.ledger_value, 0));
    const netBlockRegister = round2(totalGrossRegister + accumDepRegisterValue);
    const netBlockLedger = round2(totalGrossLedger + accumDepLedgerValue);

    res.json({
      rows,
      summary: {
        total_gross_cost_register: totalGrossRegister,
        total_gross_cost_ledger: totalGrossLedger,
        accumulated_depreciation_register: round2(-accumDepRegisterValue),
        accumulated_depreciation_ledger: round2(-accumDepLedgerValue),
        net_block_register: netBlockRegister,
        net_block_ledger: netBlockLedger,
        net_block_variance: round2(netBlockRegister - netBlockLedger),
        overall_status: rows.every(r => r.status === "MATCH") ? "RECONCILED" : "REVIEW NEEDED"
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* -------------------- HSN/UQC REFERENCE (for frontend dropdowns) -------------------- */

app.get("/reference/uqc", (req, res) => {
  res.json({ uqc_codes: UQC_CODES });
});

app.get("/items/missing-hsn", (req, res) => {
  db.all(
    `
    SELECT id, item_code, item_name, hsn, unit, gst_rate
    FROM item_master
    WHERE hsn IS NULL OR TRIM(hsn) = ''
    ORDER BY item_name
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});


/* -------------------- ITEM SEARCH API  -------------------- */

app.get("/items/search", (req, res) => {
  const q = `%${req.query.q || ""}%`;

  db.all(
    `
    SELECT
      id,
      item_code,
      item_name,
      hsn,
      unit,
      gst_rate,
      selling_price,
      supply_type,
      item_type,
      secondary_unit,
      conversion_factor
    FROM item_master
    WHERE item_name LIKE ? OR item_code LIKE ?
    ORDER BY item_name
    LIMIT 20
    `,
    [q, q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});


/* -------------------- STOCK AVAILABILITY API -------------------- */

/* Available qty for an item — total across all locations by default
   (unchanged behaviour, still what Sales Book's stock check relies on),
   or scoped to one location via ?location_id= (Phase 2, Step 8). Kept
   backward-compatible on purpose: every existing caller that omits
   location_id keeps getting the flat total it always got. */
app.get("/stock/:itemId", (req, res) => {
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;

  db.get(
    `
    SELECT
      IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
    FROM stock_ledger
    WHERE item_id = ? ${locationId ? "AND location_id = ?" : ""}
    `,
    locationId ? [req.params.itemId, locationId] : [req.params.itemId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ available: row.available });
    }
  );
});

/* Batch-wise breakdown of an item's available stock at one location (Batch
   Tracking, Step 6) — what the Work Order Issue panel's batch picker reads
   to show "X available in batch B1, expiring DD-MM-YYYY" per component
   instead of a single free-entry qty box. GROUP BY batch_no naturally
   buckets every un-batched row (batch_no IS NULL, e.g. stock predating
   this feature, or a legacy issue posted before Step 6's picker existed)
   into one "no batch" group, so pre-existing stock stays selectable rather
   than becoming invisible the moment this rolled out. Zero/negative
   balances (a batch fully consumed) are filtered out — nothing left to
   pick from. Sorted FEFO: earliest expiry_date first, batches with no
   expiry_date after all dated ones, and the un-batched group last of all
   since it's the least specific choice. */
app.get("/stock/:itemId/batches", (req, res) => {
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  if (!locationId) {
    return res.status(400).json({ error: "location_id is required" });
  }

  db.all(
    `
    SELECT
      batch_no,
      MAX(expiry_date) AS expiry_date,
      IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
    FROM stock_ledger
    WHERE item_id = ? AND location_id = ?
    GROUP BY batch_no
    HAVING available > 0.000001
    ORDER BY (batch_no IS NULL) ASC, (expiry_date IS NULL) ASC, expiry_date ASC
    `,
    [req.params.itemId, locationId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});


/* -------------------- PURCHASE SAVE API -------------------- */

app.post("/purchase/save", async (req, res) => {
  const { date, supplier, invoiceNo, items, taxType, po_id, supplierId, location_id } = req.body;

  if (!date || !supplier || !invoiceNo || !items?.length) {
    return res.status(400).json({ error: "Invalid purchase data" });
  }

  let companyGstin, companyState, supplierRow, supplierState;
  try {
    companyGstin = await getSetting("company_gstin", "");
    companyState = getGstStateFromGstin(companyGstin);

    supplierRow = supplierId
      ? await new Promise((resolve, reject) => {
          db.get(`SELECT * FROM suppliers WHERE id = ?`, [supplierId], (err, row) =>
            err ? reject(err) : resolve(row)
          );
        })
      : null;
    supplierState = supplierRow ? getGstStateFromGstin(supplierRow.gstin) : null;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Same rule as /sales/save: whenever both our GSTIN and the supplier's
  // GSTIN are on file and valid, derive CGST+SGST vs IGST definitively by
  // comparing state codes, instead of trusting a manually picked "Purchase
  // Type" dropdown. That dropdown is only a fallback for unregistered
  // suppliers (no GSTIN on file) or before a company GSTIN is set up.
  const isInterState = (companyState && supplierState)
    ? companyState.code !== supplierState.code
    : taxType === "INTER";

  // Every line must resolve to valid itc_category / itc_eligible values
  // before anything is written — these decide which GSTR-3B Table 4 row (or
  // whether Table 4(D) at all) a line's ITC lands in, so a bad value should
  // fail the save loudly rather than get silently defaulted and misreport
  // the return later. rcm_applicable has no invalid values (see
  // normalizeRcmApplicable), so it's just coerced, not validated. Defaults
  // to OTHER / ELIGIBLE / 0 when a line omits these fields entirely, so
  // invoices from a frontend that hasn't been updated yet (or the PO-import
  // path, which doesn't carry ITC classification — see Purchase Book.html)
  // keep behaving exactly as before this step.
  for (const item of items) {
    const itcCategory = normalizeItcCategory(item.itc_category);
    if (!itcCategory) {
      return res.status(400).json({
        error: `Invalid itc_category "${item.itc_category}" on line "${item.item_name || item.item_id}". Must be one of ${VALID_ITC_CATEGORIES.join(", ")}.`
      });
    }
    const itcEligible = normalizeItcEligible(item.itc_eligible);
    if (!itcEligible) {
      return res.status(400).json({
        error: `Invalid itc_eligible "${item.itc_eligible}" on line "${item.item_name || item.item_id}". Must be one of ${VALID_ITC_ELIGIBLE.join(", ")}.`
      });
    }
    item.itc_category = itcCategory;
    item.itc_eligible = itcEligible;
    item.rcm_applicable = normalizeRcmApplicable(item.rcm_applicable);
  }

  try {
    // Guard: an invoice raised against a PO can never invoice more than has
    // actually been received via Goods Receipt. Without this check, the
    // vendor could be booked as a creditor for goods that never arrived —
    // the frontend prevents this in normal use, but the API must enforce it
    // too, since accounting integrity can't rely on the client alone.
    if (po_id) {
      for (const item of items) {
        if (!item.po_item_id) continue;
        const poItem = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?`,
            [item.po_item_id, po_id],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });
        if (!poItem) {
          return res.status(400).json({ error: "Purchase order line item not found" });
        }
        const availableToInvoice = poItem.received_qty - poItem.invoiced_qty;
        if (Number(item.qty) > availableToInvoice + 1e-6) {
          return res.status(400).json({
            error: `Cannot invoice ${item.qty} of "${poItem.item_name}" — only ${availableToInvoice} received and not yet invoiced. Record a Goods Receipt first if more has physically arrived.`
          });
        }
      }
    }

    // Direct purchase invoices (no PO/GRN) bring stock into RM Store by
    // default — matches the Step 3 backfill's PURCHASE → RM Store rule.
    // Resolved once up front since it's the same for every line unless a
    // line overrides it with its own item.location_id.
    const defaultPurchaseLocationId = po_id ? null : await resolveLocationId(location_id, "RM Store");

    db.run("BEGIN TRANSACTION");

    let totalAmount = 0;
    let totalGst = 0;

    for (const item of items) {
      const lineAmount = item.qty * item.rate;
      const gstRate = Number(item.gst_rate) || 0;
      const lineGst = lineAmount * (gstRate / 100);

      totalAmount += lineAmount;
      totalGst += lineGst;

      let itemId = item.item_id;

      /* 1️⃣ CREATE ITEM IF NOT EXISTS */
      if (!itemId) {
        itemId = await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO item_master
            (item_name, unit, gst_rate, selling_price)
            VALUES (?, 'Nos', ?, ?)
            `,
            [item.item_name, gstRate, item.rate],
            function (err) {
              if (err) return reject(err);
              resolve(this.lastID);
            }
          );
        });
      }
      item.item_id = itemId; // persist for later use (invoice line insert below)

      /* 2️⃣ STOCK IN — skipped when this invoice is being raised against a
         Purchase Order, because the goods were already brought into stock
         at the Goods Receipt (GRN) stage. Recording it again here would
         double the stock. */
      if (!po_id) {
        const lineLocationId = item.location_id
          ? await resolveLocationId(item.location_id, "RM Store")
          : defaultPurchaseLocationId;
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id)
            VALUES (?, ?, 'PURCHASE', ?, ?, ?, ?)
            `,
            [itemId, date, invoiceNo, item.qty, item.rate, lineLocationId],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

  await new Promise((resolve, reject) => {
    db.run(
      `
      INSERT OR IGNORE INTO ledger_master
      (ledger, ledger_group)
      VALUES (?, 'Sundry Creditors')
      `,
      [supplier],
      err => err ? reject(err) : resolve()
    );
  });

    /* 3️⃣ ACCOUNTING ENTRY (Purchases + GST input credit + supplier payable) */
    const grandTotal = totalAmount + totalGst;

    const entries = [
      { particulars: "Purchases A/c", debit: totalAmount, credit: 0 }
    ];

    if (totalGst > 0) {
      if (isInterState) {
        entries.push({ particulars: "Input IGST", debit: totalGst, credit: 0 });
      } else {
        entries.push({ particulars: "Input CGST", debit: totalGst / 2, credit: 0 });
        entries.push({ particulars: "Input SGST", debit: totalGst / 2, credit: 0 });
      }
    }

    entries.push({ particulars: supplier, debit: 0, credit: grandTotal });

    await saveJournalInternal({
      date,
      narration: `Purchase Invoice ${invoiceNo}`,
      entries
    });

    /* 3️⃣b INVOICE HEADER + LINES — purchases previously had no first-class
       invoice record at all (only the journal voucher + narration text).
       This is what Payables tracking needs to compute an outstanding
       balance and let a payment be allocated against this specific bill. */
    const pCgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const pSgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const pIgstAmt = isInterState ? totalGst : 0;

    const purchaseInvoiceId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO purchase_invoice
        (invoice_no, date, supplier, supplier_id, po_id, taxable_value, cgst, sgst, igst, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [invoiceNo, date, supplier, supplierId || null, po_id || null, totalAmount, pCgstAmt, pSgstAmt, pIgstAmt, grandTotal],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      const lineAmount = item.qty * item.rate;
      const lineGst = lineAmount * ((Number(item.gst_rate) || 0) / 100);
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO purchase_invoice_items
          (invoice_id, item_id, item_name, qty, rate, taxable, gst_rate, gst_amount, total, itc_category, itc_eligible, rcm_applicable)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [purchaseInvoiceId, item.item_id || null, item.item_name, item.qty, item.rate,
           lineAmount, Number(item.gst_rate) || 0, lineGst, lineAmount + lineGst,
           item.itc_category, item.itc_eligible, item.rcm_applicable],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    /* 4️⃣ LINK BACK TO THE PURCHASE ORDER, IF THIS INVOICE IS AGAINST ONE */
    if (po_id) {
      for (const item of items) {
        if (!item.po_item_id) continue;
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE purchase_order_items SET invoiced_qty = invoiced_qty + ? WHERE id = ?`,
            [item.qty, item.po_item_id],
            err => (err ? reject(err) : resolve())
          );
        });
      }
      await recomputePOStatus(po_id);
    }

    db.run("COMMIT");
    res.json({ status: "success" });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- PURCHASE ORDER APIs (PO CYCLE) -------------------- */

/* Next PO number, for prefilling the New Purchase Order screen */
app.get("/po/next-number", (req, res) => {
  getNextPONo((err, poNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ poNo });
  });
});

/* Next purchase invoice number, for prefilling the Purchase Book screen */
app.get("/purchase/next-invoice", (req, res) => {
  getNextPurchaseInvoiceNo((err, invoiceNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ invoiceNo });
  });
});

/* Create a Purchase Order — no accounting/stock impact yet, just a record
   of what was ordered. Stock only moves at Goods Receipt; the ledger only
   moves at the Purchase Invoice stage. */
app.post("/po/save", async (req, res) => {
  const { date, supplier, taxType, narration, items, supplierId } = req.body;

  if (!date || !supplier || !items?.length) {
    return res.status(400).json({ error: "Invalid purchase order data" });
  }

  let companyGstin, companyState, supplierRow, supplierState;
  try {
    companyGstin = await getSetting("company_gstin", "");
    companyState = getGstStateFromGstin(companyGstin);

    supplierRow = supplierId
      ? await new Promise((resolve, reject) => {
          db.get(`SELECT * FROM suppliers WHERE id = ?`, [supplierId], (err, row) =>
            err ? reject(err) : resolve(row)
          );
        })
      : null;
    supplierState = supplierRow ? getGstStateFromGstin(supplierRow.gstin) : null;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Same GSTIN-derived rule as /purchase/save — kept in sync here so that
  // a PO's tax_type (which pre-fills the eventual Purchase Book entry)
  // already reflects reality instead of whatever was picked on this form.
  const resolvedTaxType = (companyState && supplierState)
    ? (companyState.code !== supplierState.code ? "INTER" : "INTRA")
    : (taxType || "INTRA");

  try {
    const poNo = await new Promise((resolve, reject) => {
      getNextPONo((err, no) => (err ? reject(err) : resolve(no)));
    });

    db.run("BEGIN TRANSACTION");

    // Ensure the supplier has a ledger (same convention as /purchase/save)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT OR IGNORE INTO ledger_master (ledger, ledger_group) VALUES (?, 'Sundry Creditors')`,
        [supplier],
        err => (err ? reject(err) : resolve())
      );
    });

    const poId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO purchase_order (po_no, date, supplier, supplier_id, tax_type, status, narration)
        VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
        `,
        [poNo, date, supplier, supplierId || null, resolvedTaxType, narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      if (!item.item_name || !item.qty || item.rate == null) {
        throw new Error("Each item needs an item name, qty and rate");
      }

      let itemId = item.item_id || null;
      if (!itemId) {
        itemId = await getOrCreateItem(item.item_name, item.gst_rate, item.rate);
      }

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO purchase_order_items
          (po_id, item_id, item_name, qty, rate, gst_rate)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [poId, itemId, item.item_name, item.qty, item.rate, Number(item.gst_rate) || 0],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", po_id: poId, po_no: poNo });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* List all purchase orders with rollup totals + status, for the register */
app.get("/po/list", (req, res) => {
  db.all(
    `
    SELECT
      po.id, po.po_no, po.date, po.supplier, po.tax_type, po.status,
      IFNULL(SUM(i.qty * i.rate), 0) AS taxable_value,
      IFNULL(SUM(i.qty * i.rate * i.gst_rate / 100), 0) AS gst_value,
      IFNULL(SUM(i.qty), 0) AS total_qty,
      IFNULL(SUM(i.received_qty), 0) AS total_received,
      IFNULL(SUM(i.invoiced_qty), 0) AS total_invoiced
    FROM purchase_order po
    LEFT JOIN purchase_order_items i ON i.po_id = po.id
    GROUP BY po.id
    ORDER BY po.id DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        ...r,
        grand_total: r.taxable_value + r.gst_value
      }));
      res.json(data);
    }
  );
});

/* Single PO with its line items — used by the Goods Receipt and
   Purchase Book (invoice-against-PO) screens */
app.get("/po/:id", (req, res) => {
  db.get(`SELECT * FROM purchase_order WHERE id = ?`, [req.params.id], (err, po) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    db.all(
      `SELECT * FROM purchase_order_items WHERE po_id = ? ORDER BY id`,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...po, items });
      }
    );
  });
});

/* Cancel a PO — only allowed before anything has been received or invoiced */
app.post("/po/:id/cancel", (req, res) => {
  db.get(
    `SELECT IFNULL(SUM(received_qty),0) AS r, IFNULL(SUM(invoiced_qty),0) AS inv
     FROM purchase_order_items WHERE po_id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row.r > 0 || row.inv > 0) {
        return res.status(400).json({
          error: "Cannot cancel a purchase order that already has receipts or invoices against it"
        });
      }
      db.run(
        `UPDATE purchase_order SET status = 'CANCELLED' WHERE id = ?`,
        [req.params.id],
        err => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ status: "cancelled" });
        }
      );
    }
  );
});

/* Goods Receipt Note (GRN) — record physical receipt of goods against a
   PO. This is the step that actually moves stock; qty received here can
   be partial and repeated across multiple deliveries. */
app.post("/po/receive", async (req, res) => {
  const { po_id, date, items, location_id } = req.body;

  if (!po_id || !date || !items?.length) {
    return res.status(400).json({ error: "Invalid goods receipt data" });
  }

  try {
    // The "receive into" location for this GRN — defaults to RM Store
    // (matches the Step 3 backfill's GRN → RM Store rule) until the GRN
    // screen's location dropdown (Step 9) sends one explicitly. Resolved
    // before BEGIN TRANSACTION so a bad lookup can't leave a half-open
    // transaction behind.
    const grnLocationId = await resolveLocationId(location_id, "RM Store");

    db.run("BEGIN TRANSACTION");

    const po = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM purchase_order WHERE id = ?`, [po_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!po) throw new Error("Purchase order not found");
    if (po.status === "CANCELLED") throw new Error("Cannot receive goods against a cancelled purchase order");

    for (const line of items) {
      // Batch Tracking Step 3: a single PO line can now be received in more
      // than one batch in the same GRN (or across separate deliveries), so
      // a line is no longer always "one qty, one stock_ledger row" — it's
      // one or more batch sub-lines, each becoming its own qty_in row.
      // New callers (Step 4's Goods Receipt UI) send
      // { po_item_id, batches: [{batch_no, expiry_date, qty}, ...] }.
      // Older callers that still send the flat { po_item_id, qty } shape
      // keep working unchanged — that's normalized here into a single
      // sub-line with batch_no/expiry_date left NULL, same "nothing
      // downstream can assume a batch is always present" rule from Step 1.
      const subLines = Array.isArray(line.batches) && line.batches.length
        ? line.batches
        : [{ batch_no: line.batch_no ?? null, expiry_date: line.expiry_date ?? null, qty: line.qty }];

      // Total qty across this line's sub-lines is what's checked against
      // pending and what bumps received_qty — the PO line itself doesn't
      // care how its qty was split across batches, only the ledger rows do.
      const lineQty = subLines.reduce((sum, sub) => sum + (Number(sub.qty) || 0), 0);
      if (lineQty <= 0) continue;

      const poItem = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?`,
          [line.po_item_id, po_id],
          (err, row) => (err ? reject(err) : resolve(row))
        );
      });
      if (!poItem) throw new Error("Purchase order line item not found");

      const pending = poItem.qty - poItem.received_qty;
      if (lineQty > pending + 1e-6) {
        throw new Error(
          `Cannot receive ${lineQty} of "${poItem.item_name}" — only ${pending} still pending`
        );
      }

      for (const sub of subLines) {
        const subQty = Number(sub.qty) || 0;
        if (subQty <= 0) continue;

        const batchNo = sub.batch_no || null;
        const expiryDate = sub.expiry_date || null;

        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id, batch_no, expiry_date)
            VALUES (?, ?, 'GRN', ?, ?, ?, ?, ?, ?)
            `,
            [poItem.item_id, date, po.po_no, subQty, poItem.rate, grnLocationId, batchNo, expiryDate],
            err => (err ? reject(err) : resolve())
          );
        });
      }

      // Rolls up into the same received_qty bump regardless of how many
      // batch sub-lines fed into it — see comment above.
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?`,
          [lineQty, poItem.id],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    const status = await recomputePOStatus(po_id);

    db.run("COMMIT");
    res.json({ status: "success", po_status: status });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- SALES ORDER (SO CYCLE) & DELIVERY CHALLAN -------------------- */

/* Next SO number, for prefilling the New Sales Order screen */
app.get("/so/next-number", (req, res) => {
  getNextSONo((err, soNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ soNo });
  });
});

/* Save a new Sales Order. Mirrors /po/save — no stock or accounting entry
   here; this just books the commitment. Stock moves at the Delivery
   Challan stage. */
app.post("/so/save", async (req, res) => {
  const { date, customer, clientId, taxType, narration, items } = req.body;

  if (!date || !customer || !items?.length) {
    return res.status(400).json({ error: "Invalid sales order data" });
  }

  try {
    const soNo = await new Promise((resolve, reject) => {
      getNextSONo((err, no) => (err ? reject(err) : resolve(no)));
    });

    db.run("BEGIN TRANSACTION");

    // Ensure the customer has a ledger (same convention as /sales/save)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT OR IGNORE INTO ledger_master (ledger, ledger_group) VALUES (?, 'Sundry Debtors')`,
        [customer],
        err => (err ? reject(err) : resolve())
      );
    });

    const soId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO sales_order (so_no, date, customer, client_id, tax_type, status, narration)
        VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
        `,
        [soNo, date, customer, clientId || null, taxType || "INTRA", narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      if (!item.item_name || !item.qty || item.rate == null) {
        throw new Error("Each item needs an item name, qty and rate");
      }

      let itemId = item.item_id || null;
      if (!itemId) {
        itemId = await getOrCreateItem(item.item_name, item.gst_rate, item.rate);
      }

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO sales_order_items
          (so_id, item_id, item_name, qty, rate, gst_rate)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [soId, itemId, item.item_name, item.qty, item.rate, Number(item.gst_rate) || 0],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", so_id: soId, so_no: soNo });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* List all sales orders with rollup totals + status, for the register */
app.get("/so/list", (req, res) => {
  db.all(
    `
    SELECT
      so.id, so.so_no, so.date, so.customer, so.tax_type, so.status,
      IFNULL(SUM(i.qty * i.rate), 0) AS taxable_value,
      IFNULL(SUM(i.qty * i.rate * i.gst_rate / 100), 0) AS gst_value,
      IFNULL(SUM(i.qty), 0) AS total_qty,
      IFNULL(SUM(i.delivered_qty), 0) AS total_delivered,
      IFNULL(SUM(i.invoiced_qty), 0) AS total_invoiced
    FROM sales_order so
    LEFT JOIN sales_order_items i ON i.so_id = so.id
    GROUP BY so.id
    ORDER BY so.id DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        ...r,
        grand_total: r.taxable_value + r.gst_value
      }));
      res.json(data);
    }
  );
});

/* Single SO with its line items — used by the Delivery Challan screen */
app.get("/so/:id", (req, res) => {
  db.get(`SELECT * FROM sales_order WHERE id = ?`, [req.params.id], (err, so) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!so) return res.status(404).json({ error: "Sales order not found" });

    db.all(
      `SELECT * FROM sales_order_items WHERE so_id = ? ORDER BY id`,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...so, items });
      }
    );
  });
});

/* Cancel a SO — only allowed before anything has been delivered or invoiced */
app.post("/so/:id/cancel", (req, res) => {
  db.get(
    `SELECT IFNULL(SUM(delivered_qty),0) AS d, IFNULL(SUM(invoiced_qty),0) AS inv
     FROM sales_order_items WHERE so_id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row.d > 0 || row.inv > 0) {
        return res.status(400).json({
          error: "Cannot cancel a sales order that already has deliveries or invoices against it"
        });
      }
      db.run(
        `UPDATE sales_order SET status = 'CANCELLED' WHERE id = ?`,
        [req.params.id],
        err => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ status: "cancelled" });
        }
      );
    }
  );
});

/* Next DC number, for prefilling the New Delivery Challan screen */
app.get("/dc/next-number", (req, res) => {
  getNextDCNo((err, dcNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ dcNo });
  });
});

/* Delivery Challan — record physical dispatch of goods against a Sales
   Order. This is the step that actually moves stock (qty_out); qty
   dispatched here can be partial and repeated across multiple challans. */
app.post("/dc/save", async (req, res) => {
  const { so_id, date, customer, narration, items, location_id } = req.body;

  if (!so_id || !date || !customer || !items?.length) {
    return res.status(400).json({ error: "Invalid delivery challan data" });
  }

  try {
    // The "issue from" location for this DC — defaults to FG Store
    // (matches the Step 3 backfill's DC → FG Store rule) until the DC
    // screen's location dropdown (Step 9) sends one explicitly.
    const dcLocationId = await resolveLocationId(location_id, "FG Store");

    db.run("BEGIN TRANSACTION");

    const so = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM sales_order WHERE id = ?`, [so_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!so) throw new Error("Sales order not found");
    if (so.status === "CANCELLED") throw new Error("Cannot deliver against a cancelled sales order");

    // Validate every line (pending qty AND stock availability) before
    // writing anything, and hang on to the resolved SO line so we don't
    // have to re-fetch it below.
    const soItemsById = {};
    for (const line of items) {
      const qty = Number(line.qty) || 0;
      if (qty <= 0) continue;

      const soItem = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM sales_order_items WHERE id = ? AND so_id = ?`,
          [line.so_item_id, so_id],
          (err, row) => (err ? reject(err) : resolve(row))
        );
      });
      if (!soItem) throw new Error("Sales order line item not found");

      const pending = soItem.qty - soItem.delivered_qty;
      if (qty > pending + 1e-6) {
        throw new Error(
          `Cannot deliver ${qty} of "${soItem.item_name}" — only ${pending} still pending`
        );
      }

      const available = await getAvailableStock(soItem.item_id);
      if (qty > available + 1e-6) {
        throw new Error(
          `Insufficient stock for "${soItem.item_name}". Available: ${available}`
        );
      }

      soItemsById[soItem.id] = soItem;
    }

    if (!Object.keys(soItemsById).length) {
      throw new Error("Enter at least one quantity to deliver");
    }

    const dcNo = await new Promise((resolve, reject) => {
      getNextDCNo((err, no) => (err ? reject(err) : resolve(no)));
    });

    const dcId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO delivery_challan (dc_no, date, customer, so_id, narration)
        VALUES (?, ?, ?, ?, ?)
        `,
        [dcNo, date, customer, so_id, narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const line of items) {
      const qty = Number(line.qty) || 0;
      if (qty <= 0) continue;
      const soItem = soItemsById[line.so_item_id];

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO delivery_challan_items
          (dc_id, so_item_id, item_id, item_name, qty, rate, gst_rate)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [dcId, soItem.id, soItem.item_id, soItem.item_name, qty, soItem.rate, soItem.gst_rate],
          err => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id)
          VALUES (?, ?, 'DC', ?, ?, ?, ?)
          `,
          [soItem.item_id, date, dcNo, qty, soItem.rate, dcLocationId],
          err => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE sales_order_items SET delivered_qty = delivered_qty + ? WHERE id = ?`,
          [qty, soItem.id],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    const status = await recomputeSOStatus(so_id);

    db.run("COMMIT");
    res.json({ status: "success", dc_id: dcId, dc_no: dcNo, so_status: status });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* List all delivery challans, for the register */
app.get("/dc/list", (req, res) => {
  db.all(
    `
    SELECT
      dc.id, dc.dc_no, dc.date, dc.customer, dc.so_id, so.so_no,
      IFNULL(SUM(i.qty), 0) AS total_qty,
      COUNT(i.id) AS item_count
    FROM delivery_challan dc
    LEFT JOIN delivery_challan_items i ON i.dc_id = dc.id
    LEFT JOIN sales_order so ON so.id = dc.so_id
    GROUP BY dc.id
    ORDER BY dc.id DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* Single DC with its line items */
app.get("/dc/:id", (req, res) => {
  db.get(`SELECT * FROM delivery_challan WHERE id = ?`, [req.params.id], (err, dc) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!dc) return res.status(404).json({ error: "Delivery challan not found" });

    db.all(
      `SELECT * FROM delivery_challan_items WHERE dc_id = ? ORDER BY id`,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...dc, items });
      }
    );
  });
});

/* -------------------- STOCK TRANSFER (Phase 2, Step 7) -------------------- */

/* Next transfer number, for prefilling the New Stock Transfer screen —
   same "preview only" convention as /po/next-number, /so/next-number,
   /debit-note/next-number etc. The backend assigns the real number again
   at save time regardless, so a stale preview here is never a problem. */
app.get("/stock-transfer/next-number", (req, res) => {
  getNextTransferNo((err, transferNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ transferNo });
  });
});

/* Available qty of one item at one location — lets the Stock Transfer
   screen show "X available at RM Store" before the user submits, using
   the from-location they've picked. See getAvailableStockAtLocation for
   why this stays narrowly scoped to a single item+location lookup. */
app.get("/stock-transfer/available", (req, res) => {
  const { item_id, location_id } = req.query;
  if (!item_id || !location_id) {
    return res.status(400).json({ error: "item_id and location_id are required" });
  }
  getAvailableStockAtLocation(item_id, location_id)
    .then(available => res.json({ available }))
    .catch(err => res.status(500).json({ error: err.message }));
});

/* Record a Stock Transfer — moves qty of one item from one location to
   another. Writes two stock_ledger rows (qty_out at from-location, qty_in
   at to-location) sharing the same voucher_no, inside one transaction —
   same shape as the GRN/DC handlers above, just two ledger rows instead
   of one per line. */
app.post("/stock-transfer", async (req, res) => {
  const { date, item_id, qty, from_location_id, to_location_id, rate, narration } = req.body;

  if (!date || !item_id || !qty || !from_location_id || !to_location_id) {
    return res.status(400).json({ error: "Invalid stock transfer data" });
  }

  const transferQty = Number(qty);
  if (!(transferQty > 0)) {
    return res.status(400).json({ error: "Transfer quantity must be greater than zero" });
  }

  if (Number(from_location_id) === Number(to_location_id)) {
    return res.status(400).json({ error: "Source and destination locations must be different" });
  }

  try {
    db.run("BEGIN TRANSACTION");

    const item = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM item_master WHERE id = ?`, [item_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!item) throw new Error("Item not found");

    const fromLoc = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM locations WHERE id = ?`, [from_location_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!fromLoc) throw new Error("Source location not found");

    const toLoc = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM locations WHERE id = ?`, [to_location_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!toLoc) throw new Error("Destination location not found");

    const available = await getAvailableStockAtLocation(item_id, from_location_id);
    if (transferQty > available + 1e-6) {
      throw new Error(
        `Insufficient stock for "${item.item_name}" at ${fromLoc.location_name}. Available: ${available}`
      );
    }

    const transferNo = await new Promise((resolve, reject) => {
      getNextTransferNo((err, no) => (err ? reject(err) : resolve(no)));
    });

    const transferId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO stock_transfer
        (transfer_no, date, item_id, qty, from_location_id, to_location_id, rate, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [transferNo, date, item_id, transferQty, from_location_id, to_location_id, rate || null, narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO stock_ledger
        (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id)
        VALUES (?, ?, 'TRANSFER', ?, ?, ?, ?)
        `,
        [item_id, date, transferNo, transferQty, rate || null, from_location_id],
        err => (err ? reject(err) : resolve())
      );
    });

    await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO stock_ledger
        (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id)
        VALUES (?, ?, 'TRANSFER', ?, ?, ?, ?)
        `,
        [item_id, date, transferNo, transferQty, rate || null, to_location_id],
        err => (err ? reject(err) : resolve())
      );
    });

    db.run("COMMIT");
    res.json({ status: "success", transfer_id: transferId, transfer_no: transferNo });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* List all stock transfers, for the Stock Transfer Register (Phase 2,
   Step 10). Joins item_master and locations (twice, aliased) so the
   register can show item/from/to names directly rather than making the
   frontend resolve ids — same "denormalize for the list view" approach
   as /dc/list joining in so_no. */
app.get("/stock-transfer/list", (req, res) => {
  db.all(
    `
    SELECT
      st.id, st.transfer_no, st.date, st.qty, st.rate, st.narration,
      st.item_id, im.item_name,
      st.from_location_id, fl.location_name AS from_location_name,
      st.to_location_id, tl.location_name AS to_location_name
    FROM stock_transfer st
    LEFT JOIN item_master im ON im.id = st.item_id
    LEFT JOIN locations fl ON fl.id = st.from_location_id
    LEFT JOIN locations tl ON tl.id = st.to_location_id
    ORDER BY st.id DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- DEBIT NOTES (PURCHASE RETURNS / ADJUSTMENTS) -------------------- */

/* Next debit note number, for prefilling the New Debit Note screen */
app.get("/debit-note/next-number", (req, res) => {
  getNextDebitNoteNo((err, noteNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ noteNo });
  });
});

/* Purchase invoices for a supplier, so the Debit Note screen can offer
   "link this to an existing bill". Not filtered to outstanding-only —
   a fully paid invoice can still validly have goods returned against it,
   which just leaves the supplier owing us money back. */
app.get("/purchase-invoice/list", (req, res) => {
  const { supplier } = req.query;
  db.all(
    `
    SELECT
      pi.id, pi.invoice_no, pi.date, pi.supplier, pi.total_amount,
      (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
        WHERE pa.invoice_type = 'PURCHASE' AND pa.invoice_id = pi.id) AS paid,
      (SELECT IFNULL(SUM(dn.total_amount),0) FROM debit_note dn
        WHERE dn.purchase_invoice_id = pi.id) AS debited
    FROM purchase_invoice pi
    ${supplier ? "WHERE pi.supplier = ?" : ""}
    ORDER BY pi.date DESC, pi.id DESC
    `,
    supplier ? [supplier] : [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        ...r,
        balance: r.total_amount - r.paid - r.debited
      }));
      res.json(data);
    }
  );
});

/* Single purchase invoice with its line items, each annotated with how
   much has already been debited against it — so the Debit Note screen can
   cap the returnable qty per line at (qty - already_debited_qty). */
app.get("/purchase-invoice/:id", (req, res) => {
  db.get(`SELECT * FROM purchase_invoice WHERE id = ?`, [req.params.id], (err, inv) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!inv) return res.status(404).json({ error: "Purchase invoice not found" });

    db.all(
      `
      SELECT
        pii.*,
        (SELECT IFNULL(SUM(dni.qty),0) FROM debit_note_items dni
          WHERE dni.invoice_item_id = pii.id) AS already_debited_qty
      FROM purchase_invoice_items pii
      WHERE pii.invoice_id = ?
      ORDER BY pii.id
      `,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...inv, items });
      }
    );
  });
});

/* Create a Purchase Debit Note. Mirrors /purchase/save but in reverse:
   debits the supplier (reduces what we owe them) and credits Purchases +
   Input GST (reversing the original expense/credit claim). If linked to a
   purchase_invoice, each item line may optionally reference the specific
   invoice_item_id it's returning against, capped at what hasn't already
   been debited for that line. Independent debit notes (no invoice_id) skip
   that check entirely — items there are free-form, same as a direct
   purchase entry. */
app.post("/debit-note/save", async (req, res) => {
  const { date, supplier, purchase_invoice_id, reason, taxType, adjustsStock, items, supplierId, location_id } = req.body;

  if (!date || !supplier || !items?.length) {
    return res.status(400).json({ error: "Date, supplier and at least one item are required" });
  }

  const adjustStock = adjustsStock !== false; // default true

  let companyGstin, companyState, supplierRow, supplierState;
  try {
    companyGstin = await getSetting("company_gstin", "");
    companyState = getGstStateFromGstin(companyGstin);

    supplierRow = supplierId
      ? await new Promise((resolve, reject) => {
          db.get(`SELECT * FROM suppliers WHERE id = ?`, [supplierId], (err, row) =>
            err ? reject(err) : resolve(row)
          );
        })
      : null;
    supplierState = supplierRow ? getGstStateFromGstin(supplierRow.gstin) : null;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Same GSTIN-derived rule as /purchase/save.
  const isInterState = (companyState && supplierState)
    ? companyState.code !== supplierState.code
    : taxType === "INTER";

  try {
    let invoice = null;
    if (purchase_invoice_id) {
      invoice = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM purchase_invoice WHERE id = ?`, [purchase_invoice_id], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (!invoice) return res.status(400).json({ error: "Linked purchase invoice not found" });
      if (invoice.supplier !== supplier) {
        return res.status(400).json({ error: "Supplier does not match the linked purchase invoice" });
      }

      // Guard: can't debit more of a line than was actually billed on it
      for (const item of items) {
        if (!item.invoice_item_id) continue;
        const invItem = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM purchase_invoice_items WHERE id = ? AND invoice_id = ?`,
            [item.invoice_item_id, purchase_invoice_id],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });
        if (!invItem) {
          return res.status(400).json({ error: "Purchase invoice line item not found" });
        }
        const alreadyDebited = await new Promise((resolve, reject) => {
          db.get(
            `SELECT IFNULL(SUM(qty),0) AS q FROM debit_note_items WHERE invoice_item_id = ?`,
            [item.invoice_item_id],
            (err, row) => (err ? reject(err) : resolve(row.q))
          );
        });
        const returnable = invItem.qty - alreadyDebited;
        if (Number(item.qty) > returnable + 1e-6) {
          return res.status(400).json({
            error: `Cannot debit ${item.qty} of "${invItem.item_name}" — only ${returnable} still available to return (out of ${invItem.qty} billed).`
          });
        }
      }

      // Guard: the sum of all debit notes against an invoice can never
      // exceed what was actually billed on it.
      const alreadyDebitedTotal = await new Promise((resolve, reject) => {
        db.get(
          `SELECT IFNULL(SUM(total_amount),0) AS t FROM debit_note WHERE purchase_invoice_id = ?`,
          [purchase_invoice_id],
          (err, row) => (err ? reject(err) : resolve(row.t))
        );
      });
      const newTotal = items.reduce((s, i) => {
        const amt = Number(i.qty) * Number(i.rate);
        return s + amt + amt * ((Number(i.gst_rate) || 0) / 100);
      }, 0);
      if (alreadyDebitedTotal + newTotal > invoice.total_amount + 1e-6) {
        return res.status(400).json({
          error: `This debit note would take total debits on ${invoice.invoice_no} above its billed amount of ₹${invoice.total_amount.toFixed(2)}`
        });
      }
    }

    // Debit note stock reversal defaults to RM Store — it reverses a
    // GRN/PURCHASE, so it undoes the same location those used (matches the
    // Step 3 backfill's DEBIT NOTE → RM Store rule). Resolved before the
    // transaction starts.
    const debitNoteLocationId = adjustStock ? await resolveLocationId(location_id, "RM Store") : null;

    db.run("BEGIN TRANSACTION");

    let totalAmount = 0;
    let totalGst = 0;
    for (const item of items) {
      const lineAmount = Number(item.qty) * Number(item.rate);
      const gstRate = Number(item.gst_rate) || 0;
      totalAmount += lineAmount;
      totalGst += lineAmount * (gstRate / 100);
    }
    const grandTotal = totalAmount + totalGst;

    const noteNo = await new Promise((resolve, reject) => {
      getNextDebitNoteNo((err, no) => (err ? reject(err) : resolve(no)));
    });

    const dCgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const dSgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const dIgstAmt = isInterState ? totalGst : 0;

    const noteId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO debit_note
        (note_no, date, supplier, supplier_id, purchase_invoice_id, reason, adjusts_stock, taxable_value, cgst, sgst, igst, total_amount, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [noteNo, date, supplier, supplierId || null, purchase_invoice_id || null, reason || null, adjustStock ? 1 : 0,
         totalAmount, dCgstAmt, dSgstAmt, dIgstAmt, grandTotal, req.body.narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      const lineAmount = Number(item.qty) * Number(item.rate);
      const gstRate = Number(item.gst_rate) || 0;
      const lineGst = lineAmount * (gstRate / 100);

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO debit_note_items
          (note_id, item_id, invoice_item_id, item_name, qty, rate, taxable, gst_rate, gst_amount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [noteId, item.item_id || null, item.invoice_item_id || null, item.item_name,
           item.qty, item.rate, lineAmount, gstRate, lineGst, lineAmount + lineGst],
          err => (err ? reject(err) : resolve())
        );
      });

      // Stock reverses out (goods physically leaving, back to the supplier)
      // only when this note represents an actual return and the line is
      // tied to a real stock item — a pure price/rate adjustment on a
      // service-like line has no stock movement.
      if (adjustStock && item.item_id) {
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_out, rate, location_id)
            VALUES (?, ?, 'DEBIT NOTE', ?, ?, ?, ?)
            `,
            [item.item_id, date, noteNo, item.qty, item.rate, debitNoteLocationId],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

    /* Accounting entry — exact reversal of a purchase invoice: debit the
       supplier (what we owe them shrinks), credit Purchases and Input GST
       back out. */
    const entries = [
      { particulars: supplier, debit: grandTotal, credit: 0 }
    ];
    if (totalAmount > 0) {
      entries.push({ particulars: "Purchases A/c", debit: 0, credit: totalAmount });
    }
    if (totalGst > 0) {
      if (isInterState) {
        entries.push({ particulars: "Input IGST", debit: 0, credit: totalGst });
      } else {
        entries.push({ particulars: "Input CGST", debit: 0, credit: totalGst / 2 });
        entries.push({ particulars: "Input SGST", debit: 0, credit: totalGst / 2 });
      }
    }

    await saveJournalInternal({
      date,
      narration: `Debit Note ${noteNo}${invoice ? ` against ${invoice.invoice_no}` : ""}${reason ? " — " + reason : ""}`,
      entries
    });

    db.run("COMMIT");
    res.json({ status: "success", note_no: noteNo, id: noteId });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* Debit note register — optionally filtered to one supplier */
app.get("/debit-note/list", (req, res) => {
  const { supplier } = req.query;
  db.all(
    `
    SELECT dn.*, pi.invoice_no AS linked_invoice_no
    FROM debit_note dn
    LEFT JOIN purchase_invoice pi ON pi.id = dn.purchase_invoice_id
    ${supplier ? "WHERE dn.supplier = ?" : ""}
    ORDER BY dn.id DESC
    `,
    supplier ? [supplier] : [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Single debit note with its line items — for a view/print screen */
app.get("/debit-note/:id", (req, res) => {
  db.get(
    `
    SELECT dn.*, pi.invoice_no AS linked_invoice_no
    FROM debit_note dn
    LEFT JOIN purchase_invoice pi ON pi.id = dn.purchase_invoice_id
    WHERE dn.id = ?
    `,
    [req.params.id],
    (err, note) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!note) return res.status(404).json({ error: "Debit note not found" });

      db.all(
        `SELECT * FROM debit_note_items WHERE note_id = ? ORDER BY id`,
        [req.params.id],
        (err, items) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ ...note, items });
        }
      );
    }
  );
});

/* -------------------- CREDIT NOTES (SALES RETURNS / ADJUSTMENTS) -------------------- */
/* Mirrors the DEBIT NOTES section above exactly, but from the sales side:
   a credit note reduces what a customer owes us, instead of reducing what
   we owe a supplier. */

/* Next credit note number, for prefilling the New Credit Note screen */
app.get("/credit-note/next-number", (req, res) => {
  getNextCreditNoteNo((err, noteNo) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ noteNo });
  });
});

/* Sales invoices for a customer, so the Credit Note screen can offer
   "link this to an existing bill". Not filtered to outstanding-only —
   a fully paid invoice can still validly have goods returned against it,
   which just leaves us owing the customer money back. */
app.get("/sales-invoice/list", (req, res) => {
  const { customer } = req.query;
  db.all(
    `
    SELECT
      si.id, si.invoice_no, si.date, si.customer, si.total_amount,
      (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
        WHERE pa.invoice_type = 'SALES' AND pa.invoice_id = si.id) AS paid,
      (SELECT IFNULL(SUM(cn.total_amount),0) FROM credit_note cn
        WHERE cn.sales_invoice_id = si.id) AS credited
    FROM sales_invoice si
    ${customer ? "WHERE si.customer = ?" : ""}
    ORDER BY si.date DESC, si.id DESC
    `,
    customer ? [customer] : [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        ...r,
        balance: r.total_amount - r.paid - r.credited
      }));
      res.json(data);
    }
  );
});

/* Single sales invoice with its line items, each annotated with how much
   has already been credited against it — so the Credit Note screen can
   cap the returnable qty per line at (qty - already_credited_qty). */
app.get("/sales-invoice/:id", (req, res) => {
  db.get(`SELECT * FROM sales_invoice WHERE id = ?`, [req.params.id], (err, inv) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!inv) return res.status(404).json({ error: "Sales invoice not found" });

    db.all(
      `
      SELECT
        sii.*,
        sii.description AS item_name,
        (SELECT IFNULL(SUM(cni.qty),0) FROM credit_note_items cni
          WHERE cni.invoice_item_id = sii.id) AS already_credited_qty
      FROM sales_invoice_items sii
      WHERE sii.invoice_id = ?
      ORDER BY sii.id
      `,
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...inv, items });
      }
    );
  });
});

/* Create a Sales Credit Note. Mirrors /sales/save but in reverse: credits
   the customer (reduces what they owe us) and debits Sales + Output GST
   (reversing the original revenue/output-tax booking). If linked to a
   sales_invoice, each item line may optionally reference the specific
   invoice_item_id it's returning against, capped at what hasn't already
   been credited for that line. Independent credit notes (no invoice_id)
   skip that check entirely — items there are free-form, same as a direct
   sales entry. */
app.post("/credit-note/save", async (req, res) => {
  const { date, customer, sales_invoice_id, reason, taxType, adjustsStock, items, location_id } = req.body;

  if (!date || !customer || !items?.length) {
    return res.status(400).json({ error: "Date, customer and at least one item are required" });
  }

  const isInterState = taxType === "INTER";
  const adjustStock = adjustsStock !== false; // default true

  try {
    let invoice = null;
    if (sales_invoice_id) {
      invoice = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM sales_invoice WHERE id = ?`, [sales_invoice_id], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });
      if (!invoice) return res.status(400).json({ error: "Linked sales invoice not found" });
      if (invoice.customer !== customer) {
        return res.status(400).json({ error: "Customer does not match the linked sales invoice" });
      }
    }

    // Step 4 (fallback): a line with no invoice_item_id to inherit from —
    // a standalone credit note not linked to any sales invoice, or a line
    // within a linked note that just doesn't reference a specific invoice
    // line — has nothing to inherit a classification from, so it falls
    // back to whatever supply_type was sent on the request, defaulting to
    // TAXABLE. Lines that DO have an invoice_item_id are resolved below,
    // against the actual invoice line, which always takes precedence.
    for (const item of items) {
      if (invoice && item.invoice_item_id) continue;
      const supplyType = normalizeSupplyType(item.supply_type);
      if (!supplyType) {
        return res.status(400).json({
          error: `Invalid supply_type "${item.supply_type}" on line "${item.item_name || item.item_id}". Must be one of ${VALID_SUPPLY_TYPES.join(", ")}.`
        });
      }
      item.supply_type = supplyType;
      item.gst_rate = supplyType === "TAXABLE" ? (Number(item.gst_rate) || 0) : 0;
    }

    if (invoice) {
      // Guard: can't credit more of a line than was actually billed on it
      for (const item of items) {
        if (!item.invoice_item_id) continue;
        const invItem = await new Promise((resolve, reject) => {
          db.get(
            `SELECT * FROM sales_invoice_items WHERE id = ? AND invoice_id = ?`,
            [item.invoice_item_id, sales_invoice_id],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });
        if (!invItem) {
          return res.status(400).json({ error: "Sales invoice line item not found" });
        }

        // Step 4: a credit note line tied to a specific sales-invoice line
        // always inherits that line's supply_type — a return against an
        // EXEMPT/NIL_RATED/ZERO_RATED (export) line must stay untaxed no
        // matter what gst_rate the credit note form happens to submit, so
        // the original line's classification wins over anything the client
        // sent. Whatever GST rate came in on this line is discarded in
        // favour of that classification, exactly like /sales/save does
        // against the item master's default.
        item.supply_type = normalizeSupplyType(invItem.supply_type) || "TAXABLE";
        item.gst_rate = item.supply_type === "TAXABLE" ? (Number(item.gst_rate) || 0) : 0;

        const alreadyCredited = await new Promise((resolve, reject) => {
          db.get(
            `SELECT IFNULL(SUM(qty),0) AS q FROM credit_note_items WHERE invoice_item_id = ?`,
            [item.invoice_item_id],
            (err, row) => (err ? reject(err) : resolve(row.q))
          );
        });
        const returnable = invItem.qty - alreadyCredited;
        if (Number(item.qty) > returnable + 1e-6) {
          return res.status(400).json({
            error: `Cannot credit ${item.qty} of "${invItem.description}" — only ${returnable} still available to return (out of ${invItem.qty} billed).`
          });
        }
      }

      // Guard: the sum of all credit notes against an invoice can never
      // exceed what was actually billed on it.
      const alreadyCreditedTotal = await new Promise((resolve, reject) => {
        db.get(
          `SELECT IFNULL(SUM(total_amount),0) AS t FROM credit_note WHERE sales_invoice_id = ?`,
          [sales_invoice_id],
          (err, row) => (err ? reject(err) : resolve(row.t))
        );
      });
      const newTotal = items.reduce((s, i) => {
        const amt = Number(i.qty) * Number(i.rate);
        return s + amt + amt * ((Number(i.gst_rate) || 0) / 100);
      }, 0);
      if (alreadyCreditedTotal + newTotal > invoice.total_amount + 1e-6) {
        return res.status(400).json({
          error: `This credit note would take total credits on ${invoice.invoice_no} above its billed amount of ₹${invoice.total_amount.toFixed(2)}`
        });
      }
    }

    // Credit note stock reversal defaults to FG Store — it reverses a
    // SALE/DC, so it undoes the same location those used (matches the
    // Step 3 backfill's CREDIT NOTE → FG Store rule). Resolved before the
    // transaction starts.
    const creditNoteLocationId = adjustStock ? await resolveLocationId(location_id, "FG Store") : null;

    db.run("BEGIN TRANSACTION");

    let totalAmount = 0;
    let totalGst = 0;
    for (const item of items) {
      const lineAmount = Number(item.qty) * Number(item.rate);
      const gstRate = Number(item.gst_rate) || 0;
      totalAmount += lineAmount;
      totalGst += lineAmount * (gstRate / 100);
    }
    const grandTotal = totalAmount + totalGst;

    const noteNo = await new Promise((resolve, reject) => {
      getNextCreditNoteNo((err, no) => (err ? reject(err) : resolve(no)));
    });

    const cCgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const cSgstAmt = !isInterState && totalGst > 0 ? totalGst / 2 : 0;
    const cIgstAmt = isInterState ? totalGst : 0;

    const noteId = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO credit_note
        (note_no, date, customer, sales_invoice_id, reason, adjusts_stock, taxable_value, cgst, sgst, igst, total_amount, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [noteNo, date, customer, sales_invoice_id || null, reason || null, adjustStock ? 1 : 0,
         totalAmount, cCgstAmt, cSgstAmt, cIgstAmt, grandTotal, req.body.narration || null],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const item of items) {
      const lineAmount = Number(item.qty) * Number(item.rate);
      const gstRate = Number(item.gst_rate) || 0;
      const lineGst = lineAmount * (gstRate / 100);

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO credit_note_items
          (note_id, item_id, invoice_item_id, item_name, qty, rate, taxable, gst_rate, gst_amount, total, supply_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [noteId, item.item_id || null, item.invoice_item_id || null, item.item_name,
           item.qty, item.rate, lineAmount, gstRate, lineGst, lineAmount + lineGst, item.supply_type],
          err => (err ? reject(err) : resolve())
        );
      });

      // Stock reverses back in (goods physically returning to us) only
      // when this note represents an actual return and the line is tied
      // to a real stock item — a pure price/rate adjustment on a
      // service-like line has no stock movement.
      if (adjustStock && item.item_id) {
        await new Promise((resolve, reject) => {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate, location_id)
            VALUES (?, ?, 'CREDIT NOTE', ?, ?, ?, ?)
            `,
            [item.item_id, date, noteNo, item.qty, item.rate, creditNoteLocationId],
            err => (err ? reject(err) : resolve())
          );
        });
      }
    }

    /* Accounting entry — exact reversal of a sales invoice: credit the
       customer (what they owe us shrinks), debit Sales and Output GST
       back out. */
    const entries = [
      { particulars: customer, debit: 0, credit: grandTotal }
    ];
    if (totalAmount > 0) {
      entries.push({ particulars: "Sales A/c", debit: totalAmount, credit: 0 });
    }
    if (totalGst > 0) {
      if (isInterState) {
        entries.push({ particulars: "Output IGST", debit: totalGst, credit: 0 });
      } else {
        entries.push({ particulars: "Output CGST", debit: totalGst / 2, credit: 0 });
        entries.push({ particulars: "Output SGST", debit: totalGst / 2, credit: 0 });
      }
    }

    await saveJournalInternal({
      date,
      narration: `Credit Note ${noteNo}${invoice ? ` against ${invoice.invoice_no}` : ""}${reason ? " — " + reason : ""}`,
      entries
    });

    db.run("COMMIT");
    res.json({ status: "success", note_no: noteNo, id: noteId });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* Credit note register — optionally filtered to one customer */
app.get("/credit-note/list", (req, res) => {
  const { customer } = req.query;
  db.all(
    `
    SELECT cn.*, si.invoice_no AS linked_invoice_no
    FROM credit_note cn
    LEFT JOIN sales_invoice si ON si.id = cn.sales_invoice_id
    ${customer ? "WHERE cn.customer = ?" : ""}
    ORDER BY cn.id DESC
    `,
    customer ? [customer] : [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Single credit note with its line items — for a view/print screen */
app.get("/credit-note/:id", (req, res) => {
  db.get(
    `
    SELECT cn.*, si.invoice_no AS linked_invoice_no
    FROM credit_note cn
    LEFT JOIN sales_invoice si ON si.id = cn.sales_invoice_id
    WHERE cn.id = ?
    `,
    [req.params.id],
    (err, note) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!note) return res.status(404).json({ error: "Credit note not found" });

      db.all(
        `SELECT * FROM credit_note_items WHERE note_id = ? ORDER BY id`,
        [req.params.id],
        (err, items) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ ...note, items });
        }
      );
    }
  );
});

/* -------------------- PAYMENTS & RECEIVABLES -------------------- */

/* Distinct customer/supplier names, for the party dropdown on the
   Payment/Receipt screen. Sourced from ledger_master so it includes every
   party that's ever had a ledger created (even before their first
   invoice), not just ones with existing invoices. */
app.get("/parties/customers", (req, res) => {
  db.all(
    `SELECT ledger AS name FROM ledger_master WHERE ledger_group = 'Sundry Debtors' ORDER BY ledger`,
    [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

app.get("/parties/suppliers", (req, res) => {
  db.all(
    `SELECT ledger AS name FROM ledger_master WHERE ledger_group = 'Sundry Creditors' ORDER BY ledger`,
    [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Outstanding sales invoices (optionally filtered to one customer) — each
   invoice's balance is its total minus whatever has been allocated to it
   from payment_allocation, minus any credit notes linked to it — a sales
   return lowers what the customer owes just as much as cash received
   does. Only invoices with balance > 0 are returned, oldest first, which
   also makes this ready to drive a "settle oldest first" default on the
   Receipt screen. */
app.get("/receivables/outstanding", (req, res) => {
  const { customer } = req.query;
  db.all(
    `
    SELECT * FROM (
      SELECT
        si.id, si.invoice_no, si.date, si.customer, si.total_amount,
        (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
          WHERE pa.invoice_type = 'SALES' AND pa.invoice_id = si.id) AS paid,
        (SELECT IFNULL(SUM(cn.total_amount),0) FROM credit_note cn
          WHERE cn.sales_invoice_id = si.id) AS credited,
        si.total_amount
          - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
              WHERE pa.invoice_type = 'SALES' AND pa.invoice_id = si.id)
          - (SELECT IFNULL(SUM(cn.total_amount),0) FROM credit_note cn
              WHERE cn.sales_invoice_id = si.id) AS balance
      FROM sales_invoice si
      ${customer ? "WHERE si.customer = ?" : ""}
    )
    WHERE balance > 0.005
    ORDER BY date, id
    `,
    customer ? [customer] : [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Same idea for purchase invoices (payables). Balance is reduced both by
   payments allocated against the invoice AND by any debit notes linked to
   it — a goods return lowers what we owe just as much as cash paid does. */
app.get("/payables/outstanding", (req, res) => {
  const { supplier } = req.query;
  db.all(
    `
    SELECT * FROM (
      SELECT
        pi.id, pi.invoice_no, pi.date, pi.supplier, pi.total_amount,
        (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
          WHERE pa.invoice_type = 'PURCHASE' AND pa.invoice_id = pi.id) AS paid,
        (SELECT IFNULL(SUM(dn.total_amount),0) FROM debit_note dn
          WHERE dn.purchase_invoice_id = pi.id) AS debited,
        pi.total_amount
          - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
              WHERE pa.invoice_type = 'PURCHASE' AND pa.invoice_id = pi.id)
          - (SELECT IFNULL(SUM(dn.total_amount),0) FROM debit_note dn
              WHERE dn.purchase_invoice_id = pi.id) AS balance
      FROM purchase_invoice pi
      ${supplier ? "WHERE pi.supplier = ?" : ""}
    )
    WHERE balance > 0.005
    ORDER BY date, id
    `,
    supplier ? [supplier] : [],
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Ageing report — every party with a non-zero balance, bucketed by how
   long each outstanding invoice has been open as of today. type=receivable
   uses sales_invoice/customer, type=payable uses purchase_invoice/supplier. */
app.get("/report/ageing", (req, res) => {
  const type = req.query.type === "payable" ? "payable" : "receivable";

  const sql = type === "payable"
    ? `
      SELECT * FROM (
        SELECT pi.id, pi.invoice_no, pi.date, pi.supplier AS party, pi.total_amount,
               pi.total_amount
                 - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
                     WHERE pa.invoice_type = 'PURCHASE' AND pa.invoice_id = pi.id)
                 - (SELECT IFNULL(SUM(dn.total_amount),0) FROM debit_note dn
                     WHERE dn.purchase_invoice_id = pi.id) AS balance
        FROM purchase_invoice pi
      )
      WHERE balance > 0.005
      `
    : `
      SELECT * FROM (
        SELECT si.id, si.invoice_no, si.date, si.customer AS party, si.total_amount,
               si.total_amount
                 - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
                     WHERE pa.invoice_type = 'SALES' AND pa.invoice_id = si.id)
                 - (SELECT IFNULL(SUM(cn.total_amount),0) FROM credit_note cn
                     WHERE cn.sales_invoice_id = si.id) AS balance
        FROM sales_invoice si
      )
      WHERE balance > 0.005
      `;

  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const today = new Date();
    const bucketOf = (dateStr) => {
      const days = Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));
      if (days <= 30) return "0-30";
      if (days <= 60) return "31-60";
      if (days <= 90) return "61-90";
      return "90+";
    };

    const byParty = {};
    for (const r of rows) {
      const bucket = bucketOf(r.date);
      if (!byParty[r.party]) {
        byParty[r.party] = {
          party: r.party,
          total: 0,
          buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
          invoices: []
        };
      }
      byParty[r.party].total += r.balance;
      byParty[r.party].buckets[bucket] += r.balance;
      byParty[r.party].invoices.push({
        invoice_no: r.invoice_no, date: r.date, total_amount: r.total_amount,
        balance: r.balance, bucket
      });
    }

    res.json(Object.values(byParty).sort((a, b) => b.total - a.total));
  });
});

/* Record a Payment (to a supplier) or Receipt (from a customer), optionally
   allocated across specific outstanding invoices. Any amount not
   allocated is left as an unallocated advance against the party — still a
   valid accounting entry, just not tied to one invoice yet. */
app.post("/payment/save", async (req, res) => {
  const { type, date, party, mode_ledger, amount, narration, allocations } = req.body;

  if (!type || !["PAYMENT", "RECEIPT"].includes(type)) {
    return res.status(400).json({ error: "type must be PAYMENT or RECEIPT" });
  }
  if (!date || !party || !mode_ledger || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "date, party, mode_ledger and a positive amount are required" });
  }

  const allocList = Array.isArray(allocations) ? allocations : [];
  const allocSum = allocList.reduce((s, a) => s + (Number(a.allocated_amount) || 0), 0);
  if (allocSum > Number(amount) + 1e-6) {
    return res.status(400).json({ error: "Allocated amounts exceed the payment amount" });
  }

  try {
    db.run("BEGIN TRANSACTION");

    // Validate each allocation doesn't exceed that invoice's own outstanding balance
    for (const a of allocList) {
      if (!a.invoice_id || !a.invoice_type || !(Number(a.allocated_amount) > 0)) {
        throw new Error("Each allocation needs invoice_type, invoice_id and a positive allocated_amount");
      }
      const table = a.invoice_type === "PURCHASE" ? "purchase_invoice" : "sales_invoice";
      const invoice = await new Promise((resolve, reject) => {
        db.get(`SELECT * FROM ${table} WHERE id = ?`, [a.invoice_id], (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (!invoice) throw new Error(`${a.invoice_type} invoice not found`);

      const alreadyPaid = await new Promise((resolve, reject) => {
        db.get(
          `SELECT IFNULL(SUM(allocated_amount),0) AS paid FROM payment_allocation WHERE invoice_type = ? AND invoice_id = ?`,
          [a.invoice_type, a.invoice_id],
          (err, row) => (err ? reject(err) : resolve(row.paid))
        );
      });
      // Debit notes reduce what's owed on a purchase invoice, and credit
      // notes reduce what's owed on a sales invoice, just like a payment
      // allocation would.
      const alreadyDebited = a.invoice_type !== "PURCHASE" ? 0 : await new Promise((resolve, reject) => {
        db.get(
          `SELECT IFNULL(SUM(total_amount),0) AS debited FROM debit_note WHERE purchase_invoice_id = ?`,
          [a.invoice_id],
          (err, row) => (err ? reject(err) : resolve(row.debited))
        );
      });
      const alreadyCredited = a.invoice_type !== "SALES" ? 0 : await new Promise((resolve, reject) => {
        db.get(
          `SELECT IFNULL(SUM(total_amount),0) AS credited FROM credit_note WHERE sales_invoice_id = ?`,
          [a.invoice_id],
          (err, row) => (err ? reject(err) : resolve(row.credited))
        );
      });
      const outstanding = invoice.total_amount - alreadyPaid - alreadyDebited - alreadyCredited;
      if (Number(a.allocated_amount) > outstanding + 1e-6) {
        throw new Error(`Cannot allocate ₹${a.allocated_amount} to invoice ${invoice.invoice_no} — only ₹${outstanding.toFixed(2)} outstanding`);
      }
    }

    const voucherNo = await new Promise((resolve, reject) => {
      getNextPaymentVoucherNo(type, (err, no) => (err ? reject(err) : resolve(no)));
    });

    // Journal entry: PAYMENT debits the supplier (reducing what we owe them)
    // and credits the cash/bank ledger. RECEIPT is the mirror image.
    const entries = type === "PAYMENT"
      ? [
          { particulars: party, debit: Number(amount), credit: 0 },
          { particulars: mode_ledger, debit: 0, credit: Number(amount) }
        ]
      : [
          { particulars: mode_ledger, debit: Number(amount), credit: 0 },
          { particulars: party, debit: 0, credit: Number(amount) }
        ];

    const journalVoucherNo = await saveJournalInternal({
      date,
      narration: narration || `${type === "PAYMENT" ? "Payment to" : "Receipt from"} ${party}`,
      entries
    });

    const paymentId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payment_voucher (voucher_no, type, date, party, mode_ledger, amount, narration, journal_voucher_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [voucherNo, type, date, party, mode_ledger, Number(amount), narration || null, journalVoucherNo],
        function (err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    for (const a of allocList) {
      const table = a.invoice_type === "PURCHASE" ? "purchase_invoice" : "sales_invoice";
      const invoice = await new Promise((resolve, reject) => {
        db.get(`SELECT invoice_no FROM ${table} WHERE id = ?`, [a.invoice_id], (err, row) => (err ? reject(err) : resolve(row)));
      });
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO payment_allocation (payment_id, invoice_type, invoice_id, invoice_no, allocated_amount)
           VALUES (?, ?, ?, ?, ?)`,
          [paymentId, a.invoice_type, a.invoice_id, invoice.invoice_no, Number(a.allocated_amount)],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    db.run("COMMIT");
    res.json({ status: "success", voucher_no: voucherNo, payment_id: paymentId });

  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/* History list, newest first, optionally filtered by type/party */
app.get("/payment/list", (req, res) => {
  const { type, party } = req.query;
  const clauses = [];
  const params = [];
  if (type) { clauses.push("type = ?"); params.push(type); }
  if (party) { clauses.push("party = ?"); params.push(party); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  db.all(
    `SELECT * FROM payment_voucher ${where} ORDER BY date DESC, id DESC`,
    params,
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

/* Single payment with its allocation breakdown */
app.get("/payment/:id", (req, res) => {
  db.get(`SELECT * FROM payment_voucher WHERE id = ?`, [req.params.id], (err, payment) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    db.all(
      `SELECT * FROM payment_allocation WHERE payment_id = ?`,
      [req.params.id],
      (err, allocations) => (err ? res.status(500).json({ error: err.message }) : res.json({ ...payment, allocations }))
    );
  });
});

/* Reverse a payment entirely — removes its allocations, its journal
   voucher, and the payment record itself, so outstanding balances and the
   ledger both go back to exactly how they were before it was recorded. */
app.delete("/payment/:id", async (req, res) => {
  try {
    const payment = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM payment_voucher WHERE id = ?`, [req.params.id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    db.run("BEGIN TRANSACTION");

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM payment_allocation WHERE payment_id = ?`, [req.params.id], err => (err ? reject(err) : resolve()));
    });

    if (payment.journal_voucher_no) {
      const jv = await new Promise((resolve, reject) => {
        db.get(`SELECT id FROM journal_voucher WHERE voucher_no = ?`, [payment.journal_voucher_no], (err, row) => (err ? reject(err) : resolve(row)));
      });
      if (jv) {
        await new Promise((resolve, reject) => {
          db.run(`DELETE FROM journal_entries WHERE voucher_id = ?`, [jv.id], err => (err ? reject(err) : resolve()));
        });
        await new Promise((resolve, reject) => {
          db.run(`DELETE FROM journal_voucher WHERE id = ?`, [jv.id], err => (err ? reject(err) : resolve()));
        });
      }
      await new Promise((resolve, reject) => {
        db.run(`DELETE FROM ledger_entries WHERE voucher_no = ?`, [payment.journal_voucher_no], err => (err ? reject(err) : resolve()));
      });
    }

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM payment_voucher WHERE id = ?`, [req.params.id], err => (err ? reject(err) : resolve()));
    });

    db.run("COMMIT");
    res.json({ status: "deleted" });
  } catch (err) {
    db.run("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- ITEM LIST (FOR DROPDOWN/SERACH) -------------------- */

app.get("/report/items", (req, res) => {
  db.all(
    `
    SELECT
      id,
      item_name,
      hsn,
      unit,
      gst_rate,
      selling_price,
      item_type,
      secondary_unit,
      conversion_factor,
      reorder_level,
      reorder_qty
    FROM item_master
    ORDER BY item_name
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- LOW STOCK REPORT (Scrap & Reorder Alerts, Step 8) --------------------
   GET /report/low-stock — every item whose current balance has fallen to
   or below its own reorder_level, for the Main Menu widget (Step 9) and
   the Item Wise Report badge (Step 10) to both read off without each
   re-deriving it from stock_ledger independently.

   Only items with reorder_level > 0 are even considered — 0 is the
   Step 1 "alerts off for this item" sentinel, so an unset item is never
   flagged no matter how low (or negative) its balance runs. This is
   enforced in SQL (WHERE reorder_level > 0) rather than left to the
   caller to filter, so every consumer gets the same "opted in" behavior
   for free.

   balance is SUM(qty_in) - SUM(qty_out), item-wide across every
   location — same shape as the Item Wise Report's closing_stock (no
   location_id filter here; a low-stock alert is about the item's total
   position, not any one location's). Computed with a LEFT JOIN so an
   item with reorder_level set but zero stock_ledger rows still balances
   to 0 (and so still qualifies) rather than being silently dropped by an
   INNER JOIN.

   The qualifying cut is "at or below" (<=) reorder_level, not strictly
   below — reaching the threshold is exactly when a reorder should be
   raised, not one unit later. reorder_qty rides along unfiltered/
   unvalidated (it can be 0 even for a qualifying item) so the widget can
   suggest "reorder ${reorder_qty}" when set, and the caller decides how
   to handle 0.

   Ordered by how far under the item actually is (balance - reorder_level,
   most negative/most overdue first) rather than alphabetically, so the
   widget's most urgent items surface at the top without the frontend
   having to re-sort. */
app.get("/report/low-stock", (req, res) => {
  db.all(
    `
    SELECT
      i.id AS item_id,
      i.item_name,
      i.unit,
      IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS balance,
      i.reorder_level,
      i.reorder_qty
    FROM item_master i
    LEFT JOIN stock_ledger s ON s.item_id = i.id
    WHERE i.reorder_level > 0
    GROUP BY i.id
    HAVING balance <= i.reorder_level
    ORDER BY (balance - i.reorder_level) ASC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* -------------------- ITEM WISE DETAIL REPORT -------------------- */

/* Location-aware as of Phase 2, Step 8:
   - ?location_id= (optional) scopes `summary` and `movements` to one
     location — e.g. "how much of this item, and what moved it, at RM
     Store only". Omitted, both stay item-wide exactly as before.
   - `by_location` is always the full per-location breakdown (every
     location's in/out/balance for this item), regardless of the filter,
     so the report can show "qty at RM Store vs qty at FG Store" side by
     side even while a single location is selected.
   - `unassigned` carries any stock_ledger rows still sitting on
     location_id IS NULL (pre-Step-3-backfill leftovers, or a voucher
     type the backfill script's VOUCHER_TYPE_TO_LOCATION map doesn't
     recognise yet). Only included when such rows actually exist, so it
     doesn't clutter the report for a database that's fully located. */
/* Location-aware as of Phase 2, Step 8; batch-aware as of Batch Tracking,
   Step 9:
   - ?location_id= (optional) scopes `summary` and `movements` to one
     location — e.g. "how much of this item, and what moved it, at RM
     Store only". Omitted, both stay item-wide exactly as before.
   - ?batch_no= (optional) scopes `summary` and `movements` to one batch,
     same shape as ?location_id= and combinable with it — e.g. "how much
     of this item, in this batch, at RM Store only". Pass batch_no=__NONE__
     to scope to un-batched stock specifically (rows with batch_no IS
     NULL), since an empty/omitted param means "no batch filter" rather
     than "only un-batched rows".
   - `by_location` is always the full per-location breakdown (every
     location's in/out/balance for this item), regardless of the filter,
     so the report can show "qty at RM Store vs qty at FG Store" side by
     side even while a single location is selected.
   - `by_batch` is the same idea for batches (Step 9): always the full
     per-batch in/out/balance for this item across every location,
     regardless of either filter, each with its expiry_date surfaced (the
     MAX expiry_date ever recorded against that item+batch_no — batches
     are expected to carry one consistent expiry, but MAX is a safe
     tie-breaker if a later GRN line for the same batch ever records a
     slightly different date) so ageing/near-expiry stock is visible at a
     glance without cross-referencing GRN history. Only batched rows
     (batch_no IS NOT NULL) are grouped here; un-batched stock is what
     `unassigned_batch` (below) covers instead — same "only surfaced when
     it actually exists" convention as `unassigned` for location.
   - `unassigned_batch` mirrors `unassigned` (location) but for batch:
     totals for this item's rows still sitting on batch_no IS NULL (never
     received through a batch-aware GRN, or predating Batch Tracking
     entirely). Only included when such rows exist.
   - `available_batches` is a plain list of every batch_no this item has
     ever been tagged with, each with its expiry_date — meant for a
     frontend batch filter dropdown (Item Wise Report UI, Step 10) without
     that screen having to derive it from `by_batch` itself. */
app.get("/report/item/:itemId", (req, res) => {
  const itemId = req.params.itemId;
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  const rawBatchNo = req.query.batch_no || null;
  // "__NONE__" is the sentinel a caller passes to mean "un-batched rows
  // only" (batch_no IS NULL) — distinct from omitting the param entirely,
  // which means "no batch filter at all".
  const batchFilterMode = rawBatchNo === "__NONE__" ? "NULL" : rawBatchNo ? "VALUE" : null;

  const batchCondition =
    batchFilterMode === "NULL" ? "AND s.batch_no IS NULL" :
    batchFilterMode === "VALUE" ? "AND s.batch_no = ?" : "";
  const batchParam = batchFilterMode === "VALUE" ? [rawBatchNo] : [];

  const getSummary = () => new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        i.item_name,
        i.hsn,
        i.unit,
        i.gst_rate,
        i.selling_price,
        i.reorder_level,
        i.reorder_qty,
        IFNULL(SUM(s.qty_in),0) AS total_in,
        IFNULL(SUM(s.qty_out),0) AS total_out,
        IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS closing_stock
      FROM item_master i
      LEFT JOIN stock_ledger s ON i.id = s.item_id
        ${locationId ? "AND s.location_id = ?" : ""}
        ${batchCondition}
      WHERE i.id = ?
      `,
      [...(locationId ? [locationId] : []), ...batchParam, itemId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  const getMovements = () => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        s.date,
        s.voucher_type,
        s.voucher_no,
        s.qty_in,
        s.qty_out,
        s.rate,
        s.location_id,
        l.location_name,
        s.batch_no,
        (SELECT MAX(e.expiry_date) FROM stock_ledger e
          WHERE e.item_id = s.item_id AND e.batch_no = s.batch_no) AS expiry_date
      FROM stock_ledger s
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.item_id = ?
        ${locationId ? "AND s.location_id = ?" : ""}
        ${batchCondition}
      ORDER BY s.date, s.id
      `,
      [itemId, ...(locationId ? [locationId] : []), ...batchParam],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  const getByLocation = () => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        l.id AS location_id,
        l.location_name,
        l.is_active,
        IFNULL(SUM(s.qty_in),0) AS total_in,
        IFNULL(SUM(s.qty_out),0) AS total_out,
        IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS balance
      FROM locations l
      LEFT JOIN stock_ledger s ON s.location_id = l.id AND s.item_id = ?
      GROUP BY l.id
      ORDER BY l.location_name
      `,
      [itemId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  const getUnassigned = () => new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        IFNULL(SUM(qty_in),0) AS total_in,
        IFNULL(SUM(qty_out),0) AS total_out,
        IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS balance
      FROM stock_ledger
      WHERE item_id = ? AND location_id IS NULL
      `,
      [itemId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  // Batch Tracking Step 9: per-batch breakdown, always full (every location,
  // regardless of either query filter) — same convention as by_location.
  // Expiry is the batch's own recorded expiry_date, not derived from
  // movement rows individually, so it stays correct even for a batch whose
  // only remaining rows are consumption (qty_out) with expiry_date left
  // NULL on those particular rows (Step 5/7 only ever set batch_no on
  // issue/completion rows, not expiry_date — that's carried on the GRN
  // receipt row instead).
  const getByBatch = () => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        s.batch_no,
        MAX(s.expiry_date) AS expiry_date,
        IFNULL(SUM(s.qty_in),0) AS total_in,
        IFNULL(SUM(s.qty_out),0) AS total_out,
        IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS balance
      FROM stock_ledger s
      WHERE s.item_id = ? AND s.batch_no IS NOT NULL
      GROUP BY s.batch_no
      ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, s.batch_no ASC
      `,
      [itemId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  const getUnassignedBatch = () => new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        IFNULL(SUM(qty_in),0) AS total_in,
        IFNULL(SUM(qty_out),0) AS total_out,
        IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS balance
      FROM stock_ledger
      WHERE item_id = ? AND batch_no IS NULL
      `,
      [itemId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  const getAvailableBatches = () => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT batch_no, MAX(expiry_date) AS expiry_date
      FROM stock_ledger
      WHERE item_id = ? AND batch_no IS NOT NULL
      GROUP BY batch_no
      ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, batch_no ASC
      `,
      [itemId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  // Scrap total (Scrap & Reorder Alerts, Step 10): item-wide qty/value
  // scrapped across every Work Order, not just one — so the Item Wise
  // Report can show "stock health and wastage history together" for this
  // item regardless of which WO(s) it was scrapped against. Reads the same
  // wo_scrap table Step 5's per-WO history endpoint sums from, just
  // grouped by item_id alone instead of by (wo_id, item_id) — the WO
  // breakdown itself belongs on the WO screen, not here. Only meaningful
  // when the item has actually been scrapped at least once, same
  // "omit entirely when there's nothing to show" convention as
  // `unassigned`/`unassigned_batch` above.
  const getScrapSummary = () => new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        IFNULL(SUM(qty),0) AS total_qty,
        IFNULL(SUM(qty * rate),0) AS total_value
      FROM wo_scrap
      WHERE item_id = ?
      `,
      [itemId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  Promise.all([
    getSummary(),
    getMovements(),
    getByLocation(),
    getUnassigned(),
    getByBatch(),
    getUnassignedBatch(),
    getAvailableBatches(),
    getScrapSummary()
  ])
    .then(([summary, movements, by_location, unassigned, by_batch, unassignedBatch, available_batches, scrapSummary]) => {
      const hasUnassigned = unassigned && (unassigned.total_in !== 0 || unassigned.total_out !== 0);
      const hasUnassignedBatch = unassignedBatch && (unassignedBatch.total_in !== 0 || unassignedBatch.total_out !== 0);
      const hasScrap = scrapSummary && Number(scrapSummary.total_qty) !== 0;
      res.json({
        summary,
        movements,
        by_location,
        unassigned: hasUnassigned ? unassigned : null,
        by_batch,
        unassigned_batch: hasUnassignedBatch ? unassignedBatch : null,
        available_batches,
        scrap_summary: hasScrap ? scrapSummary : null,
        filtered_location_id: locationId,
        filtered_batch_no: batchFilterMode ? (batchFilterMode === "NULL" ? "__NONE__" : rawBatchNo) : null
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

/* -------------------- GST MONTHLY SUMMARY -------------------- */

/* Built directly from source documents (sales/purchase invoices, netted
   against credit/debit notes) rather than from ledger_entries balances.
   This matches how GSTR-1 (outward supplies, net of credit notes) and
   GSTR-3B (ITC available, net of debit notes reversing input) are actually
   structured, and stays correct regardless of what a journal entry's
   particulars happen to be named — it reads the tax fields that were
   computed and stored on the invoice/note itself at save time.

   NOTE: an earlier version of this endpoint summed only the debit side of
   each Input ledger and only the credit side of each Output ledger from
   ledger_entries. That silently ignored the reversing entries that debit
   notes (credit Input GST) and credit notes (debit Output GST) post to
   those same ledgers — so a month with sales returns would overstate GST
   payable, and a month with purchase returns would overstate input credit
   claimed. Computing from documents avoids that class of bug entirely. */
app.get("/report/gst-summary", (req, res) => {
  const month = req.query.month; // expected format: YYYY-MM

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }

  const sumDoc = (table, dateCol = "date") => new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        COUNT(*) AS count,
        IFNULL(SUM(taxable_value),0) AS taxable_value,
        IFNULL(SUM(cgst),0) AS cgst,
        IFNULL(SUM(sgst),0) AS sgst,
        IFNULL(SUM(igst),0) AS igst,
        IFNULL(SUM(total_amount),0) AS total_amount
      FROM ${table}
      WHERE strftime('%Y-%m', ${dateCol}) = ?
      `,
      [month],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  // sumDoc above sums each document's HEADER taxable_value, which is the
  // total of every line on it regardless of supply_type — so an exempt or
  // zero-rated (export) line's amount was ending up counted as ordinary
  // taxable outward supply. GSTR-1 keeps those apart (Table 8 for
  // EXEMPT/NIL_RATED, Table 6A for ZERO_RATED exports), so the outward
  // taxable_value below is instead built line-by-line from
  // sales_invoice_items/credit_note_items, bucketed by each line's own
  // supply_type. Only outward (sales) supplies carry a supply_type today —
  // purchases/debit notes are untouched by this.
  const sumLinesByCategory = (itemsTable, headerTable, headerIdCol, dateCol = "date") => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT li.supply_type AS supply_type, li.taxable AS taxable
      FROM ${itemsTable} li
      JOIN ${headerTable} h ON h.id = li.${headerIdCol}
      WHERE strftime('%Y-%m', h.${dateCol}) = ?
      `,
      [month],
      (err, rows) => {
        if (err) return reject(err);
        const totals = { taxable: 0, exempt_nil: 0, zero_rated: 0 };
        rows.forEach(r => {
          totals[supplyCategory(r.supply_type)] += Number(r.taxable) || 0;
        });
        resolve(totals);
      }
    );
  });

  Promise.all([
    sumDoc("sales_invoice"),
    sumDoc("credit_note"),
    sumDoc("purchase_invoice"),
    sumDoc("debit_note"),
    sumLinesByCategory("sales_invoice_items", "sales_invoice", "invoice_id"),
    sumLinesByCategory("credit_note_items", "credit_note", "note_id")
  ])
    .then(([sales, creditNotes, purchases, debitNotes, salesByCat, creditByCat]) => {
      // Outward: sales invoices raised this month, less credit notes
      // issued this month (regardless of which month the original invoice
      // was raised in — a return is reported in the period it happens).
      // taxable_value here is TAXABLE lines only (see sumLinesByCategory
      // above) — exempt/nil-rated and zero-rated lines are broken out
      // into their own buckets below instead of being lumped in here.
      const outwardTaxable = salesByCat.taxable - creditByCat.taxable;
      const outputIGST = sales.igst - creditNotes.igst;
      const outputCGST = sales.cgst - creditNotes.cgst;
      const outputSGST = sales.sgst - creditNotes.sgst;
      const outputTotal = outputIGST + outputCGST + outputSGST;

      // GSTR-1 Table 8 style bucket — EXEMPT + NIL_RATED outward supplies.
      // Always 0% GST by construction (Step 3), so there's no tax split to
      // report here, only the value.
      const outwardExemptNil = salesByCat.exempt_nil - creditByCat.exempt_nil;

      // GSTR-1 Table 6A style bucket — ZERO_RATED (export/SEZ under LUT)
      // outward supplies. Also always 0% GST by construction.
      const outwardZeroRated = salesByCat.zero_rated - creditByCat.zero_rated;

      // Inward: purchase invoices booked this month, less debit notes
      // issued this month.
      const inwardTaxable = purchases.taxable_value - debitNotes.taxable_value;
      const inputIGST = purchases.igst - debitNotes.igst;
      const inputCGST = purchases.cgst - debitNotes.cgst;
      const inputSGST = purchases.sgst - debitNotes.sgst;
      const inputTotal = inputIGST + inputCGST + inputSGST;

      const netIGST = outputIGST - inputIGST;
      const netCGST = outputCGST - inputCGST;
      const netSGST = outputSGST - inputSGST;
      const netPayable = outputTotal - inputTotal;

      res.json({
        month,
        outward: {
          taxable_value: salesByCat.taxable,
          credit_notes_value: creditByCat.taxable,
          net_taxable_value: outwardTaxable,
          invoice_count: sales.count,
          credit_note_count: creditNotes.count,
          exempt_nil_rated: {
            value: salesByCat.exempt_nil,
            credit_notes_value: creditByCat.exempt_nil,
            net_value: outwardExemptNil
          },
          zero_rated: {
            value: salesByCat.zero_rated,
            credit_notes_value: creditByCat.zero_rated,
            net_value: outwardZeroRated
          }
        },
        inward: {
          taxable_value: purchases.taxable_value,
          debit_notes_value: debitNotes.taxable_value,
          net_taxable_value: inwardTaxable,
          invoice_count: purchases.count,
          debit_note_count: debitNotes.count
        },
        input: {
          igst: inputIGST,
          cgst: inputCGST,
          sgst: inputSGST,
          total: inputTotal
        },
        output: {
          igst: outputIGST,
          cgst: outputCGST,
          sgst: outputSGST,
          total: outputTotal
        },
        net: {
          igst: netIGST,
          cgst: netCGST,
          sgst: netSGST,
          total: netPayable
        }
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

/* -------------------- HSN-WISE SUMMARY (GSTR-1 TABLE 12) --------------------
   GSTR-1 Table 12 requires, for the filing period, ONE row per HSN/SAC
   with: description, UQC, total quantity, total value, taxable value, and
   the IGST/CGST/SGST/cess split. This is different from the per-invoice
   HSN tax box already on the invoice PDF — that resets every invoice; this
   report aggregates across every sales invoice line in the chosen month,
   net of credit notes issued in that month (mirroring how /report/gst-
   summary nets outward supplies), which is what actually gets typed into
   the return.

   Each sales_invoice_items row stores its own gst_amount but not the
   cgst/sgst/igst split — that split is decided once per invoice (intra-
   state vs inter-state), so we read each invoice's igst/cgst/sgst header
   values to know which bucket its lines' tax falls into, then prorate.
   Credit note lines are subtracted the same way using the credit note's
   own header tax type.

   B2B / B2C SPLIT (GSTN advisory 01-May-2025, Phase-3, effective the
   May-2025 return period): Table 12 is now two separate tabs on the GST
   portal — 12A (B2B, mandatory, every registered-buyer supply) and 12B
   (B2C, mandatory only above Rs 5cr AATO). A line is B2B if the buyer had
   a GSTIN on file at the time of the invoice/credit note; otherwise B2C.
   sales_invoice carries client_id directly, so that's joined straight to
   clients. credit_note has no client_id column (it only stores a free-
   text "customer" name), so its lines are classified by matching that
   name against the clients master by name instead — the same lookup the
   UI's client autocomplete already relies on elsewhere in this file. */
// Shared aggregation used by both /report/hsn-summary and the GSTR-1 JSON
// export's Table 12 section, so the two stay in sync instead of drifting
// apart. Resolves to { b2b, b2c, rows, totals, has_missing_hsn } — same
// shape the route below used to build inline.
function computeHsnSummary(month) {
  return new Promise((resolve, reject) => {
  // net_sign: +1 for sales invoice lines, -1 for credit note lines (netted off).
  // nameCol differs by table: sales_invoice_items stores "description",
  // credit_note_items stores "item_name" — normalize both to line_item_name.
  // hasHsnCol: only sales_invoice_items has its own hsn column; credit_note_items
  // doesn't, so we fall back to the item_master join (im.hsn) for those lines.
  // clientJoinSql: how to resolve the buyer's GSTIN for this table — see
  // the B2B/B2C note above for why sales_invoice and credit_note differ.
  const fetchLines = (itemsTable, headerTable, headerIdCol, dateCol, nameCol, hasHsnCol, clientJoinSql, netSign) => new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        ${hasHsnCol ? "li.hsn" : "NULL"} AS line_hsn,
        im.hsn AS item_hsn,
        im.unit AS item_unit,
        li.${nameCol} AS line_item_name,
        im.item_name AS master_item_name,
        li.qty AS qty,
        li.taxable AS taxable,
        li.gst_amount AS gst_amount,
        li.supply_type AS supply_type,
        h.igst AS header_igst,
        h.cgst AS header_cgst,
        h.sgst AS header_sgst,
        cl.gstin AS buyer_gstin
      FROM ${itemsTable} li
      JOIN ${headerTable} h ON h.id = li.${headerIdCol}
      LEFT JOIN item_master im ON im.id = li.item_id
      LEFT JOIN clients cl ON ${clientJoinSql}
      WHERE strftime('%Y-%m', h.${dateCol}) = ?
      `,
      [month],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => ({ ...r, net_sign: netSign })));
      }
    );
  });

  Promise.all([
    fetchLines("sales_invoice_items", "sales_invoice", "invoice_id", "date", "description", true, "cl.id = h.client_id", 1),
    fetchLines("credit_note_items", "credit_note", "note_id", "date", "item_name", false, "cl.name = h.customer", -1)
  ])
    .then(([salesLines, creditLines]) => {
      const allLines = salesLines.concat(creditLines);

      // Independent aggregations, one per GSTR-1 bucket. b2b/b2c cover only
      // ordinary TAXABLE lines (Table 12A/12B) — EXEMPT/NIL_RATED lines are
      // kept apart in their own Table 8 style bucket, and ZERO_RATED
      // (export/SEZ under LUT) lines in their own Table 6A style bucket,
      // instead of all three being lumped into the same taxable HSN rows.
      const b2bSummary = {};
      const b2cSummary = {};
      const exemptNilSummary = {};
      const zeroRatedSummary = {};

      allLines.forEach(row => {
        const hsn = (row.line_hsn && String(row.line_hsn).trim()) || (row.item_hsn && String(row.item_hsn).trim()) || "MISSING";
        const isInterState = Number(row.header_igst) > 0;
        // Prorate this line's own gst_amount into the invoice's tax type,
        // since the split is decided once per invoice, not per line.
        const lineGst = Number(row.gst_amount) || 0;
        const igst = isInterState ? lineGst : 0;
        const cgst = isInterState ? 0 : lineGst / 2;
        const sgst = isInterState ? 0 : lineGst / 2;

        const category = supplyCategory(row.supply_type);
        let summary;
        if (category === "exempt_nil") {
          summary = exemptNilSummary;
        } else if (category === "zero_rated") {
          summary = zeroRatedSummary;
        } else {
          const isB2B = !!(row.buyer_gstin && String(row.buyer_gstin).trim());
          summary = isB2B ? b2bSummary : b2cSummary;
        }

        if (!summary[hsn]) {
          summary[hsn] = {
            hsn,
            description: row.master_item_name || row.line_item_name || "",
            uqc: row.item_unit || "",
            total_quantity: 0,
            taxable_value: 0,
            igst: 0,
            cgst: 0,
            sgst: 0,
            total_value: 0,
            missing_hsn: hsn === "MISSING"
          };
        }

        const s = summary[hsn];
        const sign = row.net_sign;
        s.total_quantity += sign * (Number(row.qty) || 0);
        s.taxable_value += sign * (Number(row.taxable) || 0);
        s.igst += sign * igst;
        s.cgst += sign * cgst;
        s.sgst += sign * sgst;
        s.total_value += sign * ((Number(row.taxable) || 0) + lineGst);
      });

      const buildBucket = summary => {
        const rows = Object.values(summary).sort((a, b) => a.hsn.localeCompare(b.hsn));
        const totals = rows.reduce((acc, r) => {
          acc.total_quantity += r.total_quantity;
          acc.taxable_value += r.taxable_value;
          acc.igst += r.igst;
          acc.cgst += r.cgst;
          acc.sgst += r.sgst;
          acc.total_value += r.total_value;
          return acc;
        }, { total_quantity: 0, taxable_value: 0, igst: 0, cgst: 0, sgst: 0, total_value: 0 });
        return { rows, totals, has_missing_hsn: rows.some(r => r.missing_hsn) };
      };

      const b2b = buildBucket(b2bSummary);
      const b2c = buildBucket(b2cSummary);
      const exemptNil = buildBucket(exemptNilSummary);
      const zeroRated = buildBucket(zeroRatedSummary);

      // Combined view kept for anything still reading the old flat shape
      // (and for feeding the taxable side of the GSTR-1 JSON export) —
      // covers only the taxable B2B/B2C rows, since exempt_nil and
      // zero_rated are reported separately now, not folded back in here.
      const combinedRows = b2b.rows.concat(b2c.rows)
        .reduce((acc, r) => {
          const existing = acc.find(x => x.hsn === r.hsn);
          if (existing) {
            existing.total_quantity += r.total_quantity;
            existing.taxable_value += r.taxable_value;
            existing.igst += r.igst;
            existing.cgst += r.cgst;
            existing.sgst += r.sgst;
            existing.total_value += r.total_value;
          } else {
            acc.push({ ...r });
          }
          return acc;
        }, [])
        .sort((a, b) => a.hsn.localeCompare(b.hsn));
      const combinedTotals = combinedRows.reduce((acc, r) => {
        acc.total_quantity += r.total_quantity;
        acc.taxable_value += r.taxable_value;
        acc.igst += r.igst;
        acc.cgst += r.cgst;
        acc.sgst += r.sgst;
        acc.total_value += r.total_value;
        return acc;
      }, { total_quantity: 0, taxable_value: 0, igst: 0, cgst: 0, sgst: 0, total_value: 0 });

      resolve({
        b2b,   // GSTR-1 Table 12A — every registered buyer, taxable lines only, mandatory regardless of turnover
        b2c,   // GSTR-1 Table 12B — unregistered buyers, taxable lines only, mandatory only above Rs 5cr AATO
        exempt_nil: exemptNil,   // GSTR-1 Table 8 style — EXEMPT + NIL_RATED lines, HSN-wise, kept apart from the taxable summary
        zero_rated: zeroRated,   // GSTR-1 Table 6A style — ZERO_RATED (export/SEZ under LUT) lines, HSN-wise, kept apart from the taxable summary
        rows: combinedRows,
        totals: combinedTotals,
        has_missing_hsn: b2b.has_missing_hsn || b2c.has_missing_hsn || exemptNil.has_missing_hsn || zeroRated.has_missing_hsn
      });
    })
    .catch(reject);
  });
}

app.get("/report/hsn-summary", (req, res) => {
  const month = req.query.month; // expected format: YYYY-MM

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }

  computeHsnSummary(month)
    .then(result => res.json({ month, ...result }))
    .catch(err => res.status(500).json({ error: err.message }));
});

/* -------------------- GSTR-1 JSON EXPORT --------------------
   Builds the return in the shape of the GSTN "Returns Offline Tool" JSON
   (the same file format the department's own offline utility imports),
   from the same source documents as /report/gst-summary and
   /report/hsn-summary — sales invoices netted against credit notes for
   the chosen period. Nothing here is re-derived from ledger balances.

   Sections produced:
     b2b   Table 4A — invoices to registered buyers (client has a GSTIN
           on file), grouped by buyer GSTIN, one entry per invoice with
           a rate-wise item breakdown (GSTR-1 wants one row per tax rate
           per invoice, not one per line item).
     b2cs  Table 7  — invoices to unregistered buyers, aggregated by tax
           rate + place of supply. INTRA-state only — see the KNOWN GAP
           note below.
     cdnr  Table 9B — credit notes against buyers who have a GSTIN on
           file, grouped by buyer GSTIN.
     cdnur Table 9B — always empty here; see KNOWN GAP below.
     hsn   Table 12 — same aggregation as /report/hsn-summary, reshaped
           into the portal's numbered hsn.data[] format.
     doc_issue Table 13 — invoice/credit-note number series issued this
           month. This system has no document-cancellation flow, so the
           "cancelled" count is always reported as 0.

   KNOWN GAP: this system has never captured a place of supply / state
   for unregistered (no-GSTIN) customers — only a registered buyer's
   GSTIN tells us their state. So any INTER-state sale or credit note to
   an unregistered buyer (igst > 0, no client GSTIN on file) can't be
   safely bucketed into b2cs/cdnur, both of which require a POS state
   code. Rather than guess a state and file an incorrect return, those
   rows are left out of the JSON and listed under `warnings` in the
   preview response so they can be added by hand before upload. */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// "2026-08-15" -> "15-08-2026" (the offline tool's expected date format).
// Parsed from the string directly rather than via `new Date(...)` so a
// server running in a non-IST timezone can't shift the day by one.
function ddmmyyyy(isoDate) {
  const s = String(isoDate || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/* -------------------- SHARED: NET OUTWARD SUPPLIES BY CATEGORY --------------------
   STEP 6 of the GSTR-3B build. buildGstr1 already fetches four source-
   document arrays for a period — salesHeaders/salesItems (sales invoices +
   their lines) and creditHeaders/creditItems (credit notes + their lines)
   — and, for its Table 8 section, walks them netting each EXEMPT/NIL_RATED
   line's amount (sales this month LESS credit notes issued this month,
   sign +1/-1) into buckets. GSTR-3B Table 3.1 needs exactly the same kind
   of netting pass, just over ALL three supply categories (taxable/
   zero_rated/exempt_nil) summed into a single period total instead of
   split by buyer type — so that pass is pulled out here as its own
   function instead of writing a second, slightly-different version of it
   for Table 3.1.

   forEachNettedLine does the generic part — group each item array by its
   own header's id, then visit every line once per document with the sign
   that document contributes (sales = +1, credit notes = -1) — so any
   future netted-by-category need (GSTR-1's Table 8 below, GSTR-3B's Table
   3.1, or whatever comes next) can reuse it instead of re-deriving the
   group-by-doc-id-and-net pattern again. */
function forEachNettedLine(salesHeaders, salesItems, creditHeaders, creditItems, visit) {
  const groupByDoc = (rows, keyCol) => {
    const byDoc = {};
    rows.forEach(r => {
      const key = r[keyCol];
      if (!byDoc[key]) byDoc[key] = [];
      byDoc[key].push(r);
    });
    return byDoc;
  };
  const salesByInvoice = groupByDoc(salesItems, "invoice_id");
  const creditByNote = groupByDoc(creditItems, "note_id");

  salesHeaders.forEach(doc => {
    (salesByInvoice[doc.id] || []).forEach(row => visit(doc, row, 1));
  });
  creditHeaders.forEach(doc => {
    (creditByNote[doc.id] || []).forEach(row => visit(doc, row, -1));
  });
}

// Nets every outward-supply line for the period into the three GSTR-3B
// Table 3.1 buckets — 'taxable' (3.1(a)), 'zero_rated' (3.1(b)),
// 'exempt_nil' (3.1(c)) — each as { taxable, igst, cgst, sgst }. Tax is
// split igst vs cgst+sgst using each document's OWN igst field to decide
// inter- vs intra-state, same rule /sales/save uses to post GST in the
// first place — not re-derived from GSTINs here. In practice zero_rated
// and exempt_nil lines always carry gst_amount=0 (forced at save time, see
// the supply_type comments near VALID_SUPPLY_TYPES), so their igst/cgst/
// sgst come out zero; the split is computed generically anyway rather than
// hardcoded, so nothing here silently hides a line that doesn't behave as
// expected.
function netOutwardSuppliesByCategory(salesHeaders, salesItems, creditHeaders, creditItems) {
  const totals = {
    taxable: { taxable: 0, igst: 0, cgst: 0, sgst: 0 },
    zero_rated: { taxable: 0, igst: 0, cgst: 0, sgst: 0 },
    exempt_nil: { taxable: 0, igst: 0, cgst: 0, sgst: 0 }
  };

  forEachNettedLine(salesHeaders, salesItems, creditHeaders, creditItems, (doc, row, sign) => {
    const cat = supplyCategory(row.supply_type);
    const isInterState = Number(doc.igst) > 0;
    const taxableAmt = sign * (Number(row.taxable) || 0);
    const gstAmt = sign * (Number(row.gst_amount) || 0);

    totals[cat].taxable += taxableAmt;
    if (isInterState) {
      totals[cat].igst += gstAmt;
    } else {
      totals[cat].cgst += gstAmt / 2;
      totals[cat].sgst += gstAmt / 2;
    }
  });

  return totals;
}

function buildGstr1(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    getSetting("company_gstin", ""),
    dbAll(
      `SELECT si.id, si.invoice_no, si.date, si.customer, si.total_amount,
              si.cgst, si.sgst, si.igst, cl.gstin AS buyer_gstin
       FROM sales_invoice si
       LEFT JOIN clients cl ON cl.id = si.client_id
       WHERE strftime('%Y-%m', si.date) = ?
       ORDER BY si.invoice_no`,
      [month]
    ),
    dbAll(
      `SELECT sii.invoice_id, sii.gst_rate, sii.taxable, sii.gst_amount, sii.supply_type
       FROM sales_invoice_items sii
       JOIN sales_invoice si ON si.id = sii.invoice_id
       WHERE strftime('%Y-%m', si.date) = ?`,
      [month]
    ),
    dbAll(
      `SELECT cn.id, cn.note_no, cn.date, cn.customer, cn.total_amount,
              cn.cgst, cn.sgst, cn.igst, cl.gstin AS buyer_gstin
       FROM credit_note cn
       LEFT JOIN clients cl ON cl.name = cn.customer
       WHERE strftime('%Y-%m', cn.date) = ?
       ORDER BY cn.note_no`,
      [month]
    ),
    dbAll(
      `SELECT cni.note_id, cni.gst_rate, cni.taxable, cni.gst_amount, cni.supply_type
       FROM credit_note_items cni
       JOIN credit_note cn ON cn.id = cni.note_id
       WHERE strftime('%Y-%m', cn.date) = ?`,
      [month]
    ),
    computeHsnSummary(month)
  ]).then(async ([rawGstin, salesHeaders, salesItems, creditHeaders, creditItems, hsnResult]) => {
    const companyGstin = normalizeGstin(rawGstin);
    if (!isValidGstin(companyGstin)) {
      const err = new Error("Set a valid Company GSTIN in Settings before exporting GSTR-1 — it's required as the filer GSTIN on the return.");
      err.statusCode = 400;
      throw err;
    }
    const companyState = getGstStateFromGstin(companyGstin);

    // No source documents at all for this period — the single most common
    // reason the export comes back looking "blank". Rather than silently
    // hand back an empty-but-valid JSON skeleton (b2b: [], b2cs: [], ...),
    // tell the user which months DO have data, so a wrong month selection
    // (e.g. the month picker defaulting to the current month) is obvious
    // immediately instead of only showing up as a confusing empty file.
    if (!salesHeaders.length && !creditHeaders.length) {
      const monthsWithData = await dbAll(
        `SELECT DISTINCT strftime('%Y-%m', date) AS m FROM sales_invoice WHERE date IS NOT NULL
         UNION
         SELECT DISTINCT strftime('%Y-%m', date) AS m FROM credit_note WHERE date IS NOT NULL
         ORDER BY m DESC LIMIT 12`
      );
      const list = monthsWithData.map(r => r.m).filter(Boolean);
      const err = new Error(
        list.length
          ? `No sales invoices or credit notes found for ${month}. You have data for: ${list.join(", ")}. Pick one of those months instead.`
          : `No sales invoices or credit notes found for ${month} — in fact none exist anywhere yet. Create at least one Sales Invoice before exporting GSTR-1.`
      );
      err.statusCode = 400;
      throw err;
    }

    // Group each document's line items by gst_rate — GSTR-1 wants one
    // itm_det per rate per invoice/note, not one per line item.
    //
    // Only ORDINARY TAXABLE lines belong in this rate-wise breakdown (it
    // feeds Table 4A/4B/7/9B below). EXEMPT/NIL_RATED/ZERO_RATED lines
    // always carry gst_rate=0 (forced at save time), so without this
    // filter they'd silently fall into the "0%" bucket here and get
    // reported as ordinary 0%-rated taxable supply in Table 4A/7 — wrong,
    // and exactly the lumping-together Step 5 was meant to undo. Those
    // lines are pulled out separately below into the exp/nil sections
    // (Table 6A / Table 8) instead.
    const groupByRate = (rows, keyCol) => {
      const byDoc = {};
      rows.forEach(r => {
        if (supplyCategory(r.supply_type) !== "taxable") return;
        const key = r[keyCol];
        if (!byDoc[key]) byDoc[key] = {};
        const rate = Number(r.gst_rate) || 0;
        if (!byDoc[key][rate]) byDoc[key][rate] = { taxable: 0, gst: 0 };
        byDoc[key][rate].taxable += Number(r.taxable) || 0;
        byDoc[key][rate].gst += Number(r.gst_amount) || 0;
      });
      return byDoc;
    };
    const salesItemsByInvoice = groupByRate(salesItems, "invoice_id");
    const creditItemsByNote = groupByRate(creditItems, "note_id");

    const buildItms = (ratesObj, isInterState) =>
      Object.entries(ratesObj).map(([rate, v], idx) => ({
        num: idx + 1,
        itm_det: {
          txval: round2(v.taxable),
          rt: Number(rate),
          iamt: isInterState ? round2(v.gst) : 0,
          camt: isInterState ? 0 : round2(v.gst / 2),
          samt: isInterState ? 0 : round2(v.gst / 2),
          csamt: 0
        }
      }));

    const warnings = [];
    const b2bByGstin = {};
    const cdnrByGstin = {};
    const b2csBuckets = {}; // key: "<rate>|<pos>" -> running totals

    const addToB2cs = (rates, sign) => {
      Object.entries(rates).forEach(([rate, v]) => {
        const pos = companyState ? companyState.code : "";
        const key = `${rate}|${pos}`;
        if (!b2csBuckets[key]) {
          b2csBuckets[key] = { rt: Number(rate), pos, sply_ty: "INTRA", txval: 0, camt: 0, samt: 0 };
        }
        b2csBuckets[key].txval += sign * v.taxable;
        b2csBuckets[key].camt += sign * (v.gst / 2);
        b2csBuckets[key].samt += sign * (v.gst / 2);
      });
    };

    salesHeaders.forEach(inv => {
      const isInterState = Number(inv.igst) > 0;
      const rates = salesItemsByInvoice[inv.id] || {};
      const gstin = inv.buyer_gstin ? normalizeGstin(inv.buyer_gstin) : "";

      if (gstin && isValidGstin(gstin)) {
        const buyerState = getGstStateFromGstin(gstin);
        if (!b2bByGstin[gstin]) b2bByGstin[gstin] = [];
        b2bByGstin[gstin].push({
          inum: inv.invoice_no,
          idt: ddmmyyyy(inv.date),
          val: round2(inv.total_amount),
          pos: buyerState ? buyerState.code : "",
          rchrg: "N",
          inv_typ: "R",
          itms: buildItms(rates, isInterState)
        });
      } else if (!isInterState) {
        addToB2cs(rates, 1);
      } else {
        warnings.push({
          type: "b2c_interstate_pos_unknown",
          doc: "Sales Invoice",
          number: inv.invoice_no,
          date: inv.date,
          value: round2(inv.total_amount),
          message: `Invoice ${inv.invoice_no} (₹${round2(inv.total_amount)}) is an inter-state sale to an unregistered customer — place of supply isn't on file, so it's excluded here. Add it to Table 7 (B2C-Small) in the offline tool manually, with the buyer's state as POS.`
        });
      }
    });

    creditHeaders.forEach(note => {
      const isInterState = Number(note.igst) > 0;
      const rates = creditItemsByNote[note.id] || {};
      const gstin = note.buyer_gstin ? normalizeGstin(note.buyer_gstin) : "";

      if (gstin && isValidGstin(gstin)) {
        const buyerState = getGstStateFromGstin(gstin);
        if (!cdnrByGstin[gstin]) cdnrByGstin[gstin] = [];
        cdnrByGstin[gstin].push({
          ntty: "C",
          nt_num: note.note_no,
          nt_dt: ddmmyyyy(note.date),
          pos: buyerState ? buyerState.code : "",
          rchrg: "N",
          inv_typ: "R",
          val: round2(note.total_amount),
          itms: buildItms(rates, isInterState)
        });
      } else if (!isInterState) {
        // Unregistered + intra-state nets straight back into the b2cs
        // bucket it originally came from — same as GSTR-1 itself does;
        // it doesn't get its own cdnur entry.
        addToB2cs(rates, -1);
      } else {
        warnings.push({
          type: "cdnur_interstate_pos_unknown",
          doc: "Credit Note",
          number: note.note_no,
          date: note.date,
          value: round2(note.total_amount),
          message: `Credit note ${note.note_no} (₹${round2(note.total_amount)}) is against an inter-state unregistered sale — place of supply isn't on file, so it's excluded here. Add it to Table 9B (CDNUR) in the offline tool manually.`
        });
      }
    });

    // ---------- TABLE 6A (EXPORTS / ZERO-RATED UNDER LUT) ----------
    // Every ZERO_RATED line bills at 0% IGST (forced at save time, Step 3)
    // and always carries the Rule 46 export declaration on the invoice
    // (Step 6) — so exp_typ is always "WOPAY" (without payment of IGST)
    // here; this system has no path for paying IGST on an export and
    // claiming a refund instead of using a LUT.
    //
    // Grouped per invoice, using only that invoice's ZERO_RATED lines.
    // NOT netted against credit notes — a return against an export can't
    // be cleanly reconciled against the original shipping bill from here,
    // so any zero-rated credit note lines are surfaced as a warning
    // instead of being silently subtracted.
    const expByInvoice = {};
    salesItems.forEach(r => {
      if (supplyCategory(r.supply_type) !== "zero_rated") return;
      expByInvoice[r.invoice_id] = (expByInvoice[r.invoice_id] || 0) + (Number(r.taxable) || 0);
    });

    const expInvoices = [];
    salesHeaders.forEach(inv => {
      const txval = expByInvoice[inv.id];
      if (!txval || Math.abs(txval) < 0.005) return;
      expInvoices.push({
        inum: inv.invoice_no,
        idt: ddmmyyyy(inv.date),
        val: round2(txval),
        // Shipping Bill number/date/port code aren't captured anywhere in
        // this system today — required by the portal, left blank here and
        // flagged below so they get filled in before upload.
        sbpcode: "",
        sbnum: "",
        sbdt: "",
        itms: [{ txval: round2(txval), iamt: 0 }]
      });
    });
    if (expInvoices.length) {
      warnings.push({
        type: "exp_shipping_bill_missing",
        message: `${expInvoices.length} export invoice(s) are included under Table 6A, but this system doesn't capture Shipping Bill number/date/port code — fill those in manually in the offline tool before filing.`
      });
    }
    const exp = expInvoices.length ? [{ exp_typ: "WOPAY", inv: expInvoices }] : [];

    if (creditItems.some(r => supplyCategory(r.supply_type) === "zero_rated")) {
      warnings.push({
        type: "exp_credit_note_not_netted",
        message: "One or more credit notes this period are against zero-rated (export) invoice lines. Table 6A above is NOT netted for these — reduce the relevant export invoice figures manually before filing."
      });
    }

    // ---------- TABLE 8 (EXEMPT / NIL-RATED OUTWARD SUPPLIES) ----------
    // Netted the same way as the taxable buckets above: sales this month
    // less credit notes issued this month, classified into the portal's
    // four sply_ty buckets by the document's own buyer-GSTIN (B2B vs B2C)
    // and igst (inter vs intra) — same classification logic as
    // addToB2cs/cdnr above. This system has no separate "non-GST supply"
    // classification, so ngsup_amt is always reported as 0.
    //
    // The group-by-doc-id-and-net-with-sign pass itself is shared with
    // GSTR-3B's Table 3.1 (see forEachNettedLine, Step 6) — this section
    // only adds the EXEMPT/NIL_RATED filtering and sply_ty bucketing on
    // top, which is specific to GSTR-1's Table 8 shape.
    const nilBuckets = {}; // sply_ty -> { expt_amt, nil_amt }
    forEachNettedLine(salesHeaders, salesItems, creditHeaders, creditItems, (doc, row, sign) => {
      const cat = normalizeSupplyType(row.supply_type);
      if (cat !== "EXEMPT" && cat !== "NIL_RATED") return;

      const isInterState = Number(doc.igst) > 0;
      const gstin = doc.buyer_gstin ? normalizeGstin(doc.buyer_gstin) : "";
      const isB2B = !!(gstin && isValidGstin(gstin));
      const sply_ty = `${isInterState ? "INTER" : "INTRA"}${isB2B ? "B2B" : "B2C"}`;
      if (!nilBuckets[sply_ty]) nilBuckets[sply_ty] = { expt_amt: 0, nil_amt: 0 };

      const amt = sign * (Number(row.taxable) || 0);
      if (cat === "EXEMPT") nilBuckets[sply_ty].expt_amt += amt;
      else nilBuckets[sply_ty].nil_amt += amt;
    });

    const nilInv = Object.entries(nilBuckets)
      .map(([sply_ty, v]) => ({
        sply_ty,
        expt_amt: round2(v.expt_amt),
        nil_amt: round2(v.nil_amt),
        ngsup_amt: 0
      }))
      .filter(row => Math.abs(row.expt_amt) > 0.004 || Math.abs(row.nil_amt) > 0.004);
    const nil = { inv: nilInv };

    const b2b = Object.entries(b2bByGstin).map(([ctin, inv]) => ({ ctin, inv }));
    const cdnr = Object.entries(cdnrByGstin).map(([ctin, nt]) => ({ ctin, nt }));
    const b2cs = Object.values(b2csBuckets)
      .filter(row => Math.abs(row.txval) > 0.004) // drop rows a full net-off zeroed out
      .map(row => ({
        sply_ty: row.sply_ty,
        rt: row.rt,
        typ: "OE", // Over-the-counter / non-e-commerce — this system doesn't track an e-commerce operator GSTIN
        pos: row.pos,
        txval: round2(row.txval),
        iamt: 0,
        camt: round2(row.camt),
        samt: round2(row.samt),
        csamt: 0
      }));

    if (hsnResult.has_missing_hsn) {
      warnings.push({
        type: "missing_hsn",
        message: "One or more sales lines this month have no HSN/SAC code on file. Table 12 requires it on every row — fix these on Item Master before filing."
      });
    }
    const hsnData = hsnResult.rows.map((r, idx) => ({
      num: idx + 1,
      hsn_sc: r.hsn === "MISSING" ? "" : r.hsn,
      desc: r.description || "",
      uqc: r.uqc || "OTH",
      qty: round2(r.total_quantity),
      val: round2(r.total_value),
      txval: round2(r.taxable_value),
      iamt: round2(r.igst),
      camt: round2(r.cgst),
      samt: round2(r.sgst),
      csamt: 0
    }));

    const docIssue = { doc_det: [] };
    if (salesHeaders.length) {
      const nums = salesHeaders.map(h => h.invoice_no).sort();
      docIssue.doc_det.push({
        doc_num: 1, // Nature of document 1 = Invoices for outward supply
        docs: [{ num: 1, from: nums[0], to: nums[nums.length - 1], totnum: salesHeaders.length, cancel: 0, net_issue: salesHeaders.length }]
      });
    }
    if (creditHeaders.length) {
      const nums = creditHeaders.map(h => h.note_no).sort();
      docIssue.doc_det.push({
        doc_num: 4, // Nature of document 4 = Credit Note
        docs: [{ num: 1, from: nums[0], to: nums[nums.length - 1], totnum: creditHeaders.length, cancel: 0, net_issue: creditHeaders.length }]
      });
    }

    // Data existed for the month, but every single row of it was excluded
    // (see the KNOWN GAP note at the top of this function — inter-state
    // sales/credit-notes to unregistered buyers get pulled out into
    // `warnings` instead of guessed into a bucket). Without this check the
    // user gets a fully empty-but-"successful" JSON with no clue why, since
    // `warnings` lives on `summary` and never reaches the downloaded file.
    const totalReportableRows = b2b.length + b2cs.length + cdnr.length + exp.length + nilInv.length + hsnData.length;
    if (totalReportableRows === 0 && warnings.length) {
      const err = new Error(
        `${month}: found ${salesHeaders.length} invoice(s) and ${creditHeaders.length} credit note(s), but every one of them was excluded from the export — ` +
        warnings.map(w => w.message).join(" ")
      );
      err.statusCode = 400;
      throw err;
    }

    const [yyyy, mm] = month.split("-");
    const fp = `${mm}${yyyy}`;

    const gstr1 = {
      gstin: companyGstin,
      fp,
      version: "GST3.2.3",
      hash: "hash",
      b2b,
      b2cs,
      cdnr,
      cdnur: [],
      exp,
      nil,
      hsn: { data: hsnData },
      doc_issue: docIssue
    };

    const summary = {
      month,
      filer_gstin: companyGstin,
      invoice_count: salesHeaders.length,
      credit_note_count: creditHeaders.length,
      b2b_buyers: b2b.length,
      b2b_invoices: b2b.reduce((n, x) => n + x.inv.length, 0),
      b2cs_rows: b2cs.length,
      cdnr_buyers: cdnr.length,
      cdnr_notes: cdnr.reduce((n, x) => n + x.nt.length, 0),
      exp_invoices: expInvoices.length,
      nil_rows: nilInv.length,
      hsn_rows: hsnData.length,
      warnings
    };

    return { summary, gstr1 };
  });
}

// Preview: returns { summary, gstr1 } as JSON for the UI to render counts
// and warnings before the user downloads anything.
app.get("/report/gstr1-json", (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }
  buildGstr1(month)
    .then(result => res.json(result))
    .catch(err => res.status(err.statusCode || 500).json({ error: err.message }));
});

// Download: identical payload, but as an attachment named the way the
// GSTN offline tool's own exports are named, so it can be fed straight in.
app.get("/report/gstr1-json/download", (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }
  buildGstr1(month)
    .then(({ gstr1 }) => {
      res.setHeader("Content-Disposition", `attachment; filename="GSTR1_${gstr1.gstin}_${gstr1.fp}.json"`);
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(gstr1, null, 2));
    })
    .catch(err => res.status(err.statusCode || 500).json({ error: err.message }));
});

/* -------------------- GSTR-3B JSON SHAPE --------------------
   STEP 1 of the GSTR-3B build: lock the target JSON shape before any
   aggregation code is written, so every later step (see build plan) has a
   fixed destination to write into instead of inventing keys as it goes.

   These are the exact top-level keys and nesting used by the GSTN
   "Returns Offline Tool" / GST portal upload JSON for GSTR-3B (verified
   against real decoded GSTR-3B payloads, not just the user-manual
   descriptions — the manual describes table numbers, this is the actual
   wire format):

     gstin        filer's GSTIN.
     ret_period   "MMYYYY" (note: NOT "MMDDYYYY" and not GSTR-1's "fp" name
                  — GSTR-3B calls the same kind of value ret_period).

     sup_details  Table 3.1 (a)-(e) — outward supplies + inward RCM.
       osup_det       3.1(a) Outward taxable (other than zero/nil/exempt)
       osup_zero      3.1(b) Outward zero rated (exports, SEZ)
       osup_nil_exmp  3.1(c) Other outward supplies (nil rated, exempt)
       isup_rev       3.1(d) Inward supplies liable to reverse charge
       osup_nongst    3.1(e) Non-GST outward supplies
       each is {txval, iamt, camt, samt, csamt} — portal accepts a bare
       {txval:0} when a section has no tax lines (see real payloads), but
       we always emit the full five-key object for consistency.

     inter_sup    Table 3.2 — inter-state supplies carved out of 3.1(a),
                  broken out to unregistered persons / composition
                  taxpayers / UIN holders. Each list entry is
                  {pos, txval, iamt} where pos is the 2-digit state code
                  of the place of supply. Cannot exceed 3.1(a) txval.
       unreg_details[]  to unregistered persons
       comp_details[]   to composition taxpayers
       uin_details[]    to UIN holders

     itc_elg      Table 4 — Eligible ITC.
       itc_avl[]    4(A) rows 1/2/3/4/5, one object per row, each
                    {ty, iamt, camt, samt, csamt}:
                      ty "IMPG"  row 1  Import of goods
                      ty "IMPS"  row 2  Import of services
                      ty "ISRC"  row 3  Inward supplies liable to RCM
                                        (fed from the same RCM total as
                                        sup_details.isup_rev — see step 11)
                      ty "ISD"   row 4  Input Service Distributor credit
                      ty "OTH"   row 5  All other ITC
       itc_rev[]    4(B) rows 1/2, {ty, iamt, camt, samt, csamt}:
                      ty "RUL"  Rule 42/43 reversal
                      ty "OTH"  Other reversals
       itc_net      4(C) Net ITC available = 4(A) total − 4(B) total,
                    a single {iamt, camt, samt, csamt} object (not a list).
       itc_inelg[]  4(D) rows 1/2, {ty, iamt, camt, samt, csamt}:
                      ty "RUL"  Sec 17(5) blocked credits
                      ty "OTH"  Other ineligible ITC

     inward_sup   Table 5 — exempt/nil/non-GST inward supplies.
       isup_details[]  {ty, inter, intra}:
                      ty "GST"     composition/exempt/nil-rated inward
                      ty "NONGST"  non-GST inward

   Deliberately NOT part of the locked shape (see build plan / KNOWN GAPs):
     intr_ltfee, tx_pmt  — Table 5.1 / 6.1, out of scope (step 16), this
                            system has no GST payment ledger.

   emptyGstr3bShape() below returns this structure with every amount
   zeroed and every list in its correct (possibly empty) form. Later
   steps fill in real numbers by assigning into the object it returns —
   they should never add, rename, or reshape a key here. */

function emptyGstr3bShape(gstin, ret_period) {
  const zeroQuad = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
  const zeroItcRow = (ty) => ({ ty, iamt: 0, camt: 0, samt: 0, csamt: 0 });

  return {
    gstin,
    ret_period,
    sup_details: {
      osup_det: zeroQuad(),
      osup_zero: zeroQuad(),
      osup_nil_exmp: zeroQuad(),
      isup_rev: zeroQuad(),
      osup_nongst: zeroQuad()
    },
    inter_sup: {
      unreg_details: [],
      comp_details: [],
      uin_details: []
    },
    itc_elg: {
      itc_avl: [
        zeroItcRow("IMPG"),
        zeroItcRow("IMPS"),
        zeroItcRow("ISRC"),
        zeroItcRow("ISD"),
        zeroItcRow("OTH")
      ],
      itc_rev: [
        zeroItcRow("RUL"),
        zeroItcRow("OTH")
      ],
      itc_net: { iamt: 0, camt: 0, samt: 0, csamt: 0 },
      itc_inelg: [
        zeroItcRow("RUL"),
        zeroItcRow("OTH")
      ]
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: 0, intra: 0 },
        { ty: "NONGST", inter: 0, intra: 0 }
      ]
    }
  };
}

// "2026-08" -> "082026" (GSTR-3B's ret_period format — same idea as
// GSTR-1's fp, different field name, same MM+YYYY digit order).
function toRetPeriod(month) {
  const [yyyy, mm] = month.split("-");
  return `${mm}${yyyy}`;
}

/* -------------------- GSTR-3B TABLE 3.1(a)/(b)/(c)/(e) --------------------
   STEP 7 of the GSTR-3B build: the outward-supply rows of sup_details that
   come straight from sales invoices netted against credit notes for the
   period — (a) ordinary taxable, (b) zero-rated (exports/SEZ under LUT),
   (c) exempt + nil-rated. Unlike GSTR-1's b2b/b2cs/cdnr tables, the portal
   wants ONE row per sub-table here — a single period total, not one per
   invoice or buyer — so this is much simpler: fetch the same shape of
   source-document arrays buildGstr1 does, and hand them to
   netOutwardSuppliesByCategory (Step 6) instead of re-deriving the netting
   logic here.

   STEP 8: (e) osup_nongst — "Non-GST outward supplies" (alcohol,
   petroleum, and the handful of other goods that sit outside GST
   entirely). KNOWN GAP: this system has no non-GST-supply classification
   anywhere — item_master/sales_invoice_items only ever carry a GST rate
   and a supply_type (TAXABLE/EXEMPT/NIL_RATED/ZERO_RATED), none of which
   means "outside GST law altogether". Guessing which historical lines
   might have been non-GST supplies would be worse than reporting the
   honest answer, so this is always hardcoded to 0 rather than aggregated.
   If the business does sell non-GST goods, this row needs filling in by
   hand in the offline tool before filing.

   Not built here:
     3.1(d) isup_rev — inward, not outward; comes from
                       computeRCMLiability (Step 9). */
function computeGstr3bTable31(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    dbAll(
      `SELECT si.id, si.igst
       FROM sales_invoice si
       WHERE strftime('%Y-%m', si.date) = ?`,
      [month]
    ),
    dbAll(
      `SELECT sii.invoice_id, sii.taxable, sii.gst_amount, sii.supply_type
       FROM sales_invoice_items sii
       JOIN sales_invoice si ON si.id = sii.invoice_id
       WHERE strftime('%Y-%m', si.date) = ?`,
      [month]
    ),
    dbAll(
      `SELECT cn.id, cn.igst
       FROM credit_note cn
       WHERE strftime('%Y-%m', cn.date) = ?`,
      [month]
    ),
    dbAll(
      `SELECT cni.note_id, cni.taxable, cni.gst_amount, cni.supply_type
       FROM credit_note_items cni
       JOIN credit_note cn ON cn.id = cni.note_id
       WHERE strftime('%Y-%m', cn.date) = ?`,
      [month]
    )
  ]).then(([salesHeaders, salesItems, creditHeaders, creditItems]) => {
    const totals = netOutwardSuppliesByCategory(salesHeaders, salesItems, creditHeaders, creditItems);

    // Shapes each category's net totals into the {txval, iamt, camt,
    // samt, csamt} quad emptyGstr3bShape (Step 1) already defined for
    // every sup_details row, so this can be assigned straight into
    // sup_details.osup_det / osup_zero / osup_nil_exmp without any
    // reshaping at the call site (buildGstr3b, Step 17).
    const toQuad = (t) => ({
      txval: round2(t.taxable),
      iamt: round2(t.igst),
      camt: round2(t.cgst),
      samt: round2(t.sgst),
      csamt: 0
    });

    return {
      osup_det: toQuad(totals.taxable),        // 3.1(a)
      osup_zero: toQuad(totals.zero_rated),     // 3.1(b)
      osup_nil_exmp: toQuad(totals.exempt_nil), // 3.1(c)
      // 3.1(e) — KNOWN GAP, see comment above. Always {txval:0, ...}, never
      // derived from any aggregation, so there's no risk of it silently
      // picking up a wrong number later.
      osup_nongst: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
    };
  });
}

/* -------------------- GSTR-3B TABLE 3.1(d) — RCM LIABILITY --------------------
   STEP 9 of the GSTR-3B build. Table 3.1(d) is GST WE self-assess and owe
   on reverse-charge (Sec 9(3)/9(4)) inward supplies — purchase_invoice_items
   flagged rcm_applicable=1 (Step 3), netted against any Purchase Debit
   Notes issued this period against those same RCM lines (a return/rate
   correction on an RCM purchase reduces the RCM liability, the same way a
   credit note reduces outward tax in Table 3.1(a)-(c)).

   Unlike Table 3.1(a)-(c) (built off each document's own already-computed
   header igst split — see netOutwardSuppliesByCategory, Step 6), this
   can't reuse a document's header cgst/sgst/igst: a single invoice can mix
   RCM and non-RCM lines, and purchase_invoice.cgst/sgst/igst is a TOTAL
   across every line on it, not just the RCM-flagged ones. So the
   inter/intra split here is derived independently, per RCM line, from the
   SUPPLIER's own GSTIN via getGstStateFromGstin — same rule /purchase/save
   itself uses to classify a whole document — falling back to that
   document's own recorded igst>0 only when the supplier has no GSTIN on
   file to derive a state from (e.g. an unregistered supplier, or a
   free-typed supplier name with no linked supplier record).

   KNOWN GAP: debit_note_items has no rcm_applicable of its own (only
   purchase_invoice_items does, Step 3) and a debit note doesn't have to be
   linked to a purchase invoice at all (purchase_invoice_id is nullable on
   debit_note, for standalone debit notes — see its schema comment). So
   only debit note lines that DO reference a specific invoice_item_id whose
   original purchase_invoice_item was itself rcm_applicable=1 can be
   identified as reducing RCM liability here; a standalone debit note
   issued against an RCM purchase with no such link can't be traced back
   and isn't netted. */
// Shared by computeRCMLiability (Step 9) and computeEligibleITC (Step 10):
// both need to split a purchase_invoice_items line's tax into inter-state
// (IGST) vs intra-state (CGST+SGST) without being able to trust the
// parent invoice's header split, because a single invoice can mix RCM and
// non-RCM lines, or lines destined for different Table 4(A) rows — and
// purchase_invoice.cgst/sgst/igst is a document TOTAL, not per-line. So
// the split is derived from the SUPPLIER's own GSTIN via
// getGstStateFromGstin, same rule /purchase/save itself uses to classify
// a whole document, falling back to that document's own recorded
// igst > 0 only when the supplier has no GSTIN on file to derive a state
// from (e.g. an unregistered supplier, or a free-typed supplier name with
// no linked supplier record).
function deriveIsInterState(companyState, supplierGstin, docIgst) {
  const supplierState = getGstStateFromGstin(supplierGstin);
  return (companyState && supplierState)
    ? companyState.code !== supplierState.code
    : Number(docIgst) > 0;
}

function computeRCMLiability(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    getSetting("company_gstin", ""),
    // RCM-flagged purchase lines billed this month, with enough of the
    // parent invoice + supplier to derive inter/intra state below.
    dbAll(
      `SELECT pii.taxable, pii.gst_amount, pi.igst AS doc_igst, s.gstin AS supplier_gstin
       FROM purchase_invoice_items pii
       JOIN purchase_invoice pi ON pi.id = pii.invoice_id
       LEFT JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.rcm_applicable = 1
         AND strftime('%Y-%m', pi.date) = ?`,
      [month]
    ),
    // Debit notes issued THIS month against a line that was itself
    // rcm_applicable=1 on the original purchase invoice — see the KNOWN
    // GAP note above for why standalone (unlinked) debit notes can't be
    // included here.
    dbAll(
      `SELECT dni.taxable, dni.gst_amount, dn.igst AS doc_igst, s.gstin AS supplier_gstin
       FROM debit_note_items dni
       JOIN debit_note dn ON dn.id = dni.note_id
       JOIN purchase_invoice_items pii ON pii.id = dni.invoice_item_id
       LEFT JOIN suppliers s ON s.id = dn.supplier_id
       WHERE pii.rcm_applicable = 1
         AND strftime('%Y-%m', dn.date) = ?`,
      [month]
    )
  ]).then(([rawGstin, rcmPurchaseLines, rcmDebitLines]) => {
    const companyGstin = normalizeGstin(rawGstin);
    const companyState = getGstStateFromGstin(companyGstin);

    const totals = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };

    const netLines = (rows, sign) => {
      rows.forEach(r => {
        const isInterState = deriveIsInterState(companyState, r.supplier_gstin, r.doc_igst);

        const taxableAmt = sign * (Number(r.taxable) || 0);
        const gstAmt = sign * (Number(r.gst_amount) || 0);

        totals.taxable += taxableAmt;
        if (isInterState) {
          totals.igst += gstAmt;
        } else {
          totals.cgst += gstAmt / 2;
          totals.sgst += gstAmt / 2;
        }
      });
    };

    netLines(rcmPurchaseLines, 1);
    netLines(rcmDebitLines, -1);

    // Table 3.1(d) shape — same {txval, iamt, camt, samt, csamt} quad as
    // (a)/(b)/(c)/(e) above, ready to assign straight into
    // sup_details.isup_rev (buildGstr3b, Step 17). Step 11 also feeds this
    // same total into Table 4(A) row 3 (ISRC) — self-assessed RCM tax is
    // simultaneously a 3.1(d) liability and a same-period ITC claim.
    return {
      txval: round2(totals.taxable),
      iamt: round2(totals.igst),
      camt: round2(totals.cgst),
      samt: round2(totals.sgst),
      csamt: 0
    };
  });
}

/* -------------------- GSTR-3B TABLE 4(A) ROWS 1/2/4/5 — ELIGIBLE ITC --------------------
   STEP 10 of the GSTR-3B build. Table 4(A) "ITC Available" has five rows;
   this builds four of them — row 3 (ISRC, reverse-charge ITC) is
   deliberately left out here and instead fed straight from
   computeRCMLiability's total (Step 11), since that's simultaneously a
   3.1(d) liability AND a 4(A)(3) claim on the exact same lines. Filtering
   this function to rcm_applicable = 0 purchase lines only guarantees a
   line's tax can never land in both row 3 and one of the rows built here.

   Rows are grouped straight off itc_category (Step 2):
     IMPORT_GOODS    -> row 1 (IMPG) Import of goods
     IMPORT_SERVICES -> row 2 (IMPS) Import of services
     ISD              -> row 4 (ISD)  Input Service Distributor credit
     OTHER            -> row 5 (OTH)  All other ITC — the default, i.e.
                          ordinary domestic forward-charge purchases.

   itc_category = 'RCM' is NOT one of the four buckets grouped into here —
   that value only means anything in combination with rcm_applicable = 1
   (see the itc_category/rcm_applicable schema comments above), and any
   line actually flagged that way is already excluded by the
   rcm_applicable = 0 filter before grouping starts. The only way an
   itc_category of 'RCM' can still reach this function is the inconsistent
   case of a line tagged itc_category='RCM' but never flagged
   rcm_applicable=1 — computeRCMLiability won't pick that line up either,
   since it only looks at the flag, not the category. Rather than silently
   dropping that line's ITC because it doesn't match any of the four
   labelled buckets, it's folded into row 5 (OTH) below: it's still an
   eligible forward-charge credit as far as this system can tell, just
   mis-tagged.

   Same per-line inter/intra problem as computeRCMLiability (Step 9):
   purchase_invoice_items has no cgst/sgst/igst split of its own (only a
   combined gst_amount), and a single invoice can mix rows/categories, so
   the split can't be read off the invoice header either — each line's
   split is derived independently via the shared deriveIsInterState
   helper above.

   ALSO filtered to itc_eligible = 'ELIGIBLE' (added alongside Step 12):
   this function's whole job is "Eligible ITC" — a blocked-credit line
   (INELIGIBLE_17_5 / INELIGIBLE_OTHER) belongs in Table 4(D), built by
   computeIneligibleITC (Step 12) below, not here. Without this filter a
   blocked line's tax would silently double up: once as "available" ITC in
   this function's 4(A) rows, and again as "ineligible" in 4(D) — the two
   tables are meant to partition every non-RCM line exactly once between
   them, and the itc_eligible value is what does the partitioning.

   NOT netted against Purchase Debit Notes here: unlike computeRCMLiability
   (where only rcm_applicable=1 lines matter and a debit note against one
   is comparatively rare), debit notes against ordinary forward-charge
   purchases are common, but debit_note_items carries no itc_category or
   itc_eligible of its own — only a nullable invoice_item_id back to the
   original line (same KNOWN GAP as Step 9). Reducing ITC by an
   unclassified amount would risk silently miscategorising the reduction
   into the wrong Table 4(A) row. Left as a KNOWN GAP: eligible ITC here is
   gross of purchase debit notes, so a return/rate-correction against a
   claimed purchase needs reducing manually in the offline tool before
   filing. */
function computeEligibleITC(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    getSetting("company_gstin", ""),
    dbAll(
      `SELECT pii.itc_category, pii.taxable, pii.gst_amount,
              pi.igst AS doc_igst, s.gstin AS supplier_gstin
       FROM purchase_invoice_items pii
       JOIN purchase_invoice pi ON pi.id = pii.invoice_id
       LEFT JOIN suppliers s ON s.id = pi.supplier_id
       WHERE (pii.rcm_applicable IS NULL OR pii.rcm_applicable = 0)
         AND (pii.itc_eligible IS NULL OR pii.itc_eligible = 'ELIGIBLE')
         AND strftime('%Y-%m', pi.date) = ?`,
      [month]
    )
  ]).then(([rawGstin, rows]) => {
    const companyGstin = normalizeGstin(rawGstin);
    const companyState = getGstStateFromGstin(companyGstin);

    // itc_category value -> itc_avl row code. Anything not listed here
    // (OTHER, and the mis-tagged RCM-but-not-rcm_applicable case above)
    // falls through to OTH, same as the default already used at save time.
    const ROW_FOR_CATEGORY = {
      IMPORT_GOODS: "IMPG",
      IMPORT_SERVICES: "IMPS",
      ISD: "ISD"
    };

    const zero = () => ({ iamt: 0, camt: 0, samt: 0, csamt: 0 });
    const totals = { IMPG: zero(), IMPS: zero(), ISD: zero(), OTH: zero() };

    rows.forEach(r => {
      const bucket = ROW_FOR_CATEGORY[r.itc_category] || "OTH";
      const isInterState = deriveIsInterState(companyState, r.supplier_gstin, r.doc_igst);
      const gstAmt = Number(r.gst_amount) || 0;

      if (isInterState) {
        totals[bucket].iamt += gstAmt;
      } else {
        totals[bucket].camt += gstAmt / 2;
        totals[bucket].samt += gstAmt / 2;
      }
    });

    // Returned keyed by row code, not as the final itc_avl array — row 3
    // (ISRC) isn't built here at all (see the big comment above), so this
    // object is deliberately incomplete until buildItcAvl (Step 11, right
    // below) merges in computeRCMLiability's total.
    const toRow = (ty, t) => ({ ty, iamt: round2(t.iamt), camt: round2(t.camt), samt: round2(t.samt), csamt: 0 });
    return {
      IMPG: toRow("IMPG", totals.IMPG),
      IMPS: toRow("IMPS", totals.IMPS),
      ISD: toRow("ISD", totals.ISD),
      OTH: toRow("OTH", totals.OTH)
    };
  });
}

/* -------------------- GSTR-3B TABLE 4(A) — FULL itc_avl (ADD ROW 3/ISRC) --------------------
   STEP 11 of the GSTR-3B build. computeRCMLiability's (Step 9) total is
   used TWICE in the final return, for two legally distinct things that
   happen to be the exact same number:
     - as sup_details.isup_rev, Table 3.1(d) — the RCM tax WE OWE as a
       liability on inward supplies, self-assessed this period; and
     - as itc_avl row 3 (ISRC) here, Table 4(A)(3) — the ITC we get to
       CLAIM on that same self-assessed tax, in the same period, per
       Sec 16(2)(d)/Rule 36(1)(b) (RCM tax paid is immediately eligible
       input credit, no separate invoice needed).
   Both entries always move together — there is no path in this build
   where isup_rev and itc_avl[ISRC] can end up as different figures — so
   rather than have buildGstr3b (Step 17) call computeRCMLiability(month)
   a second time (extra DB round-trip for a value it already has), this
   function takes the ALREADY-COMPUTED results of Step 9 and Step 10 and
   just assembles them into the portal's real 5-row itc_avl array, in the
   fixed row order the GSTR-3B JSON shape (Step 1) documents: IMPG, IMPS,
   ISRC, ISD, OTH.

   rcmQuad is computeRCMLiability's return shape ({txval, iamt, camt,
   samt, csamt} — see Step 9); txval isn't part of an itc_avl row (see
   emptyGstr3bShape's zeroItcRow, Step 1) so it's dropped here, only
   iamt/camt/samt/csamt carry over. eligibleItc is computeEligibleITC's
   (Step 10) return shape ({IMPG, IMPS, ISD, OTH}, each already a full
   {ty, iamt, camt, samt, csamt} row). */
function buildItcAvl(eligibleItc, rcmQuad) {
  return [
    eligibleItc.IMPG,
    eligibleItc.IMPS,
    { ty: "ISRC", iamt: rcmQuad.iamt, camt: rcmQuad.camt, samt: rcmQuad.samt, csamt: rcmQuad.csamt },
    eligibleItc.ISD,
    eligibleItc.OTH
  ];
}

/* -------------------- GSTR-3B TABLE 4(D) — INELIGIBLE ITC --------------------
   STEP 12 of the GSTR-3B build. Table 4(D) is disclosure of ITC that
   exists on a purchase but can't be claimed — the itc_eligible flag
   (Step 3) is exactly this: 'INELIGIBLE_17_5' (blocked credit under
   Sec 17(5) — motor vehicles, food & beverages, club memberships, etc.)
   -> row 1 (RUL), 'INELIGIBLE_OTHER' (any other reason ITC isn't being
   claimed) -> row 2 (OTH). Lines left at the 'ELIGIBLE' default aren't
   summed here at all — they're exactly the ones computeEligibleITC
   (Step 10) already counted, and the two functions are meant to
   partition every purchase line's ITC status between them without
   overlap (see the filter comment added to computeEligibleITC above).

   Unlike computeEligibleITC, this is NOT filtered to rcm_applicable = 0.
   The task description (Step 12) says "sum lines where itc_eligible
   starts with INELIGIBLE" with no RCM carve-out, and that's the right
   call: whether a blocked credit arose from a normal purchase or a
   reverse-charge one, it's still blocked, and Table 4(D) should disclose
   it either way.

   KNOWN GAP (flagging for review, not fixed here — out of this step's
   scope): computeRCMLiability (Step 9) sums EVERY rcm_applicable = 1
   line into Table 3.1(d) and, via buildItcAvl (Step 11), straight into
   4(A)(3) ISRC as claimed ITC — it does not look at itc_eligible at all.
   So an RCM purchase that's also flagged itc_eligible='INELIGIBLE_17_5'
   (e.g. RCM on a blocked motor-vehicle service) will correctly show up
   in 3.1(d) (the liability is owed regardless of eligibility) AND
   correctly show up in 4(D) here (disclosing it's blocked), but will
   ALSO still be counted in 4(A)(3)/ISRC as if it were claimable ITC —
   overstating 4(A) and, downstream, 4(C) Net ITC Available (Step 14) by
   that amount. This system doesn't currently net ineligible RCM lines
   out of the ISRC total; anyone with blocked-credit RCM purchases needs
   to manually reduce ISRC (and Net ITC) by their tax before filing.

   Same per-line inter/intra + no-debit-note-netting caveats as
   computeEligibleITC apply here too — see that function's comment for
   why, reused via the shared deriveIsInterState helper (Step 9). */
function computeIneligibleITC(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    getSetting("company_gstin", ""),
    dbAll(
      `SELECT pii.itc_eligible, pii.taxable, pii.gst_amount,
              pi.igst AS doc_igst, s.gstin AS supplier_gstin
       FROM purchase_invoice_items pii
       JOIN purchase_invoice pi ON pi.id = pii.invoice_id
       LEFT JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.itc_eligible IN ('INELIGIBLE_17_5', 'INELIGIBLE_OTHER')
         AND strftime('%Y-%m', pi.date) = ?`,
      [month]
    )
  ]).then(([rawGstin, rows]) => {
    const companyGstin = normalizeGstin(rawGstin);
    const companyState = getGstStateFromGstin(companyGstin);

    const zero = () => ({ iamt: 0, camt: 0, samt: 0, csamt: 0 });
    const totals = { RUL: zero(), OTH: zero() };

    rows.forEach(r => {
      const bucket = r.itc_eligible === "INELIGIBLE_17_5" ? "RUL" : "OTH";
      const isInterState = deriveIsInterState(companyState, r.supplier_gstin, r.doc_igst);
      const gstAmt = Number(r.gst_amount) || 0;

      if (isInterState) {
        totals[bucket].iamt += gstAmt;
      } else {
        totals[bucket].camt += gstAmt / 2;
        totals[bucket].samt += gstAmt / 2;
      }
    });

    // Portal row order for itc_inelg is RUL then OTH (see emptyGstr3bShape,
    // Step 1) — returned as the final array directly, unlike
    // computeEligibleITC's keyed object, since there's no row-3-style
    // insertion needed here.
    const toRow = (ty, t) => ({ ty, iamt: round2(t.iamt), camt: round2(t.camt), samt: round2(t.samt), csamt: 0 });
    return [
      toRow("RUL", totals.RUL),
      toRow("OTH", totals.OTH)
    ];
  });
}

/* -------------------- GSTR-3B TABLE 4(B) — ITC REVERSED --------------------
   STEP 13 of the GSTR-3B build. Table 4(B) is ITC that was otherwise
   available but has to be reversed — row 1 (RUL) is the Rule 42/43
   proportional reversal (input tax attributable to exempt/nil-rated
   outward supplies, computed off a formula involving total turnover,
   exempt turnover, and common-credit ITC across the period), row 2 (OTH)
   is any other reversal (e.g. non-payment to supplier within 180 days
   under Rule 37, capital goods sold, etc.).

   Both are KNOWN GAPS, always hardcoded to 0 — this system has no
   turnover-ratio ITC-apportionment logic, no ageing/payment-tracking on
   purchase invoices to detect a Rule 37 180-day lapse, and no fixed-asset
   register to detect a capital-goods disposal. Guessing any of these
   would be far worse than reporting an honest 0 and flagging the
   business's attention to it — same "KNOWN GAP" convention as Table
   3.1(e) (Step 8).

   Unlike Table 3.1(e) though, silently reporting 0 here is genuinely
   risky rather than just incomplete: whenever a period has ANY
   exempt/nil-rated outward turnover, Rule 42/43 reversal is *usually*
   legally required (the taxpayer made purchases that generated common
   ITC used partly for exempt supplies, and that portion has to be
   reversed) — reporting 4(B) as 0 in that situation isn't neutral, it's
   very likely wrong. So this doesn't just hardcode silently: it takes the
   SAME period's Table 3.1(c) total (osup_nil_exmp, from
   computeGstr3bTable31, Step 7 — passed in already-computed rather than
   re-queried, same reasoning as buildItcAvl, Step 11) and raises a
   warning whenever that turnover is non-zero, so the 0 doesn't slip
   through unnoticed the way an always-silent hardcode would. */
function buildItcReversal(exemptNilQuad) {
  const itc_rev = [
    { ty: "RUL", iamt: 0, camt: 0, samt: 0, csamt: 0 },
    { ty: "OTH", iamt: 0, camt: 0, samt: 0, csamt: 0 }
  ];

  const warnings = [];
  const exemptNilTurnover = exemptNilQuad ? Number(exemptNilQuad.txval) || 0 : 0;
  if (Math.abs(exemptNilTurnover) > 0.005) {
    warnings.push({
      type: "itc_reversal_not_computed",
      message: `This period's exempt/nil-rated outward turnover is ₹${round2(exemptNilTurnover)} (Table 3.1(c)) — Table 4(B) "ITC Reversed" is reported as 0 here, but Rule 42/43 proportional ITC reversal is usually legally required whenever exempt/nil-rated turnover exists. This system can't compute the reversal ratio; calculate it and enter it manually in the offline tool before filing.`
    });
  }

  return { itc_rev, warnings };
}

/* -------------------- GSTR-3B TABLE 4(C) — NET ITC AVAILABLE --------------------
   STEP 14 of the GSTR-3B build. Table 4(C) is a single {iamt, camt, samt,
   csamt} object (see emptyGstr3bShape.itc_elg.itc_net, Step 1) equal to
   4(A) Total ITC Available minus 4(B) Total ITC Reversed — i.e. the sum
   of every itc_avl row (Step 11's 5-row array) minus the sum of every
   itc_rev row (Step 13's 2-row array, always 0 today but summed for real
   in case that ever changes).

   The instruction to round "once at the end, not per intermediate row"
   matters even though every itc_avl/itc_rev row was already round2()'d
   when it was built (Steps 10-13): those per-row roundings are correct
   and stay as-is (they're the exact rupee figures the portal will show
   for each row), but ADDING seven already-rounded floats back together
   in JS floating point can still land on something like
   1234.5600000000002 instead of a clean 1234.56 — round2()ing after
   EVERY individual addition would just repeat that same tiny
   floating-point error seven times over instead of once. So this
   accumulates all seven rows' raw (unrounded-again) sums first in plain
   JS arithmetic, and calls round2() exactly once per field, on the final
   totals only — matching the "avoids cent drift the portal validator can
   reject" reasoning in the build plan. */
function computeItcNet(itc_avl, itc_rev) {
  const sumField = (rows, field) =>
    rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

  const netField = (field) =>
    sumField(itc_avl, field) - sumField(itc_rev, field);

  return {
    iamt: round2(netField("iamt")),
    camt: round2(netField("camt")),
    samt: round2(netField("samt")),
    csamt: round2(netField("csamt"))
  };
}

/* -------------------- GSTR-3B TABLE 5 — EXEMPT/NIL/NON-GST INWARD SUPPLIES --------------------
   STEP 15 of the GSTR-3B build. Table 5 (inward_sup.isup_details, see
   emptyGstr3bShape, Step 1) asks for two rows split inter/intra-state:
     ty "GST"     value of inward supplies from composition dealers, plus
                  exempt and nil-rated purchases
     ty "NONGST"  value of non-GST inward supplies (alcohol, petroleum,
                  etc. bought in)
   This is purely informational (doesn't feed 3.1 or Table 4 anywhere)
   but the portal still expects real figures.

   Always hardcoded to 0/0 for both rows — and unlike Table 3.1(e)'s
   quieter hardcode (Step 8, a genuinely rare case for most businesses)
   this one is flagged every single time, unconditionally, because the
   gap is structural rather than occasional: item_master.supply_type
   (and purchase_invoice_items, which doesn't even have its own
   supply_type column) only ever governs how an item is priced when SOLD
   — TAXABLE/EXEMPT/NIL_RATED/ZERO_RATED is a sales-side concept in this
   system's schema. There is no equivalent classification anywhere for
   what a purchase itself is (an exempt purchase from a composition
   dealer looks, in this database, identical to any other purchase row).
   Guessing from the supplier's registration status or the item's own
   sales-side supply_type would be wrong often enough to be worse than
   useless, so this is always reported as 0 with a standing warning
   rather than any attempted inference — same "flag rather than guess"
   instruction as the build plan itself uses for this table. */
function buildInwardSupplies() {
  const inward_sup = {
    isup_details: [
      { ty: "GST", inter: 0, intra: 0 },
      { ty: "NONGST", inter: 0, intra: 0 }
    ]
  };

  const warnings = [{
    type: "inward_exempt_nongst_not_tracked",
    message: "Table 5 (exempt/nil-rated/non-GST inward supplies) is always reported as 0 here — this system has no purchase-side supply classification (item_master.supply_type only governs sale pricing). If you bought from a composition dealer, or bought exempt/nil-rated/non-GST goods this period, fill in Table 5 manually in the offline tool before filing."
  }];

  return { inward_sup, warnings };
}

/* -------------------- GSTR-3B TABLE 5.1 / 6.1 — DELIBERATELY OUT OF SCOPE --------------------
   STEP 16 of the GSTR-3B build. Table 5.1 (Interest & Late Fee Payable)
   and Table 6.1 (Payment of Tax — cash ledger + credit ledger utilisation
   per head) are NOT built at all, in any form — no function, no zeroed
   placeholder, no key in the JSON shape (see emptyGstr3bShape, Step 1,
   whose "Deliberately NOT part of the locked shape" note already flagged
   this exact gap when the shape was first locked; this step exists to
   make that decision explicit and load-bearing rather than an unexplained
   silence someone finds later).

   Both need a GST-payment ledger — this system has confirmed NONE:
   no cash_ledger table, no credit_ledger table, nothing tracking
   electronic cash/credit balances or interest accrual anywhere in the
   schema. There's no partial data to approximate from here, unlike
   Table 3.1(e) or Table 5 above (which at least have adjacent-but-wrong
   sales-side data someone might be tempted to misuse) — this is a
   complete absence, not a classification gap.

   Also, unlike every other omission in this build, these two tables
   aren't normally filled in from source records before upload anyway:
   5.1/6.1 are where the taxpayer tells the portal HOW to settle the
   liability this return already calculated (which ledger, how much cash,
   how much credit, any interest) — that happens ON the GST portal itself,
   informed by the portal's own live cash/credit ledger balances, AFTER
   this JSON is uploaded. A locally-computed guess at 6.1 would be stale
   the moment it was generated and could actively mislead a filer into
   thinking payment is already decided when it isn't.

   No zeroed placeholder function is provided for these two tables
   because there's nothing later in the build (buildGstr3b, Step 17) that
   needs to call one — they're absent from emptyGstr3bShape by design, so
   there's no key to fill even if one existed. buildOutOfScopeNotice()
   below exists purely so this decision surfaces as an explicit,
   low-priority note in the same warnings list Step 17 assembles, instead
   of the omission only being discoverable by reading source code. */
function buildOutOfScopeNotice() {
  return [{
    type: "tables_5_1_6_1_out_of_scope",
    message: "Table 5.1 (Interest & Late Fee Payable) and Table 6.1 (Payment of Tax) are not included in this export — this system has no GST cash/credit ledger to compute them from. These are normally filled in on the GST portal itself after upload anyway, using the portal's live ledger balances, so this isn't something to fix locally before filing."
  }];
}

/* -------------------- GSTR-3B ASSEMBLY --------------------
   STEP 17 of the GSTR-3B build. Wires the four independent table-builder
   functions above — computeGstr3bTable31 (Steps 6/7/8), computeRCMLiability
   (Step 9), computeEligibleITC (Step 10), computeIneligibleITC (Step 12) —
   into the single emptyGstr3bShape (Step 1) skeleton, the same way
   buildGstr1 assembles b2b/b2cs/cdnr/hsn into its own shape:

     1. Fetch company_gstin AND run all four table-builders in one
        Promise.all (each already owns its own source-document queries,
        so there's nothing left to fetch out here except the GSTIN and a
        cheap document-count check for the "blank month" guard below).
     2. Validate the GSTIN exactly like buildGstr1 does — GSTR-3B needs a
        real filer GSTIN just as much as GSTR-1 does.
     3. Reuse buildGstr1's "throw a clear error instead of shipping a
        blank file" guard: if the month has literally no sales invoices,
        credit notes, OR purchase invoices, don't hand back a
        technically-valid-but-empty gstr3b object — tell the user which
        months DO have data, same message shape as buildGstr1's version
        (extended here to also check purchase_invoice, since GSTR-3B's
        ITC tables depend on purchase data GSTR-1 never needed).
     4. Copy each table-builder's already-computed output into the locked
        shape's keys, using buildItcAvl (Step 11), buildItcReversal
        (Step 13), computeItcNet (Step 14), buildInwardSupplies (Step 15)
        and buildOutOfScopeNotice (Step 16) exactly as those steps left
        them — no new aggregation happens in this function, it only wires
        together what Steps 6-16 already built.

   rcmQuad (computeRCMLiability's result) is used TWICE here — once as
   sup_details.isup_rev (3.1(d), the full {txval,iamt,camt,samt,csamt}
   quad) and once inside buildItcAvl (4(A) row 3/ISRC, iamt/camt/samt/
   csamt only) — see Step 11's comment for why that's correct and not a
   double-count of two different things that happen to share a number.

   inter_sup (Table 3.2) is NOT filled in here: it isn't produced by any
   of Steps 1-16, so it's left exactly as emptyGstr3bShape (Step 1)
   defines it — empty unreg_details/comp_details/uin_details arrays. That
   silence would be easy to miss later, so — matching the "flag rather
   than guess" convention this file already uses for Table 3.1(e) (Step
   8) and Table 5 (Step 15) — a warning is added below to surface it
   explicitly instead of leaving it a silent gap. */
function buildGstr3b(month) {
  const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all([
    getSetting("company_gstin", ""),
    computeGstr3bTable31(month), // Steps 6/7/8 -> sup_details (a)/(b)/(c)/(e)
    computeRCMLiability(month),  // Step 9      -> sup_details (d) + itc_avl row 3
    computeEligibleITC(month),   // Step 10     -> itc_avl rows 1/2/4/5
    computeIneligibleITC(month), // Step 12     -> itc_inelg rows 1/2
    // Cheap existence check for the "blank month" guard (step 3 below) —
    // deliberately NOT reusing the totals from the four calls above,
    // since an all-taxable-lines-zeroed-out-by-credit-notes month should
    // still export (real, if empty-looking, figures), whereas a month
    // with no source documents at all shouldn't export a hollow shell.
    dbAll(
      `SELECT
         (SELECT COUNT(*) FROM sales_invoice WHERE strftime('%Y-%m', date) = ?) AS sales,
         (SELECT COUNT(*) FROM credit_note WHERE strftime('%Y-%m', date) = ?) AS credits,
         (SELECT COUNT(*) FROM purchase_invoice WHERE strftime('%Y-%m', date) = ?) AS purchases`,
      [month, month, month]
    )
  ]).then(async ([rawGstin, table31, rcmQuad, eligibleItc, ineligibleItc, docCountRows]) => {
    const companyGstin = normalizeGstin(rawGstin);
    if (!isValidGstin(companyGstin)) {
      const err = new Error("Set a valid Company GSTIN in Settings before exporting GSTR-3B — it's required as the filer GSTIN on the return.");
      err.statusCode = 400;
      throw err;
    }

    // Same "don't ship a blank file" guard as buildGstr1, extended to
    // also check purchase_invoice (GSTR-1 never needed purchase data;
    // GSTR-3B's ITC tables are entirely built from it).
    const counts = docCountRows[0] || { sales: 0, credits: 0, purchases: 0 };
    if (!counts.sales && !counts.credits && !counts.purchases) {
      const monthsWithData = await dbAll(
        `SELECT DISTINCT m FROM (
           SELECT strftime('%Y-%m', date) AS m FROM sales_invoice WHERE date IS NOT NULL
           UNION
           SELECT strftime('%Y-%m', date) AS m FROM credit_note WHERE date IS NOT NULL
           UNION
           SELECT strftime('%Y-%m', date) AS m FROM purchase_invoice WHERE date IS NOT NULL
         ) ORDER BY m DESC LIMIT 12`
      );
      const list = monthsWithData.map(r => r.m).filter(Boolean);
      const err = new Error(
        list.length
          ? `No sales invoices, credit notes, or purchase invoices found for ${month}. You have data for: ${list.join(", ")}. Pick one of those months instead.`
          : `No sales invoices, credit notes, or purchase invoices found for ${month} — in fact none exist anywhere yet. Create at least one invoice before exporting GSTR-3B.`
      );
      err.statusCode = 400;
      throw err;
    }

    const shape = emptyGstr3bShape(companyGstin, toRetPeriod(month));

    // Table 3.1(a)/(b)/(c)/(e) — Steps 6/7/8.
    shape.sup_details.osup_det = table31.osup_det;
    shape.sup_details.osup_zero = table31.osup_zero;
    shape.sup_details.osup_nil_exmp = table31.osup_nil_exmp;
    shape.sup_details.osup_nongst = table31.osup_nongst;
    // Table 3.1(d) — Step 9. Unlike itc_avl rows, sup_details wants the
    // FULL quad including txval, so rcmQuad is assigned here as-is.
    shape.sup_details.isup_rev = rcmQuad;

    // Table 4(A) — Steps 10/11. Rows 1/2/4/5 come from computeEligibleITC;
    // row 3 (ISRC) is the same rcmQuad just assigned to isup_rev above.
    const itc_avl = buildItcAvl(eligibleItc, rcmQuad);
    shape.itc_elg.itc_avl = itc_avl;

    // Table 4(B) — Step 13. Hardcoded 0, with a conditional warning keyed
    // off this period's own 3.1(c) total (osup_nil_exmp).
    const { itc_rev, warnings: itcRevWarnings } = buildItcReversal(table31.osup_nil_exmp);
    shape.itc_elg.itc_rev = itc_rev;

    // Table 4(C) — Step 14. Rounds once, off the real assigned arrays.
    shape.itc_elg.itc_net = computeItcNet(itc_avl, itc_rev);

    // Table 4(D) — Step 12.
    shape.itc_elg.itc_inelg = ineligibleItc;

    // Table 5 — Step 15. Always 0/0, with a standing warning.
    const { inward_sup, warnings: inwardWarnings } = buildInwardSupplies();
    shape.inward_sup = inward_sup;

    // Table 5.1 / 6.1 — Step 16. No shape keys to fill (deliberately
    // absent from emptyGstr3bShape); only a documentary warning.
    const outOfScopeWarnings = buildOutOfScopeNotice();

    // Table 3.2 (inter_sup) — not built by any of Steps 1-16 (see function
    // comment above); left at emptyGstr3bShape's empty-array default, but
    // flagged rather than left as a silent gap.
    const interSupWarnings = [{
      type: "inter_sup_not_computed",
      message: "Table 3.2 (inter-state supplies to unregistered persons / composition taxpayers / UIN holders, carved out of 3.1(a)) is not computed by this export and is left empty. If any of this period's B2C inter-state supplies, or supplies to composition/UIN taxpayers, need to appear here, fill Table 3.2 in manually in the offline tool before filing."
    }];

    const warnings = [...itcRevWarnings, ...inwardWarnings, ...outOfScopeWarnings, ...interSupWarnings];

    const itcAvlTotal = (rows, field) => round2(rows.reduce((n, r) => n + (Number(r[field]) || 0), 0));

    const summary = {
      period: shape.ret_period,
      gstin: shape.gstin,
      taxable_txval: shape.sup_details.osup_det.txval,
      zero_rated_txval: shape.sup_details.osup_zero.txval,
      exempt_nil_txval: shape.sup_details.osup_nil_exmp.txval,
      rcm_liability_txval: shape.sup_details.isup_rev.txval,
      itc_available_iamt: itcAvlTotal(itc_avl, "iamt"),
      itc_available_camt: itcAvlTotal(itc_avl, "camt"),
      itc_available_samt: itcAvlTotal(itc_avl, "samt"),
      itc_ineligible_iamt: itcAvlTotal(shape.itc_elg.itc_inelg, "iamt"),
      itc_ineligible_camt: itcAvlTotal(shape.itc_elg.itc_inelg, "camt"),
      itc_ineligible_samt: itcAvlTotal(shape.itc_elg.itc_inelg, "samt"),
      itc_net: shape.itc_elg.itc_net,
      warnings
    };

    return { summary, gstr3b: shape };
  });
}

// Preview: returns { summary, gstr3b } as JSON for the UI to render counts
// and warnings before the user downloads anything — identical pattern to
// the GSTR-1 preview endpoint above (Step 18).
app.get("/report/gstr3b-json", (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }
  buildGstr3b(month)
    .then(result => res.json(result))
    .catch(err => res.status(err.statusCode || 500).json({ error: err.message }));
});

// Download: identical payload, but as an attachment named the way the
// GSTN offline tool's own exports are named, so it can be fed straight in
// — same naming pattern as the GSTR-1 download endpoint, using gstr3b's
// own gstin/ret_period fields instead of GSTR-1's gstin/fp.
app.get("/report/gstr3b-json/download", (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }
  buildGstr3b(month)
    .then(({ gstr3b }) => {
      res.setHeader("Content-Disposition", `attachment; filename="GSTR3B_${gstr3b.gstin}_${gstr3b.ret_period}.json"`);
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(gstr3b, null, 2));
    })
    .catch(err => res.status(err.statusCode || 500).json({ error: err.message }));
});


/* -------------------- DASHBOARD SUMMARY --------------------
   GET /report/dashboard-summary?months=6 — one aggregated payload for the
   Executive Dashboard (Dashboard.html). Pulls from data that already exists
   across the Sales, Purchase, Ledger, Inventory, Work Order and Sales Order
   modules; adds nothing new to the schema. `months` (default 6, max 24)
   controls how far back the monthly sales/purchase trend goes.

   Kept as one endpoint (rather than one per widget) so the dashboard page
   loads with a single round trip; each section below is independent of the
   others and any one query failing still lets the rest of the page render
   (errors inside a section resolve to a safe empty/zero shape instead of
   rejecting the whole request). */
app.get("/report/dashboard-summary", async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);

  try {
    // ---- Monthly sales vs purchase trend (last N months, oldest first) ----
    const trendRows = await dbAllP(
      `
      SELECT strftime('%Y-%m', date) AS month, SUM(total_amount) AS total
      FROM sales_invoice
      WHERE date >= date('now', ?)
      GROUP BY month
      `,
      [`-${months} months`]
    );
    const purchaseTrendRows = await dbAllP(
      `
      SELECT strftime('%Y-%m', date) AS month, SUM(total_amount) AS total
      FROM purchase_invoice
      WHERE date >= date('now', ?)
      GROUP BY month
      `,
      [`-${months} months`]
    );
    const salesByMonth = Object.fromEntries(trendRows.map(r => [r.month, r.total || 0]));
    const purchByMonth = Object.fromEntries(purchaseTrendRows.map(r => [r.month, r.total || 0]));
    const monthKeys = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const monthlyTrend = monthKeys.map(m => ({
      month: m,
      sales: salesByMonth[m] || 0,
      purchases: purchByMonth[m] || 0
    }));

    // ---- This month / last month sales & purchase (for KPI deltas) ----
    const thisMonthKey = monthKeys[monthKeys.length - 1];
    const lastMonthKey = monthKeys.length > 1 ? monthKeys[monthKeys.length - 2] : null;

    // ---- Cash & Bank balance (sum of debit-credit across ledgers in the
    // 'Cash & Bank' group) ----
    const cashBankRow = await dbGetP(
      `
      SELECT IFNULL(SUM(le.debit),0) - IFNULL(SUM(le.credit),0) AS balance
      FROM ledger_entries le
      JOIN ledger_master lm ON lm.ledger = le.ledger
      WHERE lm.ledger_group = 'Cash & Bank'
      `
    );

    // ---- Receivables / Payables outstanding totals ----
    const receivablesRow = await dbGetP(
      `
      SELECT IFNULL(SUM(bal),0) AS total FROM (
        SELECT si.total_amount
          - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
              WHERE pa.invoice_type='SALES' AND pa.invoice_id = si.id)
          - (SELECT IFNULL(SUM(cn.total_amount),0) FROM credit_note cn
              WHERE cn.sales_invoice_id = si.id) AS bal
        FROM sales_invoice si
      ) WHERE bal > 0.005
      `
    );
    const payablesRow = await dbGetP(
      `
      SELECT IFNULL(SUM(bal),0) AS total FROM (
        SELECT pi.total_amount
          - (SELECT IFNULL(SUM(pa.allocated_amount),0) FROM payment_allocation pa
              WHERE pa.invoice_type='PURCHASE' AND pa.invoice_id = pi.id)
          - (SELECT IFNULL(SUM(dn.total_amount),0) FROM debit_note dn
              WHERE dn.purchase_invoice_id = pi.id) AS bal
        FROM purchase_invoice pi
      ) WHERE bal > 0.005
      `
    );

    // ---- GST payable (net) — Output tax collected minus Input tax credit,
    // all-time ledger balance (same "current position" convention Trial
    // Balance uses, not scoped to a single month). ----
    const outputTaxRow = await dbGetP(
      `
      SELECT IFNULL(SUM(le.credit),0) - IFNULL(SUM(le.debit),0) AS balance
      FROM ledger_entries le WHERE le.ledger IN ('Output CGST','Output SGST','Output IGST')
      `
    );
    const inputTaxRow = await dbGetP(
      `
      SELECT IFNULL(SUM(le.debit),0) - IFNULL(SUM(le.credit),0) AS balance
      FROM ledger_entries le WHERE le.ledger IN ('Input CGST','Input SGST','Input IGST')
      `
    );

    // ---- Low stock count (same qualifying rule as /report/low-stock) ----
    const lowStockRow = await dbGetP(
      `
      SELECT COUNT(*) AS c FROM (
        SELECT i.id,
          IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS balance,
          i.reorder_level
        FROM item_master i
        LEFT JOIN stock_ledger s ON s.item_id = i.id
        WHERE i.reorder_level > 0
        GROUP BY i.id
        HAVING balance <= i.reorder_level
      )
      `
    );

    // ---- Open work orders / pending sales orders ----
    const openWORow = await dbGetP(
      `SELECT COUNT(*) AS c FROM work_order WHERE status IN ('DRAFT','ISSUED')`
    );
    const pendingSORow = await dbGetP(
      `SELECT COUNT(*) AS c FROM sales_order WHERE status NOT IN ('CLOSED','CANCELLED')`
    );

    // ---- Top 5 customers by sales value (all-time) ----
    const topCustomers = await dbAllP(
      `
      SELECT customer, SUM(total_amount) AS total
      FROM sales_invoice
      WHERE customer IS NOT NULL
      GROUP BY customer
      ORDER BY total DESC
      LIMIT 5
      `
    );

    // ---- Top 5 items by sales value (all-time) ----
    const topItems = await dbAllP(
      `
      SELECT COALESCE(i.item_name, sii.description) AS item_name, SUM(sii.total) AS total
      FROM sales_invoice_items sii
      LEFT JOIN item_master i ON i.id = sii.item_id
      GROUP BY item_name
      ORDER BY total DESC
      LIMIT 5
      `
    );

    // ---- Work order status breakdown ----
    const workOrderStatus = await dbAllP(
      `SELECT status, COUNT(*) AS count FROM work_order GROUP BY status`
    );

    // ---- Stock valuation (weighted-average inbound rate x current
    // balance, per item, summed) — same weighted-average convention used
    // elsewhere in this file (SUM(qty_in*rate)/SUM(qty_in)). ----
    const stockValRow = await dbGetP(
      `
      SELECT IFNULL(SUM(bal * avg_rate), 0) AS total FROM (
        SELECT
          item_id,
          IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS bal,
          CASE WHEN SUM(qty_in) > 0 THEN SUM(qty_in * rate) / SUM(qty_in) ELSE 0 END AS avg_rate
        FROM stock_ledger
        GROUP BY item_id
      ) WHERE bal > 0
      `
    );

    res.json({
      period_months: months,
      kpis: {
        sales_this_month: salesByMonth[thisMonthKey] || 0,
        sales_last_month: lastMonthKey ? (salesByMonth[lastMonthKey] || 0) : null,
        purchase_this_month: purchByMonth[thisMonthKey] || 0,
        purchase_last_month: lastMonthKey ? (purchByMonth[lastMonthKey] || 0) : null,
        cash_bank_balance: cashBankRow?.balance || 0,
        receivables_total: receivablesRow?.total || 0,
        payables_total: payablesRow?.total || 0,
        gst_payable: (outputTaxRow?.balance || 0) - (inputTaxRow?.balance || 0),
        low_stock_count: lowStockRow?.c || 0,
        open_work_orders: openWORow?.c || 0,
        pending_sales_orders: pendingSORow?.c || 0,
        stock_valuation_total: stockValRow?.total || 0
      },
      monthly_trend: monthlyTrend,
      top_customers: topCustomers,
      top_items: topItems,
      work_order_status: workOrderStatus
    });
  } catch (err) {
    console.error("DASHBOARD SUMMARY ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- PAYROLL / HR MODULE -------------------- */

require("./payroll")(app, db, {
  saveJournalInternal,
  getSetting,
  setSetting,
  amountInWords,
  DATA_DIR
});

/* -------------------- SERVER -------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Accounting server running on port ${PORT}`);
});

app.get("/__test__", (req, res) => {
  console.log("TEST ROUTE HIT");
  res.send("SERVER OK");
});

