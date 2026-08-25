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
    description: "Fully boxed, grid-style tax invoice matching the classic Tally/e-Invoice layout, with an HSN-wise tax summary and amount-in-words. Fields our system doesn't capture yet (delivery note, dispatch details, buyer/seller GSTIN & address) are left blank."
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
function renderClassicTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal }) {
  // HEADER
  doc.fontSize(18).text("TAX INVOICE", { align: "center" }).moveDown();

  doc.fontSize(12)
    .text(`Invoice No: ${invoiceNo}`)
    .text(`Date: ${date}`)
    .moveDown();

  doc.font("Helvetica-Bold").text("Billed To:");
  doc.font("Helvetica").text(customer).moveDown();

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
    const descHeight = doc.heightOfString(item.description, { width: 240 });
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
    doc.text(item.description, 80, startY, { width: 240 });
    doc.text(item.qty, 330, startY, { width: 50, align: "right" });
    doc.text(item.rate.toFixed(2), 390, startY, { width: 70, align: "right" });
    doc.text(item.amount.toFixed(2), 470, startY, { width: 80, align: "right" });

    startY += rowHeight + 5;
  });

  doc.y = startY;

  // TOTAL
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
    doc.font("Helvetica-Bold")
       .text(`Grand Total: ₹ ${grandTotal.toFixed(2)}`, { align: "right" });
  }

  doc.moveDown(2);
  doc.fontSize(10).text("This is a system generated invoice.", { align: "center" });
}

/* ---- Template: modern (colored header band + shaded totals box) ---- */
function renderModernTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal }) {
  const accent = "#2952e3";

  // HEADER BAND
  doc.rect(0, 0, doc.page.width, 90).fill(accent);
  doc.fillColor("white").fontSize(22).font("Helvetica-Bold")
     .text("TAX INVOICE", 40, 30);
  doc.fontSize(10).font("Helvetica")
     .text(`Invoice No: ${invoiceNo}`, 40, 60)
     .text(`Date: ${date}`, 40, 74);

  doc.fillColor("black");
  doc.y = 110;

  doc.font("Helvetica-Bold").fontSize(11).text("Billed To:");
  doc.font("Helvetica").fontSize(11).text(customer).moveDown();

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
    const descHeight = doc.heightOfString(item.description, { width: 240 });
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
    doc.text(item.description, 80, startY, { width: 240 });
    doc.text(item.qty, 330, startY, { width: 50, align: "right" });
    doc.text(item.rate.toFixed(2), 390, startY, { width: 70, align: "right" });
    doc.text(item.amount.toFixed(2), 470, startY, { width: 75, align: "right" });

    startY += rowHeight + 5;
  });

  doc.y = startY + 10;

  // TOTALS BOX
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
    doc.font("Helvetica-Bold").fillColor(accent);
    doc.text(`Grand Total:`, 340, ty);
    doc.text(`₹ ${grandTotal.toFixed(2)}`, 470, ty, { width: 70, align: "right" });
  }

  doc.fillColor("black").font("Helvetica");
  doc.y = boxTop + boxHeight + 30;
  doc.fontSize(9).fillColor("#888")
     .text("This is a system generated invoice.", { align: "center" });
  doc.fillColor("black");
}

/* ---- Template: minimal (ruled lines, no boxes, compact) ---- */
function renderMinimalTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal }) {
  doc.fontSize(14).font("Helvetica-Bold").text("Tax Invoice");
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica")
     .text(`Invoice No: ${invoiceNo}    Date: ${date}`)
     .text(`Billed To: ${customer}`);

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
    const descHeight = doc.heightOfString(item.description, { width: 260 });
    const rowHeight = Math.max(descHeight, 14);

    if (startY + rowHeight > doc.page.height - 90) {
      doc.addPage();
      startY = 50;
    }

    doc.fontSize(9);
    doc.text(i + 1, 40, startY);
    doc.text(item.description, 70, startY, { width: 260 });
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
    doc.font("Helvetica-Bold")
       .text(`Grand Total: ₹ ${grandTotal.toFixed(2)}`, { align: "right" });
  }

  doc.moveDown(1.5);
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
   Fields our system doesn't currently capture (seller company profile,
   consignee/ship-to, buyer GSTIN & address, delivery note, dispatch
   details, terms of payment/delivery, discount %, IRN/e-Invoice QR) are
   rendered as blank cells rather than invented. */
