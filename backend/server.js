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
      ('Bank A/c','Cash & Bank',1)
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
    ('Cash & Bank','ASSET')
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
  const { date, customer, invoiceNo, items, taxType, clientId, so_id } = req.body;

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
          (invoice_id, item_id, description, hsn, qty, rate, taxable, gst_rate, gst_amount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [salesInvoiceId, item.item_id, item.description, item.hsn || null, item.qty, item.rate,
           item.amount, Number(item.gst_rate) || 0, itemGst, item.amount + itemGst],
          err => (err ? reject(err) : resolve())
        );
      });
    }

    /* 2️⃣ STOCK DEDUCTION — skipped when this invoice is against a Sales
       Order, because the goods already left at the Delivery Challan stage.
       Deducting again here would double-count the stock movement. */
    if (!so_id) {
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

  if (updates.whatsapp_provider && !["twilio", "meta"].includes(updates.whatsapp_provider)) {
    return res.status(400).json({ error: "whatsapp_provider must be 'twilio' or 'meta'" });
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
  const { date, supplier, invoiceNo, items, taxType, po_id } = req.body;

  if (!date || !supplier || !invoiceNo || !items?.length) {
    return res.status(400).json({ error: "Invalid purchase data" });
  }

  // "INTER" = different state (IGST). Anything else defaults to same-state (CGST+SGST).
  const isInterState = taxType === "INTER";

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
        (invoice_no, date, supplier, po_id, taxable_value, cgst, sgst, igst, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [invoiceNo, date, supplier, po_id || null, totalAmount, pCgstAmt, pSgstAmt, pIgstAmt, grandTotal],
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
          (invoice_id, item_id, item_name, qty, rate, taxable, gst_rate, gst_amount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [purchaseInvoiceId, item.item_id || null, item.item_name, item.qty, item.rate,
           lineAmount, Number(item.gst_rate) || 0, lineGst, lineAmount + lineGst],
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
  const { date, supplier, taxType, narration, items } = req.body;

  if (!date || !supplier || !items?.length) {
    return res.status(400).json({ error: "Invalid purchase order data" });
  }

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
        INSERT INTO purchase_order (po_no, date, supplier, tax_type, status, narration)
        VALUES (?, ?, ?, ?, 'OPEN', ?)
        `,
        [poNo, date, supplier, taxType || "INTRA", narration || null],
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
  const { po_id, date, items } = req.body;

  if (!po_id || !date || !items?.length) {
    return res.status(400).json({ error: "Invalid goods receipt data" });
  }

  try {
    db.run("BEGIN TRANSACTION");

    const po = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM purchase_order WHERE id = ?`, [po_id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    if (!po) throw new Error("Purchase order not found");
    if (po.status === "CANCELLED") throw new Error("Cannot receive goods against a cancelled purchase order");

    for (const line of items) {
      const qty = Number(line.qty) || 0;
      if (qty <= 0) continue;

      const poItem = await new Promise((resolve, reject) => {
        db.get(
          `SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?`,
          [line.po_item_id, po_id],
          (err, row) => (err ? reject(err) : resolve(row))
        );
      });
      if (!poItem) throw new Error("Purchase order line item not found");

      const pending = poItem.qty - poItem.received_qty;
      if (qty > pending + 1e-6) {
        throw new Error(
          `Cannot receive ${qty} of "${poItem.item_name}" — only ${pending} still pending`
        );
      }

      await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO stock_ledger
          (item_id, date, voucher_type, voucher_no, qty_in, rate)
          VALUES (?, ?, 'GRN', ?, ?, ?)
          `,
          [poItem.item_id, date, po.po_no, qty, poItem.rate],
          err => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?`,
          [qty, poItem.id],
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
  const { so_id, date, customer, narration, items } = req.body;

  if (!so_id || !date || !customer || !items?.length) {
    return res.status(400).json({ error: "Invalid delivery challan data" });
  }

  try {
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
          (item_id, date, voucher_type, voucher_no, qty_out, rate)
          VALUES (?, ?, 'DC', ?, ?, ?)
          `,
          [soItem.item_id, date, dcNo, qty, soItem.rate],
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
  const { date, supplier, purchase_invoice_id, reason, taxType, adjustsStock, items } = req.body;

  if (!date || !supplier || !items?.length) {
    return res.status(400).json({ error: "Date, supplier and at least one item are required" });
  }

  const isInterState = taxType === "INTER";
  const adjustStock = adjustsStock !== false; // default true

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
        (note_no, date, supplier, purchase_invoice_id, reason, adjusts_stock, taxable_value, cgst, sgst, igst, total_amount, narration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [noteNo, date, supplier, purchase_invoice_id || null, reason || null, adjustStock ? 1 : 0,
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
            (item_id, date, voucher_type, voucher_no, qty_out, rate)
            VALUES (?, ?, 'DEBIT NOTE', ?, ?, ?)
            `,
            [item.item_id, date, noteNo, item.qty, item.rate],
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
  const { date, customer, sales_invoice_id, reason, taxType, adjustsStock, items } = req.body;

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
          (note_id, item_id, invoice_item_id, item_name, qty, rate, taxable, gst_rate, gst_amount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [noteId, item.item_id || null, item.invoice_item_id || null, item.item_name,
           item.qty, item.rate, lineAmount, gstRate, lineGst, lineAmount + lineGst],
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
            (item_id, date, voucher_type, voucher_no, qty_in, rate)
            VALUES (?, ?, 'CREDIT NOTE', ?, ?, ?)
            `,
            [item.item_id, date, noteNo, item.qty, item.rate],
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

  Promise.all([
    sumDoc("sales_invoice"),
    sumDoc("credit_note"),
    sumDoc("purchase_invoice"),
    sumDoc("debit_note")
  ])
    .then(([sales, creditNotes, purchases, debitNotes]) => {
      // Outward: sales invoices raised this month, less credit notes
      // issued this month (regardless of which month the original invoice
      // was raised in — a return is reported in the period it happens).
      const outwardTaxable = sales.taxable_value - creditNotes.taxable_value;
      const outputIGST = sales.igst - creditNotes.igst;
      const outputCGST = sales.cgst - creditNotes.cgst;
      const outputSGST = sales.sgst - creditNotes.sgst;
      const outputTotal = outputIGST + outputCGST + outputSGST;

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
          taxable_value: sales.taxable_value,
          credit_notes_value: creditNotes.taxable_value,
          net_taxable_value: outwardTaxable,
          invoice_count: sales.count,
          credit_note_count: creditNotes.count
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







/* -------------------- SERVER -------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Accounting server running on port ${PORT}`);
});

app.get("/__test__", (req, res) => {
  console.log("TEST ROUTE HIT");
  res.send("SERVER OK");
});

