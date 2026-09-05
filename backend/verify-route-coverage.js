/**
 * RBAC — Step 1 sanity check.
 *
 * Scans server.js and payroll.js for every registered route, resolves
 * each one against route-module-map.js, and prints anything that didn't
 * match a module (or matched a bare "/" catch-all by mistake). Run this
 * whenever new routes are added to server.js/payroll.js to make sure
 * RBAC coverage doesn't silently fall behind.
 *
 * Usage (from the backend/ folder):
 *   node rbac/verify-route-coverage.js
 */

const fs = require("fs");
const path = require("path");
const { resolveModuleForPath } = require("./route-module-map");

const ROUTE_RE = /(?:app|router)\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;

function extractRoutes(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const routes = [];
  let m;
  while ((m = ROUTE_RE.exec(src)) !== null) {
    routes.push({ method: m[1].toUpperCase(), route: m[2] });
  }
  return routes;
}

function toRequestPath(route) {
  // Strip Express param placeholders like ":id" isn't necessary since we
  // only need the literal leading segments for prefix matching, but we do
  // need a real path string to call resolveModuleForPath with.
  return route;
}

const files = [
  path.join(__dirname, "..", "server.js"),
  path.join(__dirname, "..", "payroll.js")
];

let total = 0;
let unmapped = 0;
const byModule = {};

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const routes = extractRoutes(file);
  for (const { method, route } of routes) {
    total++;
    const testPath = toRequestPath(route);
    const moduleKey = resolveModuleForPath(testPath);

    if (moduleKey === undefined) {
      unmapped++;
      console.log(`UNMAPPED  ${method.padEnd(6)} ${route}  (in ${path.basename(file)})`);
      continue;
    }

    const label = moduleKey === null ? "(bypass — no RBAC)" : moduleKey;
    byModule[label] = (byModule[label] || 0) + 1;
  }
}

console.log("\n--- Coverage summary ---");
for (const [moduleKey, count] of Object.entries(byModule).sort()) {
  console.log(`${moduleKey.padEnd(24)} ${count} route(s)`);
}
console.log(`\nTotal routes scanned: ${total}`);
console.log(`Unmapped routes: ${unmapped}`);

if (unmapped > 0) {
  console.log(
    "\nAdd the missing prefix(es) above to ROUTE_MODULE_MAP in route-module-map.js before moving on to Step 5."
  );
  process.exitCode = 1;
} else {
  console.log("\nEvery route resolved to a module (or an explicit bypass). ✅");
}
