# PROJECT TITAN — Deploying the backend "the right way"

## Why there's a backend at all
A POS app is two halves:

```
[ Android app on the phone ]  ──https──▶  [ Your backend server ]  ──▶  [ Viva ]
        (no secrets)                     (holds the Viva SECRET key,
                                          signs orders, writes the ledger)
```

The Viva **secret key / client secret can never live in the phone app** — anyone
could extract it from the APK and charge cards. So the app always calls *your*
server, and your server calls Viva. Running that server on your PC was only a
test shortcut. The right way is to host it on the internet so the phone reaches
it from anywhere.

---

## Option A — Render.com (recommended, free, ~10 min)

1. **Put the code on GitHub** (once):
   ```bash
   cd D:\PROJECT_TITAN\titan
   git init && git add . && git commit -m "Titan"
   # create a repo on github.com, then:
   git remote add origin https://github.com/<you>/titan.git
   git push -u origin main
   ```
   (`.gitignore` already keeps `.env` + secrets out of the repo.)

2. **Render → New → Blueprint → pick your repo.** It reads `render.yaml` and
   creates the web service + a managed Postgres automatically.

3. **Set the 5 secret env vars** when prompted (they're marked `sync:false`):
   - `DEVICE_JWT_SECRET` → paste the value from `apps/backend/.env` (so the app's
     pre-filled device token keeps working), or set a new one and re-mint a token.
   - `VIVA_MERCHANT_ID`, `VIVA_API_KEY`, `VIVA_CLIENT_ID`, `VIVA_CLIENT_SECRET`
     → from your Viva portal.

4. **Apply.** Render builds, runs the migrations, and starts the API. When the
   health check at `/api/v1/health` goes green you get a URL like
   `https://titan-acquiring.onrender.com`.

5. **In the app** → Viva screen → set **Backend URL** to that `https://…` URL →
   **Test connection** → green → **Create order & pay**. Works from any network.

---

## Option B — Any Docker host (Railway, Fly.io, a VPS)
Use the `Dockerfile`. Provide the same env vars in the platform's dashboard +
a Postgres `DATABASE_URL`. The container migrates on start and serves on `:3000`.

---

## Option C — Fastest test, no deploy (tunnel)
Keep the backend on your PC, expose it with a public HTTPS tunnel:
```bash
# terminal 1: run the backend (after docker compose up -d + migrate)
node --env-file=apps/backend/.env apps/backend/dist/services/bootstrap/main.js
# terminal 2: expose it
npx ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
```
ngrok prints a `https://xxxx.ngrok-free.app` URL → put that in the app. No LAN
IP / firewall needed.

---

## Notes
- **Charge vs order:** order creation + tokenize work over **Basic auth** (verified).
  The direct `/payments` charge over OAuth still needs the OAuth app's **charge
  scopes** enabled in the Viva portal — Smart Checkout (Option A flow) avoids that.
- **Rotate** the Viva secret + API key you shared earlier before going live.
- **Don't go live until** your Viva account + any acquirer/PCI onboarding is done;
  start against Viva **demo** (`demo-api.vivapayments.com`, `demo.vivapayments.com`).
