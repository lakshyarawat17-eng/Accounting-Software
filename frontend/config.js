// ============================================================
// BACKEND API CONFIGURATION
// ============================================================
// This file tells every page where to find your backend API.
//
// - While testing on your own computer (localhost), it points
//   at your local backend (http://localhost:3000).
// - Once deployed, it points at your Railway backend URL.
//
// >>> AFTER YOU DEPLOY THE BACKEND TO RAILWAY, PASTE ITS URL BELOW <<<
// It looks like: https://your-app-name.up.railway.app
// (Do not include a trailing slash.)
// ============================================================

const RAILWAY_BACKEND_URL = "https://your-app-name.up.railway.app";

window.API_BASE_URL = (function () {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  return isLocal ? "http://localhost:3000" : RAILWAY_BACKEND_URL;
})();
