# BridgeWise: technical report

Topic C, Cross-border & Student Finance Assistant · iCANX Fintechathon · Innovative Brothers
Live: **https://bridgewise-azure.vercel.app** · Source: `SylusZephyr/bridgewise` (`master`)

## 1. Problem
An international student lives in two currencies. Money arrives from family in one; tuition, rent
and daily life are billed in another. Students in China also face problems that home-country apps
don't solve: paying with Alipay and WeChat Pay, opening a Chinese bank account, and having no
local credit history (征信) when they arrive. The common result is several apps, a spreadsheet, and
money lost to exchange-rate margins nobody shows them.

## 2. What BridgeWise does
| Feature | What the student gets | Live data / rail |
|---|---|---|
| Multi-currency wallet | One pocket per currency (13 supported: CNY, PKR, INR, GBP, USD, EUR, JPY, KRW…), valued at live rates | ECB via Frankfurter; exchangerate-api |
| AI assistant | Reads invoices, explains rates, compares providers, prepares payments, conversions, transfers and withdrawals; every action is an approval card | Anthropic Claude (`claude-haiku-5-5`), tool use |
| Add money | From a linked card or account, through **Alipay's official sandbox cashier**, or by card through **Stripe** (test mode) | Alipay open platform (RSA2), Stripe PaymentIntents |
| Cards & accounts | Link UnionPay/Visa/Mastercard cards, Alipay, WeChat Pay and Chinese banks (CCB, ICBC, BOC, ABC, CMB) plus home banks | Card validation and tokenisation; sandbox bank connectors |
| Tuition from an invoice | Parses amount, due date, reference and payee; refuses a payment that breaks the living reserve | — |
| Send money | To saved recipients in their currency, compared with what 17 real banks and providers charge | Wise public comparison API |
| Budget | Spending by category, daily average, runway excluding tuition, monthly budgets | — |
| Credit in China | A step-by-step plan for 征信 (PBOC), 芝麻信用 and 微信支付分, some steps detected from the account | Source-backed guidance; never a score |
| 中文 | Whole interface in Simplified Chinese; the live assistant replies in Chinese | — |

## 3. Architecture
```
Browser (Next.js App Router, React 19)
  │  same-origin JSON, HttpOnly session cookie
  ▼
API routes (Next.js on Vercel, region sin1) ── Zod strict schemas, origin check, rate limit
  │
  ├── Agent runner ── model adapter (Claude tool use) │ guided planner fallback
  │       └─ BANK_TOOLS: read_* and propose_* only
  ├── Services: wallet · money-ops · statement · bills · linked · credit · auth · insights
  │       └─ executeProposal: row locks, re-check, idempotent post
  ├── Connectors: sandbox (cards/banks/WeChat) · live.ts (Alipay SDK, Stripe SDK)
  └── Rates: ECB / exchangerate-api / Wise comparison
  ▼
PostgreSQL 17 (Neon, Singapore, pooled) ── Drizzle ORM, 14 SQL migrations
```

### Money
- Amounts are `bigint` minor units with currency-aware exponents (PKR, JPY and KRW have none).
- Rates are exact rationals; `sourcePrincipalFor` and `targetDeliverableFor` convert between them
  without floating point, and are unit-tested.
- Every movement posts a balanced **double-entry** (`ledger_entries`) and a student-facing statement
  line (`wallet_transactions`) carrying the balance after it.
- The conversion fee (0.30%) is shown, in currency, before approval.

### Agent
- Two tool kinds only: **read** (overview, transactions, spending, FX, rate history, live provider
  quotes, recipients, linked accounts, credit plan, invoice parsing) and **propose** (conversion, bill
  payment, transfer, withdrawal, rate alert, budget).
- A proposal stores its terms and their SHA-256 hash. Approval must present that hash; execution
  re-reads balances, the reserve, the payee and the source under row locks before posting.
- The live model's history is bounded (last 10 turns, 4,000 characters each). Each turn is recorded in
  `agent_runs` with mode, model, token counts and error class. On the hosted site the first recorded
  live turn completed on `claude-haiku-5-5` (10,322 input / 242 output tokens).
- If the model is unavailable or times out, the guided planner runs the same tools and the interface
  says "Guided mode".

### Payments
- **Alipay:** official `alipay-sdk`, RSA2 keys generated locally (the private key never leaves the
  server), `alipay.trade.page.pay` to the sandbox cashier. On return the server calls
  `alipay.trade.query` and credits only on `TRADE_SUCCESS` / `TRADE_FINISHED`. The asynchronous
  notify is signature-checked. Verified: an 88.00 CNY sandbox payment credited once; a second
  confirm replayed without crediting.
- **Stripe:** PaymentIntent created server-side with an idempotency key, card entered in Stripe's own
  Payment Element, credit only after the server retrieves `succeeded` with matching metadata.
  Verified: 25.00 GBP credited once; an unpaid intent credited nothing.

## 4. Quality evidence
| Suite | Count | What it runs against |
|---|---|---|
| Unit | 95 | Money maths, planner, rate and provider adapters |
| Integration | 130 | Real PostgreSQL: wallet, statement, approvals, concurrency, isolation, auth, credit, linked accounts, rate limits |
| Security | 37 | The running HTTP server: authentication, CSRF, cross-session access, tampering, injection, replay |
| End-to-end | 10 | Playwright on desktop and phone, including the 中文 switch |

## 5. Limits (see `SECURITY_REPORT.md` §5 and `GO_LIVE.md`)
No real money moves: balances are test funds, and Alipay and Stripe run in their test environments.
WeChat Pay and Chinese bank links are sandbox connectors. Going live requires a business licence and a
licensed partner, not code; `GO_LIVE.md` gives the path stage by stage.

## 6. How it was built
TypeScript end to end, built largely with AI coding assistance under a written specification, test
catalog and review process; see `AI-DISCLOSURE.md`.
