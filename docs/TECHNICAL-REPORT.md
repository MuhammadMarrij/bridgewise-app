# BridgeWise — technical report

**Topic C, Cross-border & Student Finance Assistant · Team Innovative Brothers**

Every claim below names the code that implements it or the test that proves it. A claim with
neither does not appear. Where something is not built, or is built but unverified, this report
says so in the same voice it uses for successes.

---

## 1. What it is

BridgeWise helps an international student pay a foreign-currency tuition bill before its deadline
without spending the money they live on, and executes exactly one approved payment that the AI
assistant itself cannot authorise.

It is a **clearly labelled simulation**. No real funds move, no real provider is contacted, no
identity document is collected, and no credit application is made. Every provider, rate, account
and recipient is fictional. That is a product boundary, not an unfinished feature.

### The student's problem

A tuition bill is due in another currency on a fixed date. Several ways to send the money exist.
The cheapest is not always the one that arrives in time, the quoted rate is not the whole cost,
and paying the bill must not leave the student unable to pay rent. Getting that wrong is expensive
in both directions: a late payment risks enrolment, and an over-eager one risks the month.

### What the system actually decides

Given a confirmed obligation, a funding account and a living reserve, it answers one question:
*which supported route pays this in full, on time, without breaching the reserve, at the lowest
total cost?* — and then shows why each rejected route was rejected.

---

## 2. The demonstration scenario

Synthetic throughout. These numbers are the acceptance oracle: the implementation is wrong if it
disagrees with them, not the other way round.

GBP balance 10,000.00 · committed rent 1,200.00 GBP · emergency reserve 2,000.00 GBP ·
net tuition 8,000.00 USD · deadline 23 October 2026, 17:00 America/New_York.

| Route | Rate USD/GBP | Fee GBP | Principal GBP | Total debit GBP | Posts | Outcome |
|---|---:|---:|---:|---:|---|---|
| Simulated A | 1.25 | 10.00 | 6,400.00 | **6,410.00** | after the deadline | Rejected: `MISSES_DEADLINE` |
| Simulated B | 1.25 | 35.00 | 6,400.00 | **6,435.00** | in time | **Recommended** |
| Simulated C | 1.24 | 8.00 | 6,451.62 | **6,459.62** | in time | Feasible, 24.62 dearer |
| Simulated D | 1.26 | 5.00 | 6,349.21 | **6,354.21** | in time | Rejected: `INCOMPLETE_FEES` |

After B: `10,000 − 6,435 − 1,200 = 2,365`, leaving a reserve margin of **365.00 GBP**.

**The two cheapest routes both lose, for different reasons.** A is cheaper than the recommendation
and arrives too late. D is cheaper still and arrives in time, but one of its fees is unknown, so
its all-in cost cannot be stated — and a cost we cannot state cannot be called the lowest. This is
the whole argument of the product in one table.

**The alternative fixture.** With a 9,500.00 GBP balance, B leaves 1,865.00 and breaches the
reserve by **135.00 GBP**. The correct answer is `NO_FEASIBLE_PLAN` with the shortfall stated — not
a quiet reduction of the reserve to make the numbers fit. The user may lower their reserve
deliberately, but that is a new plan and a new approval.

Implementation: `src/lib/domain/fixtures.ts`. Proof: `tests/unit/money.test.ts`,
`tests/unit/planner.test.ts`.

---

## 3. Architecture

One Next.js application, one PostgreSQL database, and two lanes that never meet.

```
  Student browser  (untrusted)
        │
        ├──────────────► Bounded agent loop ──► Five read-only tools ──┐
        │                 (max 6 steps)         (ownership re-checked)  │
        │                                                               ▼
        │                                                  Deterministic finance services
        │                                                               │
        └──────────────► Confirm endpoint ──► Policy + approval ──► Executor
                          (explicit user       (owner, hash,        (one transaction)
                           action, not a        nonce, expiry,              │
                           tool)                reserve, claim)             ▼
                                                                      PostgreSQL
```

The left lane reads, compares and prepares. The right lane is authority: it begins at a control
the user presses, revalidates every term server-side, and is the only path that writes money.

