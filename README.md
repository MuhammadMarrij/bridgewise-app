# BridgeWise

**A multi-currency money app for international students, run by an AI assistant that never moves money without the student's approval.**

Live: **https://bridgewise-azure.vercel.app** · English / 中文
iCANX Fintechathon · Topic C, Cross-border & Student Finance · Innovative Brothers

## What it does
- **Wallet:** one pocket per currency (CNY, PKR, INR, GBP, USD and more), valued at live European Central Bank rates; convert between pockets with the fee shown first.
- **Money in, through real payment rails:** Alipay's own cashier (open-platform sandbox) or a bank card through Stripe (test mode). The wallet is credited only after the provider confirms the payment.
- **Money out, for real:** pay anyone in China into their Alipay account, or move money to your own Alipay, through Alipay's transfer API. Real payouts need the account password again.
- **Bills:** paste a tuition invoice; the assistant reads it and prepares the payment. A payee with an Alipay account is paid for real; otherwise the money is set aside until the bill is paid through the payee's own portal.
- **Compare providers:** live quotes from 17 banks and transfer services, including the margin hidden in each exchange rate.
- **Budget and runway:** spending by category, expenses paid elsewhere, and how long the money lasts.
- **Credit in China:** a step-by-step plan for 征信 (PBOC), 芝麻信用 and 微信支付分. It is a plan, never a score.

## The AI assistant
The assistant runs on Anthropic's Claude with tool use. It has **read** tools (balances, statement, spending, live rates, provider quotes, invoices) and **propose** tools (convert, pay a bill, send, move out, alerts, budgets). It has no tool that executes. Every action becomes an approval card carrying a SHA-256 hash of its exact terms; only the student's approval executes it, re-checked on the server under row locks. It can pay only recipients the student saved, so a hostile message or invoice cannot redirect money.

Live use is capped (lifetime, daily and per-student dollar limits, and a per-answer token ceiling). Past a limit, a deterministic guided planner drives the same tools and the interface says so.

## Run it
Requires Node 20+ and PostgreSQL 17.

```bash
cp .env.example .env      # set DATABASE_URL and SESSION_SECRET; payment and model keys are optional
npm ci
npm run db:migrate
npm run build && npm start   # http://localhost:3000
```

Each payment rail and the live model switch on only when their keys are set in `.env`; see `.env.example`.

## Tests
```bash
npm run test:unit
npm run test:integration    # needs TEST_DATABASE_URL (a database ending in _test)
npm run test:security       # attacks the running server; start it first
npm run test:e2e            # Playwright, desktop and phone
```

## Stack
Next.js 16 and React 19 · TypeScript · PostgreSQL 17 with Drizzle ORM · Zod · Vitest · Playwright · Alipay open-platform SDK · Stripe · Anthropic API. Hosted on Vercel (Singapore) with Neon PostgreSQL (Singapore).

## Status
Payments run in the providers' test environments (Alipay sandbox, Stripe test mode). Going live needs a registered business for merchant contracts and a licensed partner to hold funds; the code paths are already the providers' production APIs.

Built with AI coding assistance (Claude Code); the team defined the product and is responsible for it.
