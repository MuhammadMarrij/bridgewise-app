# BridgeWise: security and compliance self-assessment

Version of 20 Oct 2026, for the release on `master` deployed at https://bridgewise-azure.vercel.app.
Every control below names the code that implements it and the test that attacks it. Claims without
a test are marked as such.

## 1. What is at stake

| Asset | Where it lives | Exposure if lost |
|---|---|---|
| Student balances and statement | PostgreSQL (Neon, Singapore), double-entry ledger | Test funds only today; the ledger's integrity is what a bank would audit |
| Passwords | `users.password_hash`: scrypt N=16384, r=8, p=1, per-user salt | Never stored or logged in clear |
| Session tokens | HttpOnly cookie `bw_session`; the server stores only a hash of the token | 30-day lifetime, rotated on sign-in and sign-out |
| Linked cards | Network, last four and an opaque token only | The full card number and security code are never stored |
| Provider keys (Alipay, Stripe, Anthropic, database) | Vercel environment variables; local `.env` and `secrets/` (gitignored) | Sandbox or test-mode keys, except the database and Anthropic keys |

## 2. Threats and the control for each

| # | Threat | Control | Code | Test |
|---|---|---|---|---|
| S1 | Someone acts without signing in | Every private route calls `requireSession`; sign-up rate limited | `src/lib/api/http.ts` | security: *denies every private endpoint without a session*, *rejects a forged session cookie* |
| S2 | Password guessing / user enumeration | scrypt with constant-time compare; dummy hash for unknown emails gives the same timing and answer; sign-in limited to 5 per minute per email and 20 per address, sign-up to 10 per address | `src/lib/services/auth.ts` | integration: *gives the same answer for an unknown email and a wrong password*, *stores a salted scrypt hash* |
| S3 | Session theft / fixation | HttpOnly, SameSite=Strict, Secure on HTTPS; token rotated on sign-in; sign-out deletes it | `auth.ts`, `http.ts` | security: *sets the session cookie HttpOnly and SameSite=Strict*; integration: *signing out kills the token* |
| S4 | Cross-site request forgery | Origin allow-list on every mutation, including no-Origin requests | `assertSameOrigin` | security: *refuses a mutation from a foreign origin*, *…with no origin header at all*, *refuses a cross-origin approval / top-up* |
| S5 | Reading or spending another student's money | Every query is scoped by session; IDs from other sessions return not-found | services | security: *cannot read or execute another session objects*, *cannot send to another student recipient*; integration: *another student cannot use or remove my linked accounts* |
| S6 | **The AI agent moves money** | The agent has read and propose tools only. No tool executes. A proposal carries a SHA-256 hash of its terms; only the student's approval with that exact hash executes, re-checked under row locks | `src/lib/agent/bank-tools.ts`, `services/wallet.ts` `executeProposal` | security: *a hostile invoice pasted into the assistant cannot execute anything*, *a forged hash moves nothing* |
| S7 | Prompt injection redirects a payment to a new account | The agent can pay only recipients the student saved themselves and cannot add recipients or link accounts | `bank-tools.ts` | security: *cannot send to another student recipient*; integration agent tests |
| S8 | Double charge on retry | Idempotency keys on every money movement; provider credits keyed `provider:out_trade_no` | `money-ops.ts`, `connectors/live.ts` `settle` | security: *a replayed payment with the same key is charged once*; verified live: second Alipay/Stripe confirm replays without crediting |
| S9 | Fake payment confirmation (forged Alipay return URL or notify) | The return URL proves nothing: the server calls `alipay.trade.query` before crediting. Notify requires a valid RSA2 signature and our `app_id`. Stripe credits only when the server retrieves a `succeeded` PaymentIntent whose metadata matches | `connectors/live.ts` | live check: notify with a bad signature returns `failure` / 400; an unpaid PaymentIntent credits nothing |
| S10 | Amount tampering | Amounts are re-derived server-side; client-supplied fees or "approved" flags are rejected by strict Zod schemas | route schemas | security: *rejects an attempt to supply an amount, a fee or an approved flag*; *refuses an overdraft, a negative amount…* |
| S11 | Card data exposure | Card numbers are Luhn and expiry checked, then tokenised; only brand and last four are kept. Stripe card entry happens in Stripe's own frame | `connectors/index.ts`, `app/pay.tsx` | integration: *stores only the token, brand and last four* |
| S12 | Script injection / clickjacking | CSP `default-src 'self'` (plus Stripe's own hosts), `frame-ancestors 'none'`, HSTS preload, nosniff, no-referrer | `next.config.mjs` | live response headers |
| S13 | Abuse of the public site (free database / free model) | PostgreSQL fixed-window rate limits shared across all instances; assistant 15 per minute per student and 40 per address | `http.ts` `rateLimit`, migration 0013 | integration: *counts in the database, so every server instance shares one window* |
| S14 | Accounts nobody signed up for | Legacy anonymous demo endpoints return 404 on the hosted site | `assertLegacyDemoEnabled` | unit: *are absent on the hosted site*; live: `POST /api/demo/sessions` → 404 |
| S15 | Error messages leak internals | Errors map to codes with a correlation ID; no stack traces or configuration | `fail()` | security: *T40 leaks no secret or internal detail in an error*, *health exposes no configuration* |

Totals on the release commit: **262 Vitest tests** (95 unit, 130 integration on a real PostgreSQL,
37 security tests against the running HTTP server) and **10 Playwright journeys** on desktop and phone.

## 3. The agent boundary in one paragraph
The model is untrusted input with good manners. It sees the student's data through read tools and
can produce proposals; it cannot execute, cannot add a payee, cannot link an account and cannot
charge a card. When the live model is unavailable or times out, a deterministic guided planner runs
the same tools and the interface says so. Live operation is recorded per turn (`agent_runs`: mode,
model, tokens, error class); the hosted site's first recorded live turn completed on
`claude-haiku-5-5` on 20 Oct 2026.

## 4. Compliance position (China first)
- **No real funds are held or moved.** Balances are test funds; Alipay runs in the official
  open-platform sandbox and Stripe in test mode. The interface labels both.
- **Stored value, FX and remittance are licensed activities** (PBOC payment licence; SAFE rules and
  the USD 50,000 personal annual FX quota). BridgeWise's production design is non-custodial, built on
  a licensed partner; see `docs/GO_LIVE.md`.
- **Credit:** BridgeWise shows a readiness plan for 征信, 芝麻信用 and 微信支付分 and states on the
  screen that it is not any of those scores. It never claims access to the PBOC Credit Reference Center.
- **Personal information (PIPL):** minimal collection (email, first name, balances you enter). No
  identity documents. Today's database is in Singapore; mainland residents' production data would
  need a mainland region or a cross-border transfer assessment. Not yet built: a self-service
  data export and account deletion.

## 5. Known weaknesses, stated plainly
1. **Keys that passed through a chat transcript during development:** the Neon database password,
   the Stripe test secret key, the Alipay sandbox app private key and an Anthropic key. All will be
   rotated after judging. The Stripe and Alipay keys are test-only and cannot move real money.
2. **Fixed-window rate limiting** allows up to twice the limit across a window boundary.
3. **No Stripe webhook:** a card payment is credited when the page confirms; a closed tab needs a
   retry of the confirm call (which is idempotent).
4. **Sandbox connectors** for WeChat Pay and Chinese banks validate and tokenise but call no bank.
5. **Dependence on third-party public data:** rates (ECB via Frankfurter, exchangerate-api) and Wise
   comparison quotes. When a source fails the interface says the rate is unavailable rather than
   inventing one.
6. The 中文 interface translates the interface text; sentences generated from data (insights and
   guided-mode replies) remain in English.

## 6. What we do not claim
Not a bank; not licensed; not a real 征信 score; no guarantee of any provider's price beyond the
moment it was quoted; no claim that a "sent" bill has been received by the university.
