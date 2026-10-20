# Deploying BridgeWise (Vercel + Neon)

## 1. Neon (database)
neon.tech → sign in with GitHub → **New project** `bridgewise`, region **AWS Asia Pacific (Singapore)**.
Dashboard → **Connection string** → tick **Pooled connection** → copy it (it ends `?sslmode=require`).

## 2. Vercel (website)
vercel.com → sign in with GitHub → **Add New → Project** → import `SylusZephyr/bridgewise`.
Framework: Next.js (auto). Root directory: `./`. Build command: leave default — the repo's
`vercel-build` script runs the database migrations first, then builds.

**Environment variables** (Settings → Environment Variables, all environments):

| Name | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** connection string |
| `SESSION_SECRET` | run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the output |
| `APP_ENV` | `hosted_demo` |
| `EXECUTION_MODE` | `SIMULATED` |
| `MODEL_API_KEY` | your Anthropic API key (optional — guided mode without it) |
| `MODEL_NAME` | `claude-haiku-5-5` |
| `ALIPAY_APP_ID` | Alipay sandbox APPID |
| `ALIPAY_PUBLIC_KEY` | the 支付宝公钥 from the sandbox console |
| `ALIPAY_PRIVATE_KEY` | output of `npm run alipay:key-for-env` (one line) |
| `STRIPE_SECRET_KEY` | `sk_test_…` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` |

Then **Deploy**. The site URL is allowed automatically for requests; add a custom domain to
`ALLOWED_ORIGINS` if you use one.

## 3. Alipay notify URL
After the first deploy, Alipay can call back to `https://<your-app>.vercel.app/api/pay/alipay/notify`.
The app also confirms by querying Alipay when the student returns, so payments credit even before
that is set.

## 4. Check
Open the site → create an account → Add money → Alipay (sandbox) → pay with the sandbox buyer
account → you return to BridgeWise and the CNY pocket is credited.
