/* ============================================================
   PAYROLL & HR MANAGEMENT MODULE
   ============================================================
   Self-contained module, mounted from server.js via:
     require("./payroll")(app, db, helpers);

   Covers: Employee Master, Salary Structure, Attendance & Leave,
   Employee Loans/Advances, Payroll Run processing, Payslips (PDF),
   statutory summaries (PF/ESI/PT/TDS), and ledger integration
   through the existing double-entry journal (saveJournalInternal).

   IMPORTANT — STATUTORY CALCULATIONS ARE SIMPLIFIED ESTIMATES.
   PF/ESI/PT/TDS rules change by notification and vary by state and
   by employee circumstance (declarations, exemptions, regime choice).
   Every computed statutory figure is editable before a run is
   processed. Treat the numbers this module produces as a starting
   point for your accountant/CA to review, not as filed figures.
   ============================================================ */

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

module.exports = function registerPayroll(app, db, helpers) {
  const { saveJournalInternal, getSetting, setSetting, amountInWords, DATA_DIR } = helpers;

  /* -------------------- SCHEMA -------------------- */

  db.serialize(() => {
    db.run(`
      INSERT OR IGNORE INTO ledger_master (ledger, ledger_group, is_system) VALUES
      ('Salary & Wages','Indirect Expense',1),
      ('Employer PF Contribution','Indirect Expense',1),
      ('Employer ESI Contribution','Indirect Expense',1),
      ('Salary Payable','Current Liabilities',1),
      ('PF Payable','Current Liabilities',1),
      ('ESI Payable','Current Liabilities',1),
      ('Professional Tax Payable','Current Liabilities',1),
      ('TDS on Salary Payable','Current Liabilities',1),
      ('Other Salary Deductions Payable','Current Liabilities',1),
      ('Employee Loans & Advances','Current Assets',1)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS employee_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        father_husband_name TEXT,
        dob TEXT,
        gender TEXT,
        doj TEXT,
        dol TEXT,
        status TEXT DEFAULT 'ACTIVE',
        department TEXT,
        designation TEXT,
        location_id INTEGER,
        email TEXT,
        phone TEXT,
        address TEXT,
        pan TEXT,
        aadhaar TEXT,
        uan TEXT,
        pf_number TEXT,
        esi_number TEXT,
        bank_name TEXT,
        bank_account_no TEXT,
        bank_ifsc TEXT,
        pf_applicable INTEGER DEFAULT 1,
        esi_applicable INTEGER DEFAULT 0,
        pt_applicable INTEGER DEFAULT 1,
        pt_state TEXT,
        tds_declared_annual_investment REAL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS salary_structure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        effective_from TEXT NOT NULL,
        component_name TEXT NOT NULL,
        component_type TEXT CHECK(component_type IN ('EARNING','DEDUCTION')) NOT NULL,
        calc_type TEXT CHECK(calc_type IN ('FIXED','PERCENT_OF_BASIC','PERCENT_OF_GROSS')) NOT NULL,
        value REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (employee_id) REFERENCES employee_master(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS attendance_monthly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        days_in_month INTEGER NOT NULL,
        lop_days REAL DEFAULT 0,
        remarks TEXT,
        UNIQUE(employee_id, month, year),
        FOREIGN KEY (employee_id) REFERENCES employee_master(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS leave_type_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leave_code TEXT UNIQUE,
        leave_name TEXT,
        annual_quota REAL DEFAULT 0
      )
    `);
    db.run(`
      INSERT OR IGNORE INTO leave_type_master (leave_code, leave_name, annual_quota) VALUES
      ('CL','Casual Leave',12),
      ('SL','Sick Leave',12),
      ('EL','Earned/Privilege Leave',15),
      ('LOP','Loss of Pay',0)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS leave_balance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        leave_type_id INTEGER NOT NULL,
        year INTEGER NOT NULL,
        opening_balance REAL DEFAULT 0,
        availed REAL DEFAULT 0,
        UNIQUE(employee_id, leave_type_id, year)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS leave_request (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        leave_type_id INTEGER NOT NULL,
        from_date TEXT,
        to_date TEXT,
        days REAL,
        status TEXT DEFAULT 'PENDING',
        reason TEXT,
        applied_on TEXT DEFAULT (datetime('now')),
        decided_on TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS employee_loan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        loan_type TEXT DEFAULT 'LOAN',
        principal REAL NOT NULL,
        emi_amount REAL NOT NULL,
        outstanding REAL NOT NULL,
        start_month INTEGER,
        start_year INTEGER,
        status TEXT DEFAULT 'ACTIVE',
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (employee_id) REFERENCES employee_master(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS payroll_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        status TEXT DEFAULT 'DRAFT',
        journal_voucher_no TEXT,
        payment_voucher_no TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        processed_at TEXT,
        paid_at TEXT,
        UNIQUE(month, year)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS payroll_run_detail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        days_in_month INTEGER,
        lop_days REAL,
        gross_earnings REAL,
        pf_employee REAL DEFAULT 0,
        pf_employer REAL DEFAULT 0,
        esi_employee REAL DEFAULT 0,
        esi_employer REAL DEFAULT 0,
        pt REAL DEFAULT 0,
        tds REAL DEFAULT 0,
        tds_is_override INTEGER DEFAULT 0,
        loan_deduction REAL DEFAULT 0,
        other_deductions REAL DEFAULT 0,
        net_pay REAL DEFAULT 0,
        breakup_json TEXT,
        FOREIGN KEY (run_id) REFERENCES payroll_run(id),
        FOREIGN KEY (employee_id) REFERENCES employee_master(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS pt_slab_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL,
        min_gross REAL NOT NULL,
        max_gross REAL,
        monthly_pt REAL NOT NULL
      )
    `);
    db.get(`SELECT COUNT(*) AS c FROM pt_slab_master`, [], (err, row) => {
      if (!err && row && row.c === 0) {
        const seed = db.prepare(
          `INSERT INTO pt_slab_master (state, min_gross, max_gross, monthly_pt) VALUES (?,?,?,?)`
        );
        // Illustrative seed slabs only — verify against the current state
        // notification before relying on these for statutory filing.
        [
          ["Karnataka", 0, 24999, 0],
          ["Karnataka", 25000, null, 200],
          ["Maharashtra", 0, 7500, 0],
          ["Maharashtra", 7501, 10000, 175],
          ["Maharashtra", 10001, null, 200],
          ["West Bengal", 0, 10000, 0],
          ["West Bengal", 10001, 15000, 110],
          ["West Bengal", 15001, 25000, 130],
          ["West Bengal", 25001, 40000, 150],
          ["West Bengal", 40001, null, 200],
          ["Tamil Nadu", 0, 21000, 0],
          ["Tamil Nadu", 21001, null, 208],
          ["OTHER", 0, null, 0]
        ].forEach(r => seed.run(r));
        seed.finalize();
      }
    });

    db.run(`CREATE TABLE IF NOT EXISTS employee_master_seq_placeholder (x INTEGER)`); // no-op, keeps serialize chain tidy
  });

  /* -------------------- DEFAULT PAYROLL SETTINGS -------------------- */

  const PAYROLL_DEFAULTS = {
    pf_wage_ceiling: "15000",
    pf_employee_rate: "12",
    pf_employer_rate: "12",
    esi_wage_ceiling: "21000",
    esi_employee_rate: "0.75",
    esi_employer_rate: "3.25",
    tds_standard_deduction: "75000",
    tds_rebate_income_limit: "1200000" // new-regime 87A threshold, taxable income
  };

  async function getPayrollSetting(key) {
    return getSetting(key, PAYROLL_DEFAULTS[key]);
  }

  /* -------------------- SMALL HELPERS -------------------- */

  function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
  function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
  function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }
  function daysInMonth(month, year) {
    return new Date(year, month, 0).getDate();
  }

  /* -------------------- SALARY CALCULATION ENGINE -------------------- */

  async function getActiveStructure(employeeId) {
    return dbAll(
      `SELECT * FROM salary_structure WHERE employee_id = ? AND is_active = 1 ORDER BY id`,
      [employeeId]
    );
  }

  function computeAnnualTds(annualTaxableGross, declaredInvestment, standardDeduction, rebateLimit) {
    // Simplified NEW REGIME slab estimate. Not a substitute for a proper
    // tax computation — declared investments only reduce tax under the
    // OLD regime, so under the new regime `declaredInvestment` is ignored
    // here except as a record; it is accepted for forward-compatibility.
    const taxable = Math.max(0, annualTaxableGross - standardDeduction);
    const slabs = [
      [400000, 0],
      [800000, 0.05],
      [1200000, 0.10],
      [1600000, 0.15],
      [2000000, 0.20],
      [2400000, 0.25],
      [Infinity, 0.30]
    ];
    let tax = 0;
    let lower = 0;
    for (const [upper, rate] of slabs) {
      if (taxable > lower) {
        tax += (Math.min(taxable, upper) - lower) * rate;
        lower = upper;
      } else break;
    }
    if (taxable <= rebateLimit) tax = 0; // Section 87A style rebate, approximate
    const cess = tax * 0.04;
    return Math.round(tax + cess);
  }

  async function lookupPt(state, monthlyGross) {
    if (!state) state = "OTHER";
    const rows = await dbAll(
      `SELECT * FROM pt_slab_master WHERE state = ? ORDER BY min_gross`,
      [state]
    );
    const useRows = rows.length ? rows : await dbAll(
      `SELECT * FROM pt_slab_master WHERE state = 'OTHER' ORDER BY min_gross`
    );
    for (const r of useRows) {
      if (monthlyGross >= r.min_gross && (r.max_gross === null || monthlyGross <= r.max_gross)) {
        return r.monthly_pt;
      }
    }
    return 0;
  }

  /**
   * Computes one employee's pay for a given month/year.
   * `overrides` allows a draft row to carry forward manual edits
   * (e.g. an accountant-adjusted TDS or other_deductions figure).
   */
  async function computePayroll(employeeId, month, year, overrides = {}) {
    const emp = await dbGet(`SELECT * FROM employee_master WHERE id = ?`, [employeeId]);
    if (!emp) throw new Error("Employee not found");

    const structure = await getActiveStructure(employeeId);
    const dim = daysInMonth(month, year);

    const att = await dbGet(
      `SELECT * FROM attendance_monthly WHERE employee_id = ? AND month = ? AND year = ?`,
      [employeeId, month, year]
    );
    const lopDays = att ? Number(att.lop_days) || 0 : 0;
    const payableFactor = Math.max(0, (dim - lopDays) / dim);

    const basicRow = structure.find(
      s => s.component_type === "EARNING" && s.calc_type === "FIXED" && s.component_name.trim().toLowerCase() === "basic"
    );
    const basicMonthlyFull = basicRow ? Number(basicRow.value) : 0;

    const earningLines = [];
    for (const s of structure.filter(x => x.component_type === "EARNING")) {
      let full;
      if (s.calc_type === "FIXED") full = Number(s.value);
      else if (s.calc_type === "PERCENT_OF_BASIC") full = basicMonthlyFull * (Number(s.value) / 100);
      else full = 0; // PERCENT_OF_GROSS resolved in a second pass below
      earningLines.push({ name: s.component_name, calc_type: s.calc_type, full });
    }
    const grossFullBeforePctGross = earningLines.reduce((a, l) => a + l.full, 0);
    for (const s of structure.filter(x => x.component_type === "EARNING" && x.calc_type === "PERCENT_OF_GROSS")) {
      const line = earningLines.find(l => l.name === s.component_name);
      if (line) line.full = grossFullBeforePctGross * (Number(s.value) / 100);
    }

    const grossFull = earningLines.reduce((a, l) => a + l.full, 0);
    const proratedEarnings = earningLines.map(l => ({ name: l.name, amount: Math.round(l.full * payableFactor * 100) / 100 }));
    const basicProrated = Math.round(basicMonthlyFull * payableFactor * 100) / 100;
    const grossEarnings = Math.round(proratedEarnings.reduce((a, l) => a + l.amount, 0) * 100) / 100;

    const structureDeductionLines = [];
    for (const s of structure.filter(x => x.component_type === "DEDUCTION")) {
      let full;
      if (s.calc_type === "FIXED") full = Number(s.value);
      else if (s.calc_type === "PERCENT_OF_BASIC") full = basicMonthlyFull * (Number(s.value) / 100);
      else full = grossFull * (Number(s.value) / 100);
      structureDeductionLines.push({ name: s.component_name, amount: Math.round(full * payableFactor * 100) / 100 });
    }
    const otherDeductionsAuto = Math.round(structureDeductionLines.reduce((a, l) => a + l.amount, 0) * 100) / 100;

    // ---- Statutory: PF ----
    const pfCeiling = Number(await getPayrollSetting("pf_wage_ceiling"));
    const pfEmpRate = Number(await getPayrollSetting("pf_employee_rate"));
    const pfErRate = Number(await getPayrollSetting("pf_employer_rate"));
    let pfEmployee = 0, pfEmployer = 0;
    if (emp.pf_applicable) {
      const pfBase = Math.min(basicProrated, pfCeiling);
      pfEmployee = Math.round(pfBase * (pfEmpRate / 100));
      pfEmployer = Math.round(pfBase * (pfErRate / 100));
    }

    // ---- Statutory: ESI ----
    const esiCeiling = Number(await getPayrollSetting("esi_wage_ceiling"));
    const esiEmpRate = Number(await getPayrollSetting("esi_employee_rate"));
    const esiErRate = Number(await getPayrollSetting("esi_employer_rate"));
    let esiEmployee = 0, esiEmployer = 0;
    if (emp.esi_applicable && grossEarnings <= esiCeiling) {
      esiEmployee = Math.round(grossEarnings * (esiEmpRate / 100));
      esiEmployer = Math.round(grossEarnings * (esiErRate / 100));
    }

    // ---- Statutory: Professional Tax ----
    let pt = 0;
    if (emp.pt_applicable) {
      pt = await lookupPt(emp.pt_state, grossEarnings);
    }

    // ---- Statutory: TDS (estimated, editable) ----
    let tds;
    let tdsIsOverride = 0;
    if (overrides.tds !== undefined && overrides.tds !== null) {
      tds = Number(overrides.tds);
      tdsIsOverride = 1;
    } else {
      const annualProjected = grossEarnings * 12;
      const stdDeduction = Number(await getPayrollSetting("tds_standard_deduction"));
      const rebateLimit = Number(await getPayrollSetting("tds_rebate_income_limit"));
      const annualTds = computeAnnualTds(annualProjected, emp.tds_declared_annual_investment || 0, stdDeduction, rebateLimit);
      tds = Math.round(annualTds / 12);
    }

    // ---- Loans ----
    const loans = await dbAll(
      `SELECT * FROM employee_loan WHERE employee_id = ? AND status = 'ACTIVE'`,
      [employeeId]
    );
    let loanDeduction = 0;
    for (const l of loans) {
      loanDeduction += Math.min(Number(l.emi_amount), Number(l.outstanding));
    }
    loanDeduction = Math.round(loanDeduction);

    const otherDeductions = overrides.other_deductions !== undefined
      ? Number(overrides.other_deductions)
      : otherDeductionsAuto;

    const totalDeductions = pfEmployee + esiEmployee + pt + tds + loanDeduction + otherDeductions;
    const netPay = Math.round((grossEarnings - totalDeductions) * 100) / 100;

    return {
      employee_id: employeeId,
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      days_in_month: dim,
      lop_days: lopDays,
      gross_earnings: grossEarnings,
      pf_employee: pfEmployee,
      pf_employer: pfEmployer,
      esi_employee: esiEmployee,
      esi_employer: esiEmployer,
      pt,
      tds,
      tds_is_override: tdsIsOverride,
      loan_deduction: loanDeduction,
      other_deductions: otherDeductions,
      net_pay: netPay,
      breakup: {
        earnings: proratedEarnings,
        structure_deductions: structureDeductionLines,
        statutory: { pfEmployee, pfEmployer, esiEmployee, esiEmployer, pt, tds },
        loan_deduction: loanDeduction
      }
    };
  }

  /* ==================================================================
     EMPLOYEE MASTER
     ================================================================== */

  app.post("/hr/employee/create", async (req, res) => {
    const b = req.body || {};
    if (!b.full_name) return res.status(400).json({ error: "full_name is required" });
    try {
      let code = b.employee_code;
      if (!code) {
        const last = await dbGet(`SELECT employee_code FROM employee_master ORDER BY id DESC LIMIT 1`);
        const lastNum = last && last.employee_code ? parseInt(last.employee_code.replace(/\D/g, ""), 10) || 0 : 0;
        code = "EMP" + String(lastNum + 1).padStart(4, "0");
      }
      const r = await dbRun(
        `INSERT INTO employee_master
         (employee_code, full_name, father_husband_name, dob, gender, doj, status, department, designation,
          location_id, email, phone, address, pan, aadhaar, uan, pf_number, esi_number,
          bank_name, bank_account_no, bank_ifsc, pf_applicable, esi_applicable, pt_applicable, pt_state,
          tds_declared_annual_investment, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          code, b.full_name, b.father_husband_name || null, b.dob || null, b.gender || null,
          b.doj || null, b.status || "ACTIVE", b.department || null, b.designation || null,
          b.location_id || null, b.email || null, b.phone || null, b.address || null,
          b.pan || null, b.aadhaar || null, b.uan || null, b.pf_number || null, b.esi_number || null,
          b.bank_name || null, b.bank_account_no || null, b.bank_ifsc || null,
          b.pf_applicable === undefined ? 1 : Number(!!b.pf_applicable),
          Number(!!b.esi_applicable), b.pt_applicable === undefined ? 1 : Number(!!b.pt_applicable),
          b.pt_state || null, Number(b.tds_declared_annual_investment) || 0, b.notes || null
        ]
      );
      res.json({ status: "success", id: r.lastID, employee_code: code });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/hr/employee/:id", async (req, res) => {
    const b = req.body || {};
    const fields = [
      "full_name", "father_husband_name", "dob", "gender", "doj", "dol", "status", "department",
      "designation", "location_id", "email", "phone", "address", "pan", "aadhaar", "uan",
      "pf_number", "esi_number", "bank_name", "bank_account_no", "bank_ifsc",
      "pf_applicable", "esi_applicable", "pt_applicable", "pt_state",
      "tds_declared_annual_investment", "notes"
    ];
    const sets = [];
    const vals = [];
    fields.forEach(f => {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    });
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(req.params.id);
    try {
      await dbRun(`UPDATE employee_master SET ${sets.join(", ")} WHERE id = ?`, vals);
      res.json({ status: "success" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/hr/employee/:id/exit", async (req, res) => {
    const { dol } = req.body || {};
    try {
      await dbRun(
        `UPDATE employee_master SET status = 'EXITED', dol = ? WHERE id = ?`,
        [dol || new Date().toISOString().slice(0, 10), req.params.id]
      );
      res.json({ status: "success" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/hr/employees", async (req, res) => {
    try {
      const status = req.query.status;
      const rows = status
        ? await dbAll(`SELECT * FROM employee_master WHERE status = ? ORDER BY full_name`, [status])
        : await dbAll(`SELECT * FROM employee_master ORDER BY full_name`);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/hr/employees/search", async (req, res) => {
    const q = `%${req.query.q || ""}%`;
    try {
      const rows = await dbAll(
        `SELECT * FROM employee_master WHERE full_name LIKE ? OR employee_code LIKE ? ORDER BY full_name LIMIT 25`,
        [q, q]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/hr/employee/:id", async (req, res) => {
    try {
      const row = await dbGet(`SELECT * FROM employee_master WHERE id = ?`, [req.params.id]);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ==================================================================
     SALARY STRUCTURE
     ================================================================== */

  app.get("/hr/salary-structure/:employeeId", async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT * FROM salary_structure WHERE employee_id = ? AND is_active = 1 ORDER BY component_type, id`,
        [req.params.employeeId]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/hr/salary-structure/save", async (req, res) => {
    const { employeeId, effectiveFrom, components } = req.body || {};
    if (!employeeId || !Array.isArray(components) || !components.length) {
      return res.status(400).json({ error: "employeeId and a non-empty components[] are required" });
    }
    const hasBasic = components.some(
      c => c.component_type === "EARNING" && c.calc_type === "FIXED" && String(c.component_name).trim().toLowerCase() === "basic"
    );
    if (!hasBasic) {
      return res.status(400).json({ error: "Structure must include a fixed EARNING component named 'Basic' — percentage components are calculated off it." });
    }
    try {
      await dbRun(`UPDATE salary_structure SET is_active = 0 WHERE employee_id = ?`, [employeeId]);
      const stmt = db.prepare(
        `INSERT INTO salary_structure (employee_id, effective_from, component_name, component_type, calc_type, value, is_active)
         VALUES (?,?,?,?,?,?,1)`
      );
      for (const c of components) {
        stmt.run(employeeId, effectiveFrom || new Date().toISOString().slice(0, 10), c.component_name, c.component_type, c.calc_type, Number(c.value));
      }
      stmt.finalize(err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success" });
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/hr/salary-structure/:employeeId/ctc", async (req, res) => {
    try {
      const structure = await getActiveStructure(req.params.employeeId);
      const basicRow = structure.find(s => s.component_type === "EARNING" && s.calc_type === "FIXED" && s.component_name.trim().toLowerCase() === "basic");
      const basic = basicRow ? Number(basicRow.value) : 0;
      let gross = 0;
      const lines = structure.filter(s => s.component_type === "EARNING").map(s => {
        let amt = s.calc_type === "FIXED" ? Number(s.value) : s.calc_type === "PERCENT_OF_BASIC" ? basic * Number(s.value) / 100 : 0;
        return { name: s.component_name, calc_type: s.calc_type, monthly: amt };
      });
      gross = lines.reduce((a, l) => a + l.monthly, 0);
      lines.forEach(l => {
        const src = structure.find(s => s.component_name === l.name);
        if (src.calc_type === "PERCENT_OF_GROSS") l.monthly = gross * Number(src.value) / 100;
      });
      const monthlyGross = Math.round(lines.reduce((a, l) => a + l.monthly, 0) * 100) / 100;
      res.json({ employee_id: req.params.employeeId, monthly_gross: monthlyGross, annual_ctc_earnings_only: Math.round(monthlyGross * 12), components: lines });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ==================================================================
     ATTENDANCE
     ================================================================== */

  app.post("/hr/attendance/save", async (req, res) => {
    const { employeeId, month, year, lopDays, remarks } = req.body || {};
    if (!employeeId || !month || !year) return res.status(400).json({ error: "employeeId, month, year required" });
    try {
      const dim = daysInMonth(Number(month), Number(year));
      await dbRun(
        `INSERT INTO attendance_monthly (employee_id, month, year, days_in_month, lop_days, remarks)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(employee_id, month, year) DO UPDATE SET lop_days = excluded.lop_days, remarks = excluded.remarks`,
        [employeeId, month, year, dim, Number(lopDays) || 0, remarks || null]
      );
      res.json({ status: "success" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/hr/attendance/:year/:month", async (req, res) => {
    try {
      const employees = await dbAll(`SELECT id, employee_code, full_name FROM employee_master WHERE status = 'ACTIVE' ORDER BY full_name`);
      const existing = await dbAll(
        `SELECT * FROM attendance_monthly WHERE month = ? AND year = ?`,
        [req.params.month, req.params.year]
      );
      const byEmp = {};
      existing.forEach(e => { byEmp[e.employee_id] = e; });
      const dim = daysInMonth(Number(req.params.month), Number(req.params.year));
      const rows = employees.map(e => ({
        employee_id: e.id,
        employee_code: e.employee_code,
        full_name: e.full_name,
        days_in_month: dim,
        lop_days: byEmp[e.id] ? byEmp[e.id].lop_days : 0
      }));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ==================================================================
     LEAVE (types, balances, requests)
     ================================================================== */

  app.get("/hr/leave-types", async (req, res) => {
    try { res.json(await dbAll(`SELECT * FROM leave_type_master ORDER BY id`)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/leave-types/create", async (req, res) => {
    const { leave_code, leave_name, annual_quota } = req.body || {};
    if (!leave_code || !leave_name) return res.status(400).json({ error: "leave_code and leave_name required" });
    try {
      await dbRun(`INSERT INTO leave_type_master (leave_code, leave_name, annual_quota) VALUES (?,?,?)`, [leave_code, leave_name, Number(annual_quota) || 0]);
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/leave-balance/:employeeId/:year", async (req, res) => {
    try {
      const types = await dbAll(`SELECT * FROM leave_type_master ORDER BY id`);
      const balances = await dbAll(
        `SELECT * FROM leave_balance WHERE employee_id = ? AND year = ?`,
        [req.params.employeeId, req.params.year]
      );
      const byType = {};
      balances.forEach(b => { byType[b.leave_type_id] = b; });
      res.json(types.map(t => ({
        leave_type_id: t.id,
        leave_code: t.leave_code,
        leave_name: t.leave_name,
        annual_quota: t.annual_quota,
        opening_balance: byType[t.id] ? byType[t.id].opening_balance : t.annual_quota,
        availed: byType[t.id] ? byType[t.id].availed : 0,
        remaining: (byType[t.id] ? byType[t.id].opening_balance - byType[t.id].availed : t.annual_quota)
      })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/leave-balance/set", async (req, res) => {
    const { employeeId, leaveTypeId, year, openingBalance } = req.body || {};
    try {
      await dbRun(
        `INSERT INTO leave_balance (employee_id, leave_type_id, year, opening_balance, availed)
         VALUES (?,?,?,?,0)
         ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE SET opening_balance = excluded.opening_balance`,
        [employeeId, leaveTypeId, year, Number(openingBalance) || 0]
      );
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/leave-request/create", async (req, res) => {
    const { employeeId, leaveTypeId, fromDate, toDate, days, reason } = req.body || {};
    if (!employeeId || !leaveTypeId || !fromDate || !toDate || !days) {
      return res.status(400).json({ error: "employeeId, leaveTypeId, fromDate, toDate, days required" });
    }
    try {
      const r = await dbRun(
        `INSERT INTO leave_request (employee_id, leave_type_id, from_date, to_date, days, reason) VALUES (?,?,?,?,?,?)`,
        [employeeId, leaveTypeId, fromDate, toDate, Number(days), reason || null]
      );
      res.json({ status: "success", id: r.lastID });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/leave-requests", async (req, res) => {
    try {
      const { employeeId, status } = req.query;
      let sql = `SELECT lr.*, e.full_name, lt.leave_name FROM leave_request lr
                 JOIN employee_master e ON e.id = lr.employee_id
                 JOIN leave_type_master lt ON lt.id = lr.leave_type_id WHERE 1=1`;
      const params = [];
      if (employeeId) { sql += ` AND lr.employee_id = ?`; params.push(employeeId); }
      if (status) { sql += ` AND lr.status = ?`; params.push(status); }
      sql += ` ORDER BY lr.id DESC`;
      res.json(await dbAll(sql, params));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/leave-request/:id/approve", async (req, res) => {
    try {
      const lr = await dbGet(`SELECT * FROM leave_request WHERE id = ?`, [req.params.id]);
      if (!lr) return res.status(404).json({ error: "Not found" });
      const year = new Date(lr.from_date).getFullYear();
      await dbRun(
        `INSERT INTO leave_balance (employee_id, leave_type_id, year, opening_balance, availed)
         VALUES (?,?,?, (SELECT annual_quota FROM leave_type_master WHERE id = ?), ?)
         ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE SET availed = availed + excluded.availed`,
        [lr.employee_id, lr.leave_type_id, year, lr.leave_type_id, lr.days]
      );
      await dbRun(`UPDATE leave_request SET status = 'APPROVED', decided_on = datetime('now') WHERE id = ?`, [req.params.id]);
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/leave-request/:id/reject", async (req, res) => {
    try {
      await dbRun(`UPDATE leave_request SET status = 'REJECTED', decided_on = datetime('now') WHERE id = ?`, [req.params.id]);
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ==================================================================
     LOANS & ADVANCES
     ================================================================== */

  app.post("/hr/loan/create", async (req, res) => {
    const { employeeId, loanType, principal, emiAmount, startMonth, startYear, postToLedger, disbursementLedger, date } = req.body || {};
    if (!employeeId || !principal || !emiAmount) {
      return res.status(400).json({ error: "employeeId, principal, emiAmount required" });
    }
    try {
      const r = await dbRun(
        `INSERT INTO employee_loan (employee_id, loan_type, principal, emi_amount, outstanding, start_month, start_year)
         VALUES (?,?,?,?,?,?,?)`,
        [employeeId, loanType || "LOAN", Number(principal), Number(emiAmount), Number(principal), startMonth || null, startYear || null]
      );
      let voucherNo = null;
      if (postToLedger) {
        const emp = await dbGet(`SELECT full_name FROM employee_master WHERE id = ?`, [employeeId]);
        voucherNo = await saveJournalInternal({ userId: req.user ? req.user.id : null,
          date: date || new Date().toISOString().slice(0, 10),
          narration: `${loanType || "Loan"} disbursed to ${emp ? emp.full_name : "employee"}`,
          entries: [
            { particulars: "Employee Loans & Advances", debit: Number(principal), credit: 0 },
            { particulars: disbursementLedger || "Bank A/c", debit: 0, credit: Number(principal) }
          ]
        });
      }
      res.json({ status: "success", id: r.lastID, voucher_no: voucherNo });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/loan/list", async (req, res) => {
    try {
      const { employeeId, status } = req.query;
      let sql = `SELECT el.*, e.full_name FROM employee_loan el JOIN employee_master e ON e.id = el.employee_id WHERE 1=1`;
      const params = [];
      if (employeeId) { sql += ` AND el.employee_id = ?`; params.push(employeeId); }
      if (status) { sql += ` AND el.status = ?`; params.push(status); }
      sql += ` ORDER BY el.id DESC`;
      res.json(await dbAll(sql, params));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/loan/:id/close", async (req, res) => {
    try {
      await dbRun(`UPDATE employee_loan SET status = 'CLOSED' WHERE id = ?`, [req.params.id]);
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ==================================================================
     PAYROLL RUN
     ================================================================== */

  app.post("/hr/payroll/run/create", async (req, res) => {
    const { month, year } = req.body || {};
    if (!month || !year) return res.status(400).json({ error: "month and year required" });
    try {
      const existing = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      let runId;
      if (existing) {
        if (existing.status !== "DRAFT") return res.status(400).json({ error: `Run for ${month}/${year} already ${existing.status}` });
        runId = existing.id;
        await dbRun(`DELETE FROM payroll_run_detail WHERE run_id = ?`, [runId]);
      } else {
        const r = await dbRun(
          `INSERT INTO payroll_run (month, year, status, created_by) VALUES (?,?,'DRAFT',?)`,
          [month, year, req.user ? req.user.id : null]
        );
        runId = r.lastID;
      }
      const employees = await dbAll(`SELECT id FROM employee_master WHERE status = 'ACTIVE'`);
      for (const e of employees) {
        const calc = await computePayroll(e.id, month, year);
        await dbRun(
          `INSERT INTO payroll_run_detail
           (run_id, employee_id, days_in_month, lop_days, gross_earnings, pf_employee, pf_employer,
            esi_employee, esi_employer, pt, tds, tds_is_override, loan_deduction, other_deductions, net_pay, breakup_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [runId, e.id, calc.days_in_month, calc.lop_days, calc.gross_earnings, calc.pf_employee, calc.pf_employer,
           calc.esi_employee, calc.esi_employer, calc.pt, calc.tds, calc.tds_is_override, calc.loan_deduction,
           calc.other_deductions, calc.net_pay, JSON.stringify(calc.breakup)]
        );
      }
      res.json({ status: "success", run_id: runId, employees_processed: employees.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/payroll/run/list", async (req, res) => {
    try { res.json(await dbAll(`SELECT * FROM payroll_run ORDER BY year DESC, month DESC`)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/payroll/run/:id", async (req, res) => {
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.id]);
      if (!run) return res.status(404).json({ error: "Not found" });
      const details = await dbAll(
        `SELECT prd.*, e.full_name, e.employee_code FROM payroll_run_detail prd
         JOIN employee_master e ON e.id = prd.employee_id WHERE prd.run_id = ? ORDER BY e.full_name`,
        [req.params.id]
      );
      const totals = details.reduce((t, d) => {
        t.gross += d.gross_earnings; t.pf_employee += d.pf_employee; t.pf_employer += d.pf_employer;
        t.esi_employee += d.esi_employee; t.esi_employer += d.esi_employer; t.pt += d.pt; t.tds += d.tds;
        t.loan += d.loan_deduction; t.other += d.other_deductions; t.net += d.net_pay;
        return t;
      }, { gross: 0, pf_employee: 0, pf_employer: 0, esi_employee: 0, esi_employer: 0, pt: 0, tds: 0, loan: 0, other: 0, net: 0 });
      res.json({ run, details, totals });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put("/hr/payroll/run/:id/detail/:detailId", async (req, res) => {
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.id]);
      if (!run) return res.status(404).json({ error: "Run not found" });
      if (run.status !== "DRAFT") return res.status(400).json({ error: "Only DRAFT runs can be edited" });
      const detail = await dbGet(`SELECT * FROM payroll_run_detail WHERE id = ? AND run_id = ?`, [req.params.detailId, req.params.id]);
      if (!detail) return res.status(404).json({ error: "Detail row not found" });

      const overrides = {};
      if (req.body.tds !== undefined) overrides.tds = req.body.tds;
      if (req.body.other_deductions !== undefined) overrides.other_deductions = req.body.other_deductions;

      const calc = await computePayroll(detail.employee_id, run.month, run.year, overrides);
      await dbRun(
        `UPDATE payroll_run_detail SET days_in_month=?, lop_days=?, gross_earnings=?, pf_employee=?, pf_employer=?,
         esi_employee=?, esi_employer=?, pt=?, tds=?, tds_is_override=?, loan_deduction=?, other_deductions=?, net_pay=?, breakup_json=?
         WHERE id = ?`,
        [calc.days_in_month, calc.lop_days, calc.gross_earnings, calc.pf_employee, calc.pf_employer,
         calc.esi_employee, calc.esi_employer, calc.pt, calc.tds, calc.tds_is_override, calc.loan_deduction,
         calc.other_deductions, calc.net_pay, JSON.stringify(calc.breakup), req.params.detailId]
      );
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/payroll/run/:id/process", async (req, res) => {
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.id]);
      if (!run) return res.status(404).json({ error: "Not found" });
      if (run.status !== "DRAFT") return res.status(400).json({ error: `Run already ${run.status}` });

      const details = await dbAll(`SELECT * FROM payroll_run_detail WHERE run_id = ?`, [req.params.id]);
      if (!details.length) return res.status(400).json({ error: "No employees in this run" });

      const t = details.reduce((a, d) => {
        a.gross += d.gross_earnings; a.pfE += d.pf_employee; a.pfR += d.pf_employer;
        a.esiE += d.esi_employee; a.esiR += d.esi_employer; a.pt += d.pt; a.tds += d.tds;
        a.loan += d.loan_deduction; a.other += d.other_deductions; a.net += d.net_pay;
        return a;
      }, { gross: 0, pfE: 0, pfR: 0, esiE: 0, esiR: 0, pt: 0, tds: 0, loan: 0, other: 0, net: 0 });

      const round2 = n => Math.round(n * 100) / 100;
      const entries = [
        { particulars: "Salary & Wages", debit: round2(t.gross), credit: 0 }
      ];
      if (t.pfR) entries.push({ particulars: "Employer PF Contribution", debit: round2(t.pfR), credit: 0 });
      if (t.esiR) entries.push({ particulars: "Employer ESI Contribution", debit: round2(t.esiR), credit: 0 });
      entries.push({ particulars: "Salary Payable", debit: 0, credit: round2(t.net) });
      if (t.pfE + t.pfR) entries.push({ particulars: "PF Payable", debit: 0, credit: round2(t.pfE + t.pfR) });
      if (t.esiE + t.esiR) entries.push({ particulars: "ESI Payable", debit: 0, credit: round2(t.esiE + t.esiR) });
      if (t.pt) entries.push({ particulars: "Professional Tax Payable", debit: 0, credit: round2(t.pt) });
      if (t.tds) entries.push({ particulars: "TDS on Salary Payable", debit: 0, credit: round2(t.tds) });
      if (t.loan) entries.push({ particulars: "Employee Loans & Advances", debit: 0, credit: round2(t.loan) });
      if (t.other) entries.push({ particulars: "Other Salary Deductions Payable", debit: 0, credit: round2(t.other) });

      const voucherNo = await saveJournalInternal({ userId: req.user ? req.user.id : null,
        date: `${run.year}-${String(run.month).padStart(2, "0")}-01`,
        narration: `Salary for ${run.month}/${run.year} — Payroll Run #${run.id}`,
        entries
      });

      // reduce outstanding loan balances now that the deduction is final
      for (const d of details) {
        if (d.loan_deduction > 0) {
          const loans = await dbAll(`SELECT * FROM employee_loan WHERE employee_id = ? AND status = 'ACTIVE' ORDER BY id`, [d.employee_id]);
          let remaining = d.loan_deduction;
          for (const l of loans) {
            if (remaining <= 0) break;
            const applied = Math.min(remaining, l.outstanding);
            const newOutstanding = round2(l.outstanding - applied);
            await dbRun(
              `UPDATE employee_loan SET outstanding = ?, status = ? WHERE id = ?`,
              [newOutstanding, newOutstanding <= 0 ? "CLOSED" : "ACTIVE", l.id]
            );
            remaining -= applied;
          }
        }
      }

      await dbRun(
        `UPDATE payroll_run SET status = 'PROCESSED', journal_voucher_no = ?, processed_at = datetime('now'), updated_by = ? WHERE id = ?`,
        [voucherNo, req.user ? req.user.id : null, req.params.id]
      );
      res.json({ status: "success", voucher_no: voucherNo, totals: t });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/payroll/run/:id/mark-paid", async (req, res) => {
    const { date, bankLedger } = req.body || {};
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.id]);
      if (!run) return res.status(404).json({ error: "Not found" });
      if (run.status !== "PROCESSED") return res.status(400).json({ error: "Run must be PROCESSED before it can be marked paid" });

      const details = await dbAll(`SELECT * FROM payroll_run_detail WHERE run_id = ?`, [req.params.id]);
      const netTotal = Math.round(details.reduce((a, d) => a + d.net_pay, 0) * 100) / 100;

      const voucherNo = await saveJournalInternal({ userId: req.user ? req.user.id : null,
        date: date || new Date().toISOString().slice(0, 10),
        narration: `Salary payment for ${run.month}/${run.year} — Payroll Run #${run.id}`,
        entries: [
          { particulars: "Salary Payable", debit: netTotal, credit: 0 },
          { particulars: bankLedger || "Bank A/c", debit: 0, credit: netTotal }
        ]
      });

      await dbRun(
        `UPDATE payroll_run SET status = 'PAID', payment_voucher_no = ?, paid_at = datetime('now'), updated_by = ? WHERE id = ?`,
        [voucherNo, req.user ? req.user.id : null, req.params.id]
      );
      res.json({ status: "success", voucher_no: voucherNo, amount: netTotal });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/payroll/run/:id/cancel", async (req, res) => {
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.id]);
      if (!run) return res.status(404).json({ error: "Not found" });
      if (run.status !== "DRAFT") return res.status(400).json({ error: "Only DRAFT runs can be cancelled" });
      await dbRun(`DELETE FROM payroll_run_detail WHERE run_id = ?`, [req.params.id]);
      await dbRun(`DELETE FROM payroll_run WHERE id = ?`, [req.params.id]);
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ==================================================================
     STATUTORY REMITTANCE (generic — settle a payable liability from bank)
     ================================================================== */

  app.post("/hr/statutory-payment", async (req, res) => {
    const { payableLedger, amount, date, bankLedger, narration } = req.body || {};
    const allowed = ["PF Payable", "ESI Payable", "Professional Tax Payable", "TDS on Salary Payable", "Other Salary Deductions Payable"];
    if (!allowed.includes(payableLedger)) return res.status(400).json({ error: `payableLedger must be one of: ${allowed.join(", ")}` });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "amount must be positive" });
    try {
      const voucherNo = await saveJournalInternal({ userId: req.user ? req.user.id : null,
        date: date || new Date().toISOString().slice(0, 10),
        narration: narration || `${payableLedger} remittance`,
        entries: [
          { particulars: payableLedger, debit: Number(amount), credit: 0 },
          { particulars: bankLedger || "Bank A/c", debit: 0, credit: Number(amount) }
        ]
      });
      res.json({ status: "success", voucher_no: voucherNo });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ==================================================================
     PAYSLIP (PDF)
     ================================================================== */

  app.get("/hr/payslip/:runId/:employeeId", async (req, res) => {
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE id = ?`, [req.params.runId]);
      const detail = await dbGet(
        `SELECT * FROM payroll_run_detail WHERE run_id = ? AND employee_id = ?`,
        [req.params.runId, req.params.employeeId]
      );
      const emp = await dbGet(`SELECT * FROM employee_master WHERE id = ?`, [req.params.employeeId]);
      if (!run || !detail || !emp) return res.status(404).json({ error: "Not found" });

      const companyName = await getSetting("company_name", "Company Name");
      const breakup = JSON.parse(detail.breakup_json || "{}");

      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="Payslip_${emp.employee_code}_${run.month}_${run.year}.pdf"`);
      doc.pipe(res);

      doc.fontSize(16).text(companyName, { align: "center" });
      doc.fontSize(12).text(`Payslip for ${String(run.month).padStart(2, "0")}/${run.year}`, { align: "center" });
      doc.moveDown();
      doc.fontSize(10);
      doc.text(`Employee: ${emp.full_name} (${emp.employee_code})`);
      doc.text(`Designation: ${emp.designation || "-"}    Department: ${emp.department || "-"}`);
      doc.text(`Bank A/c: ${emp.bank_account_no || "-"}    IFSC: ${emp.bank_ifsc || "-"}    PAN: ${emp.pan || "-"}`);
      doc.text(`Days in Month: ${detail.days_in_month}    LOP Days: ${detail.lop_days}`);
      doc.moveDown();

      const colX1 = 40, colX2 = 300, top = doc.y;
      doc.font("Helvetica-Bold").text("Earnings", colX1, top).text("Amount", colX1 + 180, top, { width: 80, align: "right" });
      doc.text("Deductions", colX2, top).text("Amount", colX2 + 180, top, { width: 80, align: "right" });
      doc.font("Helvetica");
      let y = top + 18;
      const earnings = breakup.earnings || [];
      const deductions = [
        ...(breakup.structure_deductions || []),
        { name: "PF (Employee)", amount: detail.pf_employee },
        { name: "ESI (Employee)", amount: detail.esi_employee },
        { name: "Professional Tax", amount: detail.pt },
        { name: "TDS", amount: detail.tds },
        { name: "Loan / Advance EMI", amount: detail.loan_deduction }
      ].filter(d => d.amount > 0);

      const rows = Math.max(earnings.length, deductions.length);
      for (let i = 0; i < rows; i++) {
        if (earnings[i]) doc.text(earnings[i].name, colX1, y).text(Number(earnings[i].amount).toFixed(2), colX1 + 180, y, { width: 80, align: "right" });
        if (deductions[i]) doc.text(deductions[i].name, colX2, y).text(Number(deductions[i].amount).toFixed(2), colX2 + 180, y, { width: 80, align: "right" });
        y += 16;
      }
      y += 6;
      doc.moveTo(colX1, y).lineTo(560, y).stroke();
      y += 8;
      doc.font("Helvetica-Bold");
      doc.text("Gross Earnings", colX1, y).text(Number(detail.gross_earnings).toFixed(2), colX1 + 180, y, { width: 80, align: "right" });
      const totalDeductions = detail.pf_employee + detail.esi_employee + detail.pt + detail.tds + detail.loan_deduction + detail.other_deductions;
      doc.text("Total Deductions", colX2, y).text(Number(totalDeductions).toFixed(2), colX2 + 180, y, { width: 80, align: "right" });
      y += 24;
      doc.fontSize(12).text(`Net Pay: Rs. ${Number(detail.net_pay).toFixed(2)}`, colX1, y);
      doc.fontSize(9).font("Helvetica").text(amountInWords(detail.net_pay, "Indian Rupee"), colX1, y + 18, { width: 500 });

      doc.fontSize(7).text(
        "Statutory deductions shown above are computed by the system and may need review/adjustment by your accountant before filing.",
        colX1, 760, { width: 500 }
      );

      doc.end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ==================================================================
     REPORTS
     ================================================================== */

  app.get("/hr/report/salary-register", async (req, res) => {
    const { month, year } = req.query;
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      if (!run) return res.status(404).json({ error: "No payroll run for that month/year" });
      const details = await dbAll(
        `SELECT prd.*, e.full_name, e.employee_code, e.department, e.designation
         FROM payroll_run_detail prd JOIN employee_master e ON e.id = prd.employee_id
         WHERE prd.run_id = ? ORDER BY e.full_name`,
        [run.id]
      );
      res.json({ run, details });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/report/pf-summary", async (req, res) => {
    const { month, year } = req.query;
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      if (!run) return res.status(404).json({ error: "No payroll run for that month/year" });
      const rows = await dbAll(
        `SELECT e.employee_code, e.full_name, e.uan, e.pf_number, prd.pf_employee, prd.pf_employer
         FROM payroll_run_detail prd JOIN employee_master e ON e.id = prd.employee_id
         WHERE prd.run_id = ? AND (prd.pf_employee > 0 OR prd.pf_employer > 0) ORDER BY e.full_name`,
        [run.id]
      );
      const total = rows.reduce((a, r) => ({ pf_employee: a.pf_employee + r.pf_employee, pf_employer: a.pf_employer + r.pf_employer }), { pf_employee: 0, pf_employer: 0 });
      res.json({ run, rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/report/esi-summary", async (req, res) => {
    const { month, year } = req.query;
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      if (!run) return res.status(404).json({ error: "No payroll run for that month/year" });
      const rows = await dbAll(
        `SELECT e.employee_code, e.full_name, e.esi_number, prd.gross_earnings, prd.esi_employee, prd.esi_employer
         FROM payroll_run_detail prd JOIN employee_master e ON e.id = prd.employee_id
         WHERE prd.run_id = ? AND (prd.esi_employee > 0 OR prd.esi_employer > 0) ORDER BY e.full_name`,
        [run.id]
      );
      const total = rows.reduce((a, r) => ({ esi_employee: a.esi_employee + r.esi_employee, esi_employer: a.esi_employer + r.esi_employer }), { esi_employee: 0, esi_employer: 0 });
      res.json({ run, rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/report/pt-summary", async (req, res) => {
    const { month, year } = req.query;
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      if (!run) return res.status(404).json({ error: "No payroll run for that month/year" });
      const rows = await dbAll(
        `SELECT e.employee_code, e.full_name, e.pt_state, prd.pt
         FROM payroll_run_detail prd JOIN employee_master e ON e.id = prd.employee_id
         WHERE prd.run_id = ? AND prd.pt > 0 ORDER BY e.full_name`,
        [run.id]
      );
      const total = rows.reduce((a, r) => a + r.pt, 0);
      res.json({ run, rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/report/tds-summary", async (req, res) => {
    const { month, year } = req.query;
    try {
      const run = await dbGet(`SELECT * FROM payroll_run WHERE month = ? AND year = ?`, [month, year]);
      if (!run) return res.status(404).json({ error: "No payroll run for that month/year" });
      const rows = await dbAll(
        `SELECT e.employee_code, e.full_name, e.pan, prd.gross_earnings, prd.tds, prd.tds_is_override
         FROM payroll_run_detail prd JOIN employee_master e ON e.id = prd.employee_id
         WHERE prd.run_id = ? AND prd.tds > 0 ORDER BY e.full_name`,
        [run.id]
      );
      const total = rows.reduce((a, r) => a + r.tds, 0);
      res.json({ run, rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/report/loan-outstanding", async (req, res) => {
    try {
      const rows = await dbAll(
        `SELECT el.*, e.full_name, e.employee_code FROM employee_loan el
         JOIN employee_master e ON e.id = el.employee_id WHERE el.status = 'ACTIVE' ORDER BY e.full_name`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ==================================================================
     PAYROLL SETTINGS & PT SLABS
     ================================================================== */

  app.get("/hr/settings", async (req, res) => {
    const out = {};
    for (const key of Object.keys(PAYROLL_DEFAULTS)) {
      out[key] = await getPayrollSetting(key);
    }
    res.json(out);
  });

  app.post("/hr/settings", async (req, res) => {
    const updates = req.body || {};
    try {
      for (const key of Object.keys(updates)) {
        if (Object.prototype.hasOwnProperty.call(PAYROLL_DEFAULTS, key)) {
          await setSetting(key, updates[key]);
        }
      }
      res.json({ status: "success" });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/hr/pt-slabs", async (req, res) => {
    try {
      const state = req.query.state;
      const rows = state
        ? await dbAll(`SELECT * FROM pt_slab_master WHERE state = ? ORDER BY min_gross`, [state])
        : await dbAll(`SELECT * FROM pt_slab_master ORDER BY state, min_gross`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/hr/pt-slabs/save", async (req, res) => {
    const { state, slabs } = req.body || {};
    if (!state || !Array.isArray(slabs)) return res.status(400).json({ error: "state and slabs[] required" });
    try {
      await dbRun(`DELETE FROM pt_slab_master WHERE state = ?`, [state]);
      const stmt = db.prepare(`INSERT INTO pt_slab_master (state, min_gross, max_gross, monthly_pt) VALUES (?,?,?,?)`);
      slabs.forEach(s => stmt.run(state, Number(s.min_gross), s.max_gross === null || s.max_gross === "" ? null : Number(s.max_gross), Number(s.monthly_pt)));
      stmt.finalize(err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success" });
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  console.log("Payroll/HR module loaded.");
};
