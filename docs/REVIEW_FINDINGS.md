# Review findings

**Reviewed commit:** `d4e763f` and the working tree that followed it
**Reviewer:** the implementing session, acting as its own reviewer
**Environment:** Windows 11, Node 24.16.0, PostgreSQL 17 (native), real database for every
integration and security test

> **Read this limitation first.** This is a self-review, not an independent one. The author of a
> change is the worst person to judge it, and a reviewer who shares the author's blind spots will
> share their mistakes. The findings below are real and were found by attacking the code, but a
> genuinely independent pass by Codex or a second person is still outstanding and is the single
> most valuable remaining review activity. Nothing here should be read as "the code was reviewed
> and found sound".

## Method

Rather than re-reading the code approvingly, each review item started from a question of the form
"what would have to be true for this to be broken?", then a test was written to try to make it
break. A finding counts only where a test actually failed first.

---

## F-01 · HIGH · An obligation could be overpaid · FIXED

**Where:** `src/lib/services/execution.ts`, the obligation check inside the execution transaction.

**What was wrong.** Outstanding tuition was computed from SETTLED credit only, that is from
`obligation_allocations`, which are written at POSTED. A transfer that had been submitted but not
yet posted had credited nothing, so it did not reduce the outstanding amount. Two separate plans
for the same tuition therefore both passed the check and both executed.

**Trigger.** Create two plans for one obligation, approve both, confirm both. The account balance
was the only thing stopping it, so with sufficient funds the tuition was paid twice.

**Observed before the fix:** both confirmations fulfilled, two transfer rows, both able to post,
16,000.00 USD credited against an 8,000.00 USD obligation.

**Expected:** at most one payment in flight against an obligation.

**Fix.** `src/lib/services/exposure.ts` adds `committedCreditMinor`, which counts every transfer
against the obligation whose status is not terminally failed. The execution transaction, which
already holds the obligation row lock, now refuses a payment that would exceed what is unclaimed.
`UNKNOWN_OUTCOME` deliberately still counts: an unknown outcome might have succeeded, and the safe
reading of "we do not know" is that the money may well be on its way.

**Regression:** `tests/integration/overpay.test.ts` — sequential case, concurrent case, plus the
release cases proving a REJECTED transfer frees the claim and an UNKNOWN_OUTCOME does not.

**Note on why the existing tests missed it.** The concurrency test that did exist checked that two
plans could not overspend the ACCOUNT. It passed for the wrong reason: the balance ran out first.
Testing the same scenario with a funded account is what exposed the real defect. A passing
concurrency test is not evidence that the invariant you care about is the one being enforced.

---

## F-06 · HIGH · The payee could be redirected after approval · FIXED

**Where:** `src/lib/services/execution.ts`, the revalidation inside the execution transaction.

**What was wrong.** The canonical terms contain the beneficiary id, its version and its reference,
and the terms hash covers all three. But the execution path only re-read the OBLIGATION and
compared its version. It never re-read the beneficiary. Editing the payee after the user approved
therefore did not void the approval, and the payment went through to the edited recipient.

**Why the hash did not save it.** The hash proves the stored terms have not changed. It says
nothing about whether the world those terms describe has changed. Binding consent to a snapshot is
only half the control; the other half is re-reading the underlying rows and checking they still
match the snapshot. The obligation half was implemented and the beneficiary half was not.

**Trigger.** Create a plan, approve it, update `beneficiaries.reference` to another account,
confirm. The transfer executed and reported SUBMITTED.

**Severity.** High, and arguably the most serious possible defect in a payments system: the user
consented to paying their university and the money would have gone somewhere else. It defeats the
product's central claim.

**Fix.** The beneficiary row is now locked immediately after the obligation, keeping the lock order
deterministic, and execution refuses unless the id, the version AND the reference itself all still
match the approved terms. The reference is compared directly and not only through its version,
because an attacker able to edit the row can also decline to increment the counter.

**Regression:** `tests/integration/beneficiary.test.ts` — a redirect with the version bumped, and
a silent redirect with the version left alone.

**What this says about the earlier review.** F-01 and F-06 are the same mistake in two places:
trusting a value captured at planning time instead of re-reading it under lock at execution time.
Finding the first should have prompted an immediate sweep of every other field in the terms. It
did not, and the second defect survived another review pass. Every remaining field in
`CanonicalTerms` has now been walked: amounts, fees, rate and expiry come from the quote row,
which is immutable once written; account ownership is re-checked; policy version and execution mode
are process-level.

