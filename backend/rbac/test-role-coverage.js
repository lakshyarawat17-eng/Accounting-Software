/**
 * RBAC — Step 10: Automated "test each role against each module"
 * ===================================================================
 * The plan's Step 10 says "test each role against each module
 * systematically" — this is that, automated instead of manual
 * click-through, so it can be re-run every time permission-matrix.js
 * changes or a module gets tightened, not just once during rollout.
 *
 * WHAT IT DOES
 * For every (role, module) pair, picks one real, parameter-free GET
 * route already known to belong to that module (ROUTE_MODULE_MAP), logs
 * in as that role's test account (see scripts/seed-test-users.js — run
 * that first), calls the route, and checks whether the server's
 * response (200 vs 403/401) matches what permission-matrix.js says that
 * role's `view` permission for that module should be.
 *
 * This only checks `view` (GET). Create/edit/delete/approve on real
 * records is deliberately NOT automated here — running destructive
 * writes as every role against a real database is a bigger risk than
 * this script is worth; use Users.html's role-switching (log in as the
 * test account) for a manual pass on writes per the Step 10 checklist.
 *
 * REQUIRES
 * - The server already running (defaults to http://localhost:3000,
 *   override with RBAC_TEST_BASE_URL).
 * - Test accounts already seeded: node scripts/seed-test-users.js
 * - Node 18+ (uses global fetch).
 *
 * Usage (from backend/):
 *   node rbac/test-role-coverage.js
 *
 * Exit code is non-zero if any mismatch is found, so it's usable as a
 * CI/pre-flight gate before flipping RBAC_ENFORCE=true or tightening a
 * module.
 */

const { ROLES, MODULES, getPermission } = require("./permission-matrix");

const BASE_URL = process.env.RBAC_TEST_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.TEST_USER_PASSWORD || "RbacRollout123!";

// One real, parameter-free GET route per module — see route-module-map.js
// for the full prefix list this was drawn from. Picked to be read-only
// and side-effect-free so this script is safe to run against a real DB.
const SAMPLE_ROUTE = {
  dashboard: "/report/dashboard-summary",
  reports: "/report/ageing",
  masters: "/clients",
  sales: "/so/list",
  purchase: "/po/list",
  inventory: "/stock-transfer/list",
  assets: "/asset-categories",
  accounts_finance: "/ledger/all",
  payroll_hr: "/hr/employees",
  admin_settings: "/settings"
};

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) return null;
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0]; // "sid=<token>"
}

async function checkRoute(cookie, routePath) {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    headers: cookie ? { Cookie: cookie } : {}
  });
  return res.status;
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);
  let failures = 0;
  let checked = 0;

  for (const role of ROLES) {
    if (role.key === "admin") continue; // trivially allowed everywhere — not interesting to assert on

    const email = `test.${role.key}@yourcompany.test`;
    const cookie = await login(email, PASSWORD);
    if (!cookie) {
      console.warn(`SKIP  ${role.label.padEnd(22)} — couldn't log in as ${email}. Run scripts/seed-test-users.js first.`);
      continue;
    }

    console.log(`${role.label}`);
    for (const mod of MODULES) {
      const routePath = SAMPLE_ROUTE[mod.key];
      if (!routePath) continue;

      const expectedAllowed = getPermission(role.key, mod.key, "view");
      const status = await checkRoute(cookie, routePath);
      const actualAllowed = status < 400;
      checked++;

      const ok = actualAllowed === expectedAllowed;
      if (!ok) failures++;

      const mark = ok ? "  ok " : "FAIL ";
      console.log(
        `  ${mark} ${mod.label.padEnd(26)} expected ${expectedAllowed ? "allow" : "deny "} -> got HTTP ${status}` +
        (ok ? "" : "   <-- MISMATCH")
      );
    }
    console.log("");
  }

  console.log(`${checked} checks run, ${failures} mismatch(es).`);
  if (failures > 0) {
    console.log(
      "\nA mismatch here usually means either: RBAC_ENFORCE isn't set to " +
      "'true' yet (everything reads as allowed, dry-run mode), the module " +
      "hasn't been tightened yet in rbac_rollout (still permissive by " +
      "design during Step 10), or route-module-map.js / permission-matrix.js " +
      "disagree with what you expected — check both before assuming a bug."
    );
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("COVERAGE TEST ERROR:", err.message);
  process.exit(1);
});
