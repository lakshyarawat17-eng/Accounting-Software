# Deploying this frontend to Vercel

## 1. Point it at your backend
Open `config.js` and replace the placeholder with your real Railway backend
URL (no trailing slash):

```js
const RAILWAY_BACKEND_URL = "https://your-app-name.up.railway.app";
```

Do this **after** you've deployed the backend to Railway and know its URL.
(Locally, on `localhost`, the app automatically uses
`http://localhost:3000` instead, so local testing still works without
touching this file.)

## 2. Push this `frontend` folder to a GitHub repo

## 3. Import it in Vercel
1. Go to https://vercel.com → **Add New → Project → Import** your repo.
2. Framework preset: choose **Other** (this is a plain static HTML site,
   no build step needed).
3. Deploy.

That's it — Vercel will serve all the `.html` files as-is. The site's root
URL (`/`) redirects to `Main Menu.html`, so users can just visit your Vercel
domain directly.

## 4. Update CORS on the backend
Once you have your Vercel URL, add it as `FRONTEND_URL` in your Railway
project's environment variables (see the backend's own deployment README)
so the API accepts requests from it.

## Notes
- The UI/pages themselves were not changed — only how each page talks to
  the backend (via `API_BASE_URL` from `config.js` instead of a hardcoded
  `localhost:3000`).
- If you ever move the backend (new Railway URL), you only need to update
  the one line in `config.js` and redeploy the frontend.