function renderGstTabularTemplate(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal }) {
  const L = 40, R = 555; // left / right content edges
  const W = R - L;       // usable width (515)

  doc.font("Helvetica");

  // ---------- TITLE ----------
  doc.fontSize(16).font("Helvetica-Bold").text("Tax Invoice", L, 40, { width: W, align: "center" });

  // ---------- HEADER GRID ----------
  const headerTop = 70;
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
  // (No separate consignee/ship-to or seller company profile is stored in
  // this system, so only the buyer name we do have is shown here.)
  doc.moveTo(L, headerTop).lineTo(L + leftColW, headerTop).lineWidth(0.5).stroke();
  doc.moveTo(L, headerTop).lineTo(L, headerBottom).stroke();
  doc.moveTo(L + leftColW, headerTop).lineTo(L + leftColW, headerBottom).stroke();
  doc.moveTo(L, headerBottom).lineTo(L + leftColW, headerBottom).stroke();

  doc.font("Helvetica").fontSize(9).text("Buyer (Bill to)", L + 6, headerTop + 8);
  doc.font("Helvetica-Bold").fontSize(11).text(customer, L + 6, headerTop + 22, { width: leftColW - 12 });

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
  const hsnSummary = {}; // hsn -> { taxable, gstRate }

  items.forEach((item, i) => {
    const descHeight = doc.heightOfString(item.description || "", { width: cols[1].w - 6 });
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
      desc: item.description || "",
      hsn: item.hsn || "",
      qty: `${item.qty} ${item.unit || ""}`.trim(),
      rate: formatINR(item.rate),
      per: item.unit || "",
      disc: "",
      amount: formatINR(item.amount)
    };
    cols.forEach(c => doc.text(vals[c.key], c.x + 3, y + 5, { width: c.w - 6, align: c.align }));

    totalQty += Number(item.qty) || 0;

    const hsnKey = item.hsn || "—";
    if (!hsnSummary[hsnKey]) hsnSummary[hsnKey] = { taxable: 0, gstRate: Number(item.gst_rate) || 0 };
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
  const isInter = !!(gstBreakup && gstBreakup.igst);
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

  Object.entries(hsnSummary).forEach(([hsn, s]) => {
    const rowTax = s.taxable * (s.gstRate / 100);
    const rowH2 = 18;
    drawTaxRowBorders(y, rowH2);

    if (isInter) {
      doc.text(hsn, taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6 });
      doc.text(formatINR(s.taxable), taxCols[1].x + 3, y + 5, { width: taxCols[1].w - 6, align: "right" });
      doc.text(`${s.gstRate}%`, taxCols[2].x + 3, y + 5, { width: taxCols[2].w - 6, align: "center" });
      doc.text(formatINR(rowTax), taxCols[3].x + 3, y + 5, { width: taxCols[3].w - 6, align: "right" });
      doc.text(formatINR(rowTax), taxCols[4].x + 3, y + 5, { width: taxCols[4].w - 6, align: "right" });
    } else {
      const half = rowTax / 2;
      doc.text(hsn, taxCols[0].x + 3, y + 5, { width: taxCols[0].w - 6 });
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

  // Seller signatory block — left blank (no company profile stored yet)
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

async function generateSalesInvoicePDF({ invoiceNo, date, customer, items, amount, gstBreakup, grandTotal, template }) {
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

    renderer(doc, { invoiceNo, date, customer, items, amount, gstBreakup, grandTotal });

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
      ('Output SGST','Duties & Taxes - Output',1)
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
    ('Duties & Taxes - Output','LIABILITY')
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
      FOREIGN KEY (item_id) REFERENCES item_master(id)
    )
  `);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_template', 'classic')`
  );



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

  db.run(
    `INSERT INTO clients (name, email, phone, address, gstin, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name.trim(), email || null, phone || null, address || null, gstin || null, notes || null],
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

  db.run(
    `UPDATE clients
     SET name = ?, email = ?, phone = ?, address = ?, gstin = ?, notes = ?
     WHERE id = ?`,
    [name.trim(), email || null, phone || null, address || null, gstin || null, notes || null, req.params.id],
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

/* -------------------- SAVE SALES INVOICE -------------------- */

app.post("/sales/save", async (req, res) => {
  const { date, customer, invoiceNo, items, taxType, clientId } = req.body;

  if (!date || !customer || !invoiceNo || !items?.length) {
    return res.status(400).json({ error: "Invalid sales data" });
  }

  // "INTER" = different state (IGST). Anything else defaults to same-state (CGST+SGST).
  const isInterState = taxType === "INTER";

  const totalAmount = items.reduce((s, i) => s + i.amount, 0);
  const totalGst = items.reduce(
    (s, i) => s + i.amount * ((Number(i.gst_rate) || 0) / 100),
    0
  );
  const grandTotal = totalAmount + totalGst;

  try {
    db.run("BEGIN TRANSACTION");

    /* 🔒 FINAL STOCK CHECK */
    for (const item of items) {
      const available = await getAvailableStock(item.item_id);
      if (available < item.qty) {
        throw new Error(
          `Insufficient stock for ${item.description}. Available: ${available}`
        );
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

    /* 2️⃣ STOCK DEDUCTION */
    for (const item of items) {
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_out, rate)
          VALUES (?, ?, 'SALE', ?, ?, ?)
          `,
          [item.item_id, date, invoiceNo, item.qty, item.rate],
          err => (err ? reject(err) : resolve())
        );
      });
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
      grandTotal
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

  try {
    for (const key of keys) {
      await setSetting(key, updates[key]);
    }
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- EXPOSE INVOICES FOLDER (DOWNLOADABLE) -------------------- */

app.use(
  "/invoices",
  express.static(path.join(DATA_DIR, "invoices"))
);


/* -------------------- ITEM API (POST) -------------------- */


app.post("/item/create", (req, res) => {
  const {
    item_code,
    item_name,
    hsn,
    unit,
    gst_rate,
    selling_price,
    opening_qty,
    opening_rate
  } = req.body;

  if (!item_name || !unit || gst_rate == null) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `
      INSERT INTO item_master
      (item_code, item_name, hsn, unit, gst_rate, selling_price, opening_qty, opening_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        item_code,
        item_name,
        hsn,
        unit,
        gst_rate,
        selling_price || 0,
        opening_qty || 0,
        opening_rate || 0
      ],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const itemId = this.lastID;

        // OPENING STOCK → STOCK LEDGER
        if (opening_qty && opening_qty > 0) {
          db.run(
            `
            INSERT INTO stock_ledger
            (item_id, date, voucher_type, voucher_no, qty_in, rate)
            VALUES (?, DATE('now'), 'OPENING', 'OPENING', ?, ?)
            `,
            [itemId, opening_qty, opening_rate || 0]
          );
        }

        db.run("COMMIT");
        res.json({ status: "success", item_id: itemId });
      }
    );
  });
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
      selling_price
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

app.get("/stock/:itemId", (req, res) => {
  db.get(
    `
    SELECT
      IFNULL(SUM(qty_in),0) - IFNULL(SUM(qty_out),0) AS available
    FROM stock_ledger
    WHERE item_id = ?
    `,
    [req.params.itemId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ available: row.available });
    }
  );
});


/* -------------------- PURCHASE SAVE API -------------------- */

app.post("/purchase/save", async (req, res) => {
  const { date, supplier, invoiceNo, items, taxType } = req.body;

  if (!date || !supplier || !invoiceNo || !items?.length) {
    return res.status(400).json({ error: "Invalid purchase data" });
  }

  // "INTER" = different state (IGST). Anything else defaults to same-state (CGST+SGST).
  const isInterState = taxType === "INTER";

  try {
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

      /* 2️⃣ STOCK IN */
      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_in, rate)
          VALUES (?, ?, 'PURCHASE', ?, ?, ?)
          `,
          [itemId, date, invoiceNo, item.qty, item.rate],
          err => (err ? reject(err) : resolve())
        );
      });
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

    db.run("COMMIT");
    res.json({ status: "success" });

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
      selling_price
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

/* -------------------- ITEM WISE DETAIL REPORT -------------------- */

app.get("/report/item/:itemId", (req, res) => {
  const itemId = req.params.itemId;

  db.get(
    `
    SELECT
      i.item_name,
      i.hsn,
      i.unit,
      i.gst_rate,
      i.selling_price,
      IFNULL(SUM(s.qty_in),0) AS total_in,
      IFNULL(SUM(s.qty_out),0) AS total_out,
      IFNULL(SUM(s.qty_in),0) - IFNULL(SUM(s.qty_out),0) AS closing_stock
    FROM item_master i
    LEFT JOIN stock_ledger s ON i.id = s.item_id
    WHERE i.id = ?
    `,
    [itemId],
    (err, summary) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(
        `
        SELECT
          date,
          voucher_type,
          voucher_no,
          qty_in,
          qty_out,
          rate
        FROM stock_ledger
        WHERE item_id = ?
        ORDER BY date, id
        `,
        [itemId],
        (err, movements) => {
          if (err) return res.status(500).json({ error: err.message });

          res.json({
            summary,
            movements
          });
        }
      );
    }
  );
});