---

## F-07 · LOW · A tool omitted a fact users ask for · FIXED

**Where:** `src/lib/agent/tools.ts`, the `compare_routes` result.

**What was wrong.** The tool returned the reserve MARGIN but not the projected LOW balance. The
interface showed both; the agent could see only one. Asked "how much will I have left afterwards?"
the model had no grounded way to answer, and the only way to produce a number was to invent one.

**How it was caught.** Not by reading the code. Evaluation case E05 asserts that any figure in the
answer appears in a tool result, and it failed on exactly this: `2365.00` was not grounded
anywhere. The test was right and the tool was wrong.

**Why it matters more than its severity suggests.** A tool that omits a fact the user will
predictably ask for is a hallucination waiting to happen. The prompt tells the model never to
invent a figure; if the tools cannot supply one it needs, the instruction and the capability are
in conflict, and prompts lose those arguments.

**Fix.** `compare_routes` now returns `projectedLow` for the recommendation and for every
alternative. E05 passes, and the stub evaluation is 24/24.

---

## F-02 · MEDIUM · A CHECK constraint compared two different clocks · FIXED

**Where:** `drizzle/0001_invariants.sql`, constraint `quotes_expiry_after_creation`.

**What was wrong.** The constraint compared `expires_at`, which is derived from the SESSION clock
and is a scenario instant in a demo session, against `created_at`, which is real server time.
Those are different clocks and comparing them is meaningless. A scenario pinned in the past made
every quote insert fail.

**Fix.** `drizzle/0002_quote_clock.sql`. Quotes now carry `quoted_at` in the same clock as their
expiry, and the constraint compares like with like. `created_at` remains as the real-time record
of when the row was written, so evidence can show both.

**Regression:** every planning test exercises it; the whole integration suite fails without it.

---

## F-03 · MEDIUM · An absent model credential reported as configured · FIXED

**Where:** `scripts/doctor.mjs`, the `.env` parser.

**What was wrong.** A value consisting only of a trailing comment, which is exactly how
`.env.example` documents `MODEL_API_KEY=`, parsed as the comment text rather than as empty. The
doctor therefore reported `MODEL_API_KEY` as "set" when it was absent — hiding the one external
blocker the project is tracking.

**Fix.** Comment stripping handles a comment-only value, and optional variables now report WARN
when absent instead of PASS, so a reader scanning the report cannot see PASS beside "not set".

**Regression:** `tests/unit/env-parse.test.ts`.

---

## F-04 · MEDIUM · Unverified citations presented as reviewed sources · FIXED

**Where:** `src/lib/content/credit-education.ts`.

**What was wrong.** The education cards were written with named publishers, URLs and review dates,
but nobody had opened those URLs. That is precisely the fabricated-citation failure the project
forbids, committed by the project itself.

**Fix.** Every source now carries `verified: false` until a human opens the exact URL and confirms
it supports each point. The tool serves the card labelled `UNVERIFIED` and instructs the model to
say so. `unverifiedCards()` reports them, and the release gate treats a non-empty result as
blocking.

**Still open:** the verification itself. See O-01.

---

## F-05 · LOW · Two test files truncated each other's database · FIXED

**Where:** `vitest.config.ts`.

Integration files share one PostgreSQL database and truncate between tests, so running them in
parallel produced failures that looked like application bugs. `fileParallelism` is now off. Worth
recording because a flaky suite teaches a team to ignore red, which is more dangerous than the
flake.

---

## Checked and found sound

Each of these was attacked with a test that tried to break it, not merely read.

| Property | How it was attacked |
| --- | --- |
| Exact arithmetic | Golden figures asserted from the brief, independently of the implementation; ceiling rounding checked by proving one minor unit less would under-fund the bill |
| No unapproved execution | Confirm with no approval, with a forged nonce, with another session's nonce |
| Consent bound to exact terms | Altered hash, bumped obligation version, expired approval |
| One-use approval | Second confirmation with a fresh idempotency key on the same plan |
| At-most-once under load | 20 concurrent confirmations on one plan, each on its own pooled connection |
| No double debit across plans | Two plans racing one balance |
| Workspace isolation | Cross-session read, plan, approve, confirm, evidence export, and scenario control, over both the service layer and raw HTTP |
| Not-owned indistinguishable from absent | Error code and message compared between the two cases |
| Cross-origin mutation | Foreign origin and missing origin header on plan and confirm |
| Model cannot pay | A stub playing a fully compromised model that calls `approve_payment` and `execute_transfer` exactly as a hostile invoice told it to |
| Undeclared properties | `sessionId`, `approved`, `totalDebit` injected into tool args and request bodies |
| Delivered is not paid | Obligation credit asserted at SUBMITTED, at DELIVERED, and only then at POSTED |
| Unknown outcome recovery | Status forced to UNKNOWN_OUTCOME with the outbox reopened; recovery produced no second provider record and no second transfer |
| Rejection refund | Compensating entries, not deletions; per-currency journal still sums to zero |
| Secrets in responses | Error bodies and health checked for connection strings, keys and stack traces |

