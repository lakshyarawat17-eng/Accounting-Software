# Deploying this backend to Railway

## 1. Push this `backend` folder to a GitHub repo
Railway deploys from a Git repo. Create a new repo containing just the
contents of this folder (server.js, package.json, accounts.db, invoices/).

## 2. Create the Railway project
1. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
2. Select the repo. Railway will detect `package.json` and run `npm install`
   then `npm start` automatically (no extra config needed).

## 3. (Important) Add a persistent Volume
This app stores data in a SQLite file (`accounts.db`) and generated PDF
invoices on disk. Railway's default filesystem is **ephemeral** — it resets
on every redeploy, which would wipe your accounting data.

To fix this:
1. In your Railway service, go to **Settings → Volumes → New Volume**.
2. Mount it at a path, e.g. `/data`.
3. Add an environment variable:
   - `DATA_DIR` = `/data`

The server will automatically create/read `accounts.db` and the `invoices/`
folder inside that directory instead of the app folder, so your data
survives redeploys.

If you skip this step, the app still works, but a redeploy will reset your
ledgers/invoices back to whatever is committed in the repo.

## 4. Set the frontend URL (for CORS)
Once you've deployed the frontend to Vercel, add this environment variable
on the Railway service:

- `FRONTEND_URL` = `https://your-frontend.vercel.app`

(You can comma-separate multiple URLs, e.g. your production domain and a
preview URL.) If you leave this unset, the API will accept requests from any
origin — fine for testing, but it's more secure to set it once you know your
Vercel URL.

## 5. Get your backend URL
After deploying, Railway gives you a public URL like:

```
https://your-app-name.up.railway.app
```

Copy this — you'll paste it into `config.js` in the frontend project.

## 6. RBAC environment variables

See `.env.example` for the full list with explanations. At minimum, set
on the Railway service:

- `NODE_ENV` = `production` — required for the session cookie to be sent
  as `Secure`/`SameSite=None`, which cross-origin cookies (Vercel frontend
  + Railway backend) need to work at all.
- `RBAC_ADMIN_EMAIL` / `RBAC_ADMIN_PASSWORD` — set **before the first
  deploy** against a fresh database, or a random admin password gets
  generated and printed once to the deploy logs instead.
- `RBAC_ENFORCE` = `true` — only once you've been through the Step 10
  staged rollout (`backend/rbac/README.md` → "Step 10: Staged Rollout").
  Flipping this on cold, against the fully-tightened permission matrix,
  will 403 real staff on day one.

No `SESSION_SECRET` or `JWT_SECRET` is needed — this app's auth
(`rbac/auth.js`) uses random opaque session tokens stored server-side,
not a signed token, so there's nothing to sign or verify with a secret.

Before running any RBAC migration or rollout step against production
data, back it up: `DATA_DIR=/data node scripts/backup-accounts-db.js`
(run from a Railway shell, or locally against the Volume).

## Notes
- `PORT` is provided automatically by Railway; the app already reads
  `process.env.PORT`, so you don't need to set it.
- Local development still works unchanged: `npm install && npm start` runs
  on `http://localhost:3000`.