/* -------------------- GST MONTHLY SUMMARY -------------------- */

app.get("/report/gst-summary", (req, res) => {
  const month = req.query.month; // expected format: YYYY-MM

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month query param required, format YYYY-MM" });
  }

  const gstLedgers = [
    "Input IGST", "Input CGST", "Input SGST",
    "Output IGST", "Output CGST", "Output SGST"
  ];

  db.all(
    `
    SELECT
      ledger,
      SUM(debit) AS total_debit,
      SUM(credit) AS total_credit
    FROM ledger_entries
    WHERE ledger IN (${gstLedgers.map(() => "?").join(",")})
      AND strftime('%Y-%m', date) = ?
    GROUP BY ledger
    `,
    [...gstLedgers, month],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const totals = {};
      gstLedgers.forEach(l => (totals[l] = { debit: 0, credit: 0 }));
      rows.forEach(r => {
        totals[r.ledger] = { debit: r.total_debit || 0, credit: r.total_credit || 0 };
      });

      // Input GST accrues as a debit balance (asset/credit receivable)
      const inputIGST = totals["Input IGST"].debit;
      const inputCGST = totals["Input CGST"].debit;
      const inputSGST = totals["Input SGST"].debit;

      // Output GST accrues as a credit balance (liability payable)
      const outputIGST = totals["Output IGST"].credit;
      const outputCGST = totals["Output CGST"].credit;
      const outputSGST = totals["Output SGST"].credit;

      const netIGST = outputIGST - inputIGST;
      const netCGST = outputCGST - inputCGST;
      const netSGST = outputSGST - inputSGST;

      const totalInput = inputIGST + inputCGST + inputSGST;
      const totalOutput = outputIGST + outputCGST + outputSGST;
      const netPayable = totalOutput - totalInput;

      res.json({
        month,
        input: {
          igst: inputIGST,
          cgst: inputCGST,
          sgst: inputSGST,
          total: totalInput
        },
        output: {
          igst: outputIGST,
          cgst: outputCGST,
          sgst: outputSGST,
          total: totalOutput
        },
        net: {
          igst: netIGST,
          cgst: netCGST,
          sgst: netSGST,
          total: netPayable
        }
      });
    }
  );
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

