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

## Notes
- `PORT` is provided automatically by Railway; the app already reads
  `process.env.PORT`, so you don't need to set it.
- Local development still works unchanged: `npm install && npm start` runs
  on `http://localhost:3000`.
