# Going live: what turns each sandbox into real money

BridgeWise runs today at **https://bridgewise-azure.vercel.app** against real infrastructure
(Vercel, Neon PostgreSQL in Singapore, Anthropic's API) and real payment rails in their
**test environments** (Alipay open-platform sandbox, Stripe test mode). No real money moves.

That is not a code limitation. Every step from here to real money is a **licence or a contract**,
and none of them can be obtained by a student team in a day. This document says exactly which,
from whom, and what changes in the code when each arrives.

## The licensing reality (China first)

| Activity | Who may do it in mainland China | BridgeWise today |
|---|---|---|
| Accept payments online as a merchant (Alipay 电脑网站支付 / WeChat Pay Native) | A registered **enterprise or individual business (企业 / 个体工商户)** with a signed product contract | Alipay sandbox app, same SDK and signature scheme |
| **Hold** customers' money in a stored-value wallet | A licensed **non-bank payment institution** (PBOC 支付业务许可证) or a bank | Balances are test funds in BridgeWise's own ledger |
| Convert currency for customers / cross-border remittance | Banks and institutions authorised by **SAFE**; individuals are subject to the **USD 50,000 per-person annual FX facilitation quota** | Conversions move between pockets in the ledger only |
| Personal credit reporting | **PBOC Credit Reference Center (征信中心)** and licensed agencies | A readiness plan, never a score |

The consequence for product design: **a student startup should not hold the money.** The
production architecture keeps BridgeWise's ledger as a *view and planning layer* and moves every
real balance into a licensed partner's account that the student owns.

## Path to production, in order

### Stage 1: real money in, BridgeWise as merchant (needs a business licence)
1. Register an individual business (个体工商户) or company in China. Days to weeks.
2. On open.alipay.com, create a **formal app** (not sandbox), sign **电脑网站支付** and **手机网站支付**,
   pass review. Typically a few working days.
3. Code change: none beyond configuration. `ALIPAY_GATEWAY` → `https://openapi.alipay.com/gateway.do`,
   new `ALIPAY_APP_ID`, upload the production public key. `src/lib/connectors/live.ts` already uses the
   official SDK, RSA2 signatures, asynchronous notify verification and a server-side
   `alipay.trade.query` before crediting.
4. Stripe live mode for non-China cards: requires a Stripe-supported country of incorporation
   (for example Hong Kong or Singapore). Code change: swap `sk_test`/`pk_test` for live keys; add the
   webhook in Stage 2.

**Limit:** at this stage a top-up is a payment *to BridgeWise*. Holding it as a student's balance is
exactly what Stage 2 removes.

### Stage 2: stop holding funds (needs a licensed partner)
Pick one licensed partner per corridor and make BridgeWise non-custodial:
- **Wise Platform (partner/OAuth).** The student's own Wise account holds and converts money.
  BridgeWise reads real balances and creates transfers the student approves. Personal API tokens
  can *fund* transfers only for residents of the US, Canada, Australia, New Zealand, Singapore and
  Malaysia. Elsewhere the API creates a **draft** that the student funds in the Wise app.
  A partner agreement (OAuth) is the route for a product.
- **A licensed Chinese payment institution or bank partner** for CNY tuition payments to
  universities, with the partner performing KYC and the cross-border filing.
- Code change: `src/lib/connectors/index.ts` already isolates every external movement behind
  `pull` / `push`; the partner adapter replaces the sandbox connector. The approval cards, terms
  hashes and server-side re-checks are unchanged.

### Stage 3: compliance operations
- KYC / real-name verification through the partner (BridgeWise stores no identity documents).
- PIPL: personal-information processing notice, consent records, data-subject requests (access,
  deletion), cross-border transfer assessment if data leaves China. The database is in Singapore
  today; production data for Chinese residents would move to a mainland region.
- AML monitoring and the SAFE FX quota shown to the student before a conversion.
- Webhooks for Stripe (`payment_intent.succeeded`) so a closed tab still credits.

## What is already production-grade
- Money is integer minor units with exact rational rates; double-entry ledger; idempotent execution.
- The agent can read and propose only. Execution needs the student's approval of a SHA-256 terms
  hash, re-checked under row locks.
- Providers are credited only after the server asks the provider (never on a browser redirect).
- Passwords use scrypt; sessions are HttpOnly, SameSite=Strict; strict CSP and HSTS; rate limits
  are shared across instances in PostgreSQL.

## Sources
- Wise personal tokens and regional funding limits: https://docs.wise.com/api-docs/features/authentication-access/personal-tokens
- Wise countries: https://wise.com/help/articles/2978049/which-countries-can-i-use-wise-in
- Alipay sandbox and gateway: https://open.alipay.com/develop/sandbox/app