**There is no approve tool and no execute tool.** Not a disabled one — an absent one. The model's
entire capability surface is five functions, listed in §6, and none of them can move money.

### Trust boundaries

| Boundary | What crosses it | What is not trusted |
|---|---|---|
| Browser → API | A session cookie and a route choice | Any amount, fee, rate, beneficiary or "approved" flag |
| API → services | A session id resolved server-side from the cookie | Any id supplied in a body or a tool argument |
| Model → tools | A tool name and arguments | That the tool exists, that the ids belong to this session, that the arguments are the declared ones |
| App → simulator | A transfer id used as the provider key | That our own optimistic write describes what happened |

---

## 4. Money

Amounts are `bigint` minor units. Rates are exact decimal strings converted to a
numerator/denominator pair. **No binary floating point touches money at any point**, and no amount
is ever converted to a JavaScript `Number`. Amounts cross every boundary — JSON, database, UI — as
decimal strings.

```
source_principal = ceil(target_minor × rate_denominator / rate_numerator)
total_debit      = source_principal + source_fee
```

Rounding is **up**, always, so the recipient is never short. A test proves the point rather than
asserting it: one minor unit less than the computed principal would fail to deliver the required
target (`tests/unit/money.test.ts`, "rounds the principal UP, never down").

Parsing is strict and rejects negatives, exponents, thousands separators, bare dots, `NaN`-like
words, excess decimals and values beyond a bounded range. Differing currency exponents are
**rejected rather than assumed away**: `sourcePrincipalFor` throws `EXPONENT_MISMATCH` instead of
quietly applying the two-decimal shortcut that happens to work for GBP and USD.

Implementation: `src/lib/domain/money.ts`.

---

## 5. The planner

Pure, deterministic, and the single authority on what is recommended and why everything else was
not. It touches no database, no clock, no network and no model: the same inputs always produce the
same output. `src/lib/domain/planner.ts`.

**Feasibility is decided on institution posting, not provider delivery.** Money that reaches the
university after the deadline is late money, however promptly the provider delivered it. A route
that delivers in time but posts late is excluded, and a test asserts exactly that distinction.

A route is excluded, with a reason code the interface shows, when it:

| Code | Means |
|---|---|
| `MISSES_DEADLINE` | Latest posting is after the due time |
| `BREACHES_RESERVE` | The projected low would fall below the living reserve |
| `INSUFFICIENT_BALANCE` | The total debit exceeds spendable funds |
| `INCOMPLETE_FEES` | A fee is unknown, so the all-in cost cannot be stated |
| `QUOTE_EXPIRED` | The quote is no longer valid |
| `UNSUPPORTED_CORRIDOR` | The currency pair is not supported |

**Liquidity** walks a dated cash-flow timeline and takes the minimum across the horizon, so a rent
payment three weeks out is counted. Uncertain inflows — a scholarship that might land — are shown
but **excluded from available funds**; a test proves a possible scholarship does not close the
135.00 gap. An existing reservation is counted exactly once, proven by asserting it yields the same
answer as an equally lower balance, which a double-count would not.

**Ranking** is lexicographic: total debit, then earlier posting, then route id. Verified by
reversing the input order and getting the same recommendation.

---

## 6. The agent

One bounded loop, one provider, five tools.

| Tool | Returns | Can it move money? |
|---|---|---|
| `get_financial_snapshot` | Balances, reserves, obligations, the session clock | No |
| `compare_routes` | Recommendation, alternatives, every exclusion with its reason | No |
| `create_payment_proposal` | An immutable plan awaiting the user's approval | No |
| `get_transfer_status` | Stored status of the caller's own transfer | No |
| `get_credit_education` | A reviewed card, or an explicit refusal | No |

No tool takes a user, session or workspace argument, so an invented id reaches nothing. Ownership
comes from the session the server already authenticated. Every schema is strict, so an undeclared
property is a rejected call rather than a silently ignored one. The JSON Schema advertised to the
model is **generated from the same Zod object the server validates with**, so the published
contract cannot drift from the enforced one.

Bounds are enforced by the server, not requested of the model: a step budget, a wall-clock timeout,
bounded input, bounded tool output.

### The test that matters