---

## Open items, not defects

| ID | Item | Severity | Status |
| --- | --- | --- | --- |
| O-01 | The three credit-education citations are unverified | blocks the education claim only | A human must open each URL and set `verified: true`. Until then the feature is honest but weak. |
| O-02 | No live model run exists | blocks the live-agent claim | No `MODEL_API_KEY` is configured. The agent is implemented and its boundary is tested; a live run is not claimed. |
| O-03 | No independent review | process | A second reviewer should repeat this pass. A self-review shares the author's blind spots by construction. |
| O-04 | A plan can be created while another payment is in flight | low | Creating a plan moves no money and confirmation refuses it, but the interface could warn earlier. Cosmetic, not a safety issue. |
| O-05 | One approval per plan, so an expired approval cannot be re-approved | low | The user creates a fresh plan instead. Safe, slightly awkward; documented rather than changed this close to a deadline. |
| O-06 | Session expiry is enforced at resolve time; deletion is a manual command | documented | `npm run purge` deletes expired sessions and verifies nothing outlived its session. We do not claim a scheduled job, because there is not one. |
| O-07 | Local PostgreSQL keeps the installer's default superuser password and listens on 0.0.0.0 | environment | Outside the application's controls; belongs in the deployment section of the security report. |
| O-08 | The rate limiter is in-process | documented | Enough to stop a demo being used as a free model endpoint. Not a distributed limiter, and not described as one. |

---

## Gate decision

**PASS for the scope tested**, with O-01 to O-03 outstanding. Two HIGH-severity defects were found and fixed during this phase (F-01, F-06); both were the same underlying mistake of trusting a planning-time value at execution time.

No release-blocking defect is open. Every money, consent, isolation, idempotency and reconciliation
test passes against a real PostgreSQL instance. The two claims not supported by evidence — a live
agent run, and verified education citations — are recorded as unresolved rather than asserted.

**Results at the time of writing:** 78 unit, 67 integration, 16 security, 11 browser, 24 stub
evaluation cases. 196 passed, 0 failed. Live evaluation: BLOCKED, no credential.
Browser tests: 11 Playwright cases on desktop and phone against a real build.

# Codex review and repairs — 20 October 2026

Reviewed baseline: `0f84063cdb2ca03269edd8372d13e97975a84c04`.
Working branch: `codex/review-hardening`. Claude was paused by the user; Codex made the repairs.
The earlier self-review above is historical and does not certify this revision.

## F-08 · HIGH · Execution omitted future rent · FIXED
R04, execution.ts. Plan/approve at GBP 10,000, then reduce the balance to 9,500 before confirming.
Actual before repair: the transfer executed, leaving GBP 1,865 after rent, below the 2,000 reserve.
Expected: refuse before debiting. The executor now reuses the planner's dated liquidity calculation
under the account lock. Reproduction: review.test.ts, `rechecks rent` (failed before, passes after).

## F-09 · HIGH · Mutable quote bypassed exact consent · FIXED
R06, execution.ts. Approve GBP 6,435, update the quote fee to GBP 45 and total debit to 6,445.
Actual: the executor debited 6,445 using the original approval. The claim that quotes were immutable
was not enforced by PostgreSQL. Expected: TERMS_CHANGED. Execution now compares the current quote,
related ownership/currencies, obligation terms and policy to the approved snapshot under locks.
Reproduction: review.test.ts, `quote fees changed` (failed before, passes after).
This test models internal data drift; no public quote-edit endpoint was found.

## F-10 · MEDIUM · Model status reads reached dispatch · FIXED
R10, agent/tools.ts. Interrupt simulator submission before acceptance, leaving a pending outbox.
Call get_transfer_status through runTool. Actual: the supposedly read-only tool submitted it.
Prior user approval still existed; this was not a demonstrated unapproved debit.
Expected: status tool reads stored state only. Added storedTransferStatus; HTTP/user recovery retains
outbox draining. Reproduction: review.test.ts, `model status reads` (failed before, passes after).

