/**
 * RBAC — Step 4: HTTP method -> permission action
 * ==================================================
 * Most routes map cleanly by HTTP verb: GET -> view, POST -> create,
 * PUT/PATCH -> edit, DELETE -> delete. But a chunk of your POST routes
 * aren't "create a new record" at all — they're workflow actions
 * (cancel an order, approve leave, process a payroll run, dispose an
 * asset) that the Step 1 matrix deliberately modeled as a separate
 * `approve` permission, independent of who can `create` in that module.
 *
 * APPROVE_PATH_PATTERNS lists every such route found in server.js /
 * payroll.js today (grep for cancel/approve/reject/close/process/
 * mark-paid/dispose/verify turned these up). If you add a new workflow
 * action route later, add its pattern here too — otherwise it'll
 * silently fall back to being treated as `create`.
 */

const APPROVE_PATH_PATTERNS = [
  /\/cancel(\/|$)/i,      // /work-order/:id/cancel, /po/:id/cancel, /so/:id/cancel,
                          // /depreciation-run/:id/cancel, /hr/payroll/run/:id/cancel
  /\/approve(\/|$)/i,     // /hr/leave-request/:id/approve
  /\/reject(\/|$)/i,      // /hr/leave-request/:id/reject
  /\/close(\/|$)/i,       // /hr/loan/:id/close
  /\/process(\/|$)/i,     // /depreciation-run/:id/process, /hr/payroll/run/:id/process
  /\/mark-paid(\/|$)/i,   // /hr/payroll/run/:id/mark-paid
  /\/dispose(\/|$)/i,     // /asset/:id/dispose
  /\/verify(\/|$)/i       // /asset/:id/verify
];

function resolveAction(method, path) {
  if (APPROVE_PATH_PATTERNS.some(re => re.test(path))) return "approve";

  switch (method) {
    case "GET":
      return "view";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "edit";
    case "DELETE":
      return "delete";
    default:
      return "view";
  }
}

module.exports = { resolveAction, APPROVE_PATH_PATTERNS };