A stub plays a **fully compromised model** that does exactly what a hostile invoice told it to,
calling `approve_payment` and `execute_transfer`. Both return `UNKNOWN_TOOL`. No money moves. The
system prompt is one layer; the absent surface is the control.
(`tests/integration/agent.test.ts`.)

### Live model status — **not demonstrated**

No `MODEL_API_KEY` is configured in this environment, so **no live model run exists and none is
claimed**. The adapter is implemented against the documented API shape, the tool boundary is fully
tested with a scripted stub, and the route returns an honest `MODEL_UNAVAILABLE` rather than
quietly substituting the stub and presenting it as the assistant. Stub results and live results are
separate populations and are never merged. This is the single largest gap in the submission.

---

## 7. Approval and execution

### Consent is bound to exact terms

The server builds canonical terms — sorted keys, no floats, every material field including the
obligation and beneficiary versions — and hashes them with SHA-256. Change the beneficiary, the
amount, a fee, the rate, the deadline, the reserve or the source account and the hash changes,
which voids the approval.

A hash is an **integrity binding, not a signature and not an authorisation credential**. It proves
the terms did not drift between review and execution. Authority comes from the session plus a
one-use, high-entropy nonce whose hash alone is stored and which is compared in constant time. One
approval per plan, enforced by a unique index. Approval lifetime is the earlier of the quote expiry
and a five-minute window, and it never extends a quote.

### One transaction

Lock order on every money path: **obligation, then source account, then plan**.

Inside one transaction: revalidate everything under the locks, insert the transfer, consume the
approval by conditional update, post the per-currency journal, update the balance, write the outbox
intent, append the audit event. If any part fails, none of it happened. There is no state in which
a balance moved but no transfer exists, or a transfer exists with no dispatch intent.

### The journal

Per-currency double entry. GBP and USD are balanced **independently**; their values are never added
together to claim the journal balances. For the golden payment:

```
  student account   GBP  −6,435.00        fx clearing  USD  −8,000.00
  fx clearing       GBP  +6,400.00        beneficiary  USD  +8,000.00
  fee               GBP      +35.00
  ──────────────────────────────          ──────────────────────────
  GBP total              0.00             USD total          0.00
```

A rejection posts **compensating entries, not deletions**: the journal records what happened,
including what was undone.

### Idempotency and claims

Unique on `(session_id, idempotency_key)` and on `plan_id`. Same key and same payload returns the
existing transfer; same key with a different payload conflicts; a **fresh key cannot pay the same
plan twice**. Twenty concurrent confirmations on one plan, each on its own pooled connection,
produce exactly one transfer and one set of journal entries.

An obligation also has a claim: every transfer against it that has not terminally failed counts
against what may still be paid. This is what stops two separate plans for the same tuition both
executing — a defect that existed and was found in review (`docs/REVIEW_FINDINGS.md` F-01). A second, related defect allowed the PAYEE to be redirected after approval (F-06); execution now re-reads the beneficiary under lock and compares its id, version and reference against the approved terms.
`UNKNOWN_OUTCOME` deliberately still holds its claim, because an unknown outcome might have
succeeded.

---

## 8. Delivered is not paid

Three states, three different facts:

| State | Means | Tuition paid? |
|---|---|---|
| `SUBMITTED` | The provider accepted it | **No** |
| `DELIVERED` | The funds reached the destination | **No** |
| `POSTED` | The institution credited the student's account | **Yes** |

Most prototypes collapse these. We do not, and the interface says what each one does and does not
mean. The obligation is credited **only** at `POSTED`, from settlement, through a uniquely indexed
allocation row that can be written once however many times the status is read.

### Unknown outcomes

The application never promotes its own optimistic write. It asks the simulator what happened. If a
dispatch response is lost, the transfer becomes `UNKNOWN_OUTCOME` and is resolved by asking **under
the original transfer id**, which is also the provider key — never by resubmitting with a fresh
identity. Recovery produces no second provider record and no second transfer.

The simulator is deliberately a separate module with its own table, so that "what happened" is
something we learn rather than something we assume. It absorbs duplicate and out-of-order events,
refuses to post a transfer it never delivered, and never moves a terminal state backwards.

---