## F-11 · HIGH · Stale reconciliation could reverse POSTED · FIXED
R08/R09, execution.ts and simulator.ts. Capture a DELIVERED provider observation, reconcile a newer
POSTED observation, then return the delayed delivery observation to a stale reader.
Actual: application state reverted to DELIVERED even though credit was allocated.
Expected: terminal state remains POSTED. Reconciliation now locks in execution order and re-reads
current state; simulator transitions also serialize, preventing competing deliver/reject outcomes.
Reproduction: review.test.ts `delayed DELIVERED` (failed before, passes after).
Additional regression: competing delivery/rejection permits only one successful transition.

## F-12 · MEDIUM · Invalid and ambiguous deadlines were accepted · FIXED
R01/R04, intake.ts. Inputs February 30, a New York spring-forward gap (2027-03-14 02:30), and a
repeated autumn hour (2026-11-01 01:30) all returned an instant instead of refusing ambiguity.
Expected: reject invalid calendar values and non-unique local times. Parsing now round-trips the
calendar and checks candidate offsets on both sides of the transition. Three regressions failed
before repair and pass after. Ordinary New York, Kolkata and Shanghai cases remain green.

## F-13 · MEDIUM · An unavailable model passed live evaluation cases · FIXED
R13, scripts/eval.ts. Run eval:live with the configured environment returning HTTP 403.
Actual: 5/8 cases passed although all model calls were unavailable. Expected: no model-behavior
success claim without a completed response. Every case now defaults to expected COMPLETED unless
it explicitly tests another status. Re-run: 0/8, BLOCKED; token usage null, not fabricated zero.
No conclusion about account billing or validity of the key follows from HTTP 403.

## F-14 · MEDIUM · Approval/cancellation lacked serialization · HARDENED
R06/R08, planning.ts and execution.ts. Both paths previously read then updated plan state without
holding a lock across their decision, allowing stale writes in a race. Approval and cancellation
now lock the plan within a transaction. Tests race approval/cancel and execute/cancel, assert
cancellation cannot resurrect or falsely cancel a sent plan. These tests were added after the
repair; no claim of an observed baseline failure is made. Denial audit runs outside rollback.

## F-15 · MEDIUM · One tool batch bypassed the agent step budget · FIXED
R10, runner.ts. A single model turn could contain arbitrarily many tool calls because only model
turns were counted. The runner now bounds total tool calls as well as turns and checks the abort
signal between tools. Regression: one response with 100 snapshot calls stops at the configured
budget. A DB operation already in progress is not forcibly cancelled; no hard DB timeout is claimed.

## F-16 · HIGH · User-entered bills were not the browser's active payment · FIXED
R01/R04/R12, page.tsx and intake endpoint. Enter `4200` with a padded reference, save and confirm.
Actual: confirmation failed because the UI echoed raw input instead of normalized server fields.
Even with canonical input, compare/propose still addressed obligations[0], the seeded USD 8,000 bill.
Expected: show/confirm normalized values and plan the selected custom bill. The intake response now
returns normalized details and the page retains the newly confirmed obligation ID for both paths.
Regression: browser journey enters 4200, confirms, selects A at GBP 3,370 and executes that bill.
The baseline confirmation failure was observed in Playwright before repair.

## Review scope and limitations

Inspected canonical terms, execution, obligation exposure, simulator, intake, all five agent tools,
HTTP guards and evaluation scripts. Existing tests cover 20 concurrent confirmations, cross-session
IDs, nonce tampering, unknown outcomes, duplicate posting and refunds. UNKNOWN_OUTCOME must retain
its claim: releasing it would allow a second payment before the first is known to have failed.
A permanently unavailable real provider would need an operator resolution procedure; this project
has only its local simulator and does not claim production recovery.

CFPB source verification and the broken original link are recorded in SOURCE_REGISTER.md. The
unverified-source test now explicitly supplies an unverified fixture, preserving that control.
No hosted deployment, organizer submission or credential rotation was performed. No security
certification, exhaustive vulnerability claim or second-machine clean-clone result is implied.

Gate: PASS for the tested local simulation after repair; live-agent evidence remains BLOCKED.
Final command outcomes and the delivery commit are recorded in HANDOFF.md / git history.