## 9. Security controls

| Threat | Control | Where tested |
|---|---|---|
| Model fabricates authority | No approve/execute tool exists | `agent.test.ts` |
| Prompt injection via invoice | Untrusted text is data; the surface is the control | `agent.test.ts` |
| Unapproved execution | One-use nonce, hash match, state check under lock | `execution.test.ts` |
| Stale or altered terms | Hash, plus obligation and beneficiary re-read under lock | `execution.test.ts` |
| Payee redirected after approval | Beneficiary id, version AND reference re-checked at execution | `beneficiary.test.ts` |
| Duplicate payment | Two unique indexes plus a pre-transaction check | `execution.test.ts` |
| Overspending | Account lock and balance recheck | `execution.test.ts` |
| Overpaying tuition | Obligation lock and committed-claim recheck | `overpay.test.ts` |
| Cross-workspace access | Every query scoped by session; not-owned answers like absent | `execution.test.ts`, `api.test.ts` |
| Cross-site mutation | Origin checked on every mutation, including a missing header | `api.test.ts` |
| Secret leakage | Server-only env, redacted audit and evidence, no detail in errors | `api.test.ts` |
| Cost abuse | Per-session and per-client limits on session creation and agent turns | `src/lib/api/http.ts` |

Audit events are append-only **by application discipline and a unique sequence, not tamper-proof**.
A database administrator can still alter rows. An export checksum proves a bundle is internally
consistent; it does not prove everything that happened is in it.

Session isolation is **capability-based for a demo**: a random token in an HttpOnly, SameSite=Strict
cookie, whose hash alone is stored. It is not verified identity, MFA or KYC, and the security
self-assessment says so plainly.

---

## 10. Verification

| Suite | Count | Against |
|---|---:|---|
| Unit | 78 | Pure functions, no database |
| Integration | 67 | **Real PostgreSQL**, overlapping connections |
| Security | 16 | The **running HTTP API**, bypassing the UI |
| **Total** | **161** | 0 failed |

SQLite is not used as a substitute: row locking and transaction isolation are the things under
test, so a substitute engine would make the results meaningless. The security suite **fails rather
than skips** when the app is not running, because a suite that quietly skips is worse than none.

`npm run evidence` drives the live API through the whole journey and makes 23 assertions about what
actually came back, writing `evidence/run-manifest.json`, `evidence/http-trace.jsonl`,
`evidence/audit-export.json` and `evidence/checksums.txt`. Nothing in that bundle is hand-authored.

### Not done

- **Playwright browser tests are not implemented.** The journey was verified manually in a real
  browser, including at 375px with no horizontal scroll. That is weaker evidence and is labelled as
  such rather than counted as an automated pass.
- **No live model run.** See §6.
- **No independent review.** The review in `docs/REVIEW_FINDINGS.md` is a self-review, which shares
  the author's blind spots by construction.

---

## 11. Limitations

Things this prototype is not, stated plainly because a judge will ask:

- Not a payment provider integration. The simulator is ours, and is labelled simulated everywhere.
- Not identity assurance. A session is a capability, not a person.
- Not regulatory compliance. No AML, KYC, PCI DSS, GDPR or banking-licence claim is made.
- Not credit advice. Education is education; eligibility is never inferred from nationality, visa
  or institution. The three education cards currently carry **unverified** citations and are served
  labelled as such until a human opens each URL.
- Not production-ready. Real provider onboarding, jurisdiction review, external settlement
  recovery, operational monitoring and load testing are all absent.
- Two currencies, one executable corridor, four fictional routes. Unsupported cases return a
  visible error rather than a guess.

---

## 12. Reproducing it

```bash
cp .env.example .env     # fill DATABASE_URL and SESSION_SECRET
npm ci
npm run db:migrate
npm run doctor           # must exit 0
npm run dev
```

Then `npm run test:unit`, `npm run test:integration`, and — with the app running —
`npm run test:security` and `npm run evidence`.

Requires Node ≥ 20 and PostgreSQL 17. `npm run purge` deletes expired synthetic sessions and then
verifies that no row outlived its session; it refuses to run against anything but a known demo
database. We do not claim a scheduled cleanup job, because there is not one.
