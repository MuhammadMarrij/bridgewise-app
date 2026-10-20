# BridgeWise — security self-assessment

**Release:** see `evidence/run-manifest.json` for the exact commit
**Environment assessed:** local demo, Node 24.16.0, PostgreSQL 17, `EXECUTION_MODE=SIMULATED`
**Assessed by:** the implementing session. **This is a self-assessment, not an external audit,
and no part of it should be read as certification.**

Control status vocabulary, used strictly:
`IMPLEMENTED_AND_TESTED` · `IMPLEMENTED_NOT_TESTED` · `NOT_IMPLEMENTED` · `NOT_APPLICABLE_WITH_REASON`

---

## 1. Scope and data inventory

| Data | Nature | Where it lives |
|---|---|---|
| Synthetic balances, obligations, transfers | Invented | PostgreSQL, scoped by session |
| Session token | Secret, high entropy | Browser cookie; only its **hash** is stored |
| Approval nonce | Secret, one use | Browser memory for one request; only its **hash** is stored |
| Audit and evidence | Redacted structured records | PostgreSQL, exportable per session |
| Model API key | Secret | Server environment only; absent from any client bundle |

**No real personal data exists in this system.** No identity document, bank credential, card
number or real account is collected, and there is nowhere to put one. The team's registration
workbook, passports and organizer correspondence are deliberately outside the repository and
excluded by `.gitignore`.

---

## 2. Threat model

**In scope:** a hostile user of their own workspace, a hostile document or provider label fed to
the assistant, a hostile site in the user's browser, a user racing themselves across tabs, a
network that drops responses, and a judge poking at the API directly.

**Out of scope, and why:** a malicious database administrator (they can alter audit rows; §9 says
so), a compromised host, a supply-chain attack on a pinned dependency, and physical access. These
are real but unaddressed, and are not claimed otherwise.

---

## 3. Permission tiers

| Tier | Capability | Authority required | Status |
|---|---|---|---|
| P0 | Public education content | None | `IMPLEMENTED_AND_TESTED` |
| P1 | Read own balances, compare, calculate | Active session | `IMPLEMENTED_AND_TESTED` |
| P2 | Save a goal or an immutable proposal | Active session plus validation; no funds move | `IMPLEMENTED_AND_TESTED` |
| P3 | Execute the exact approved payment | Separate user confirmation, one-use nonce, server revalidation | `IMPLEMENTED_AND_TESTED` |
| P4 | Real money, identity documents, credit applications | Not implemented; denied | `NOT_IMPLEMENTED` by design |

The model operates at P1 and P2 only. **It has no P3 capability, because no P3 tool exists.**
The interface may display a tier; the server enforces it.

---

## 4. Controls

| # | Control | Enforced at | Status | Evidence |
|---|---|---|---|---|
| C1 | Session resolved server-side from an HttpOnly, SameSite=Strict cookie; only its hash stored | `services/workspace.ts` | `IMPLEMENTED_AND_TESTED` | `api.test.ts` |
| C2 | Every object query scoped by session; not-owned is indistinguishable from absent | service layer | `IMPLEMENTED_AND_TESTED` | `execution.test.ts`, `api.test.ts` |
| C3 | Origin checked on every mutation, including a missing Origin header | `api/http.ts` | `IMPLEMENTED_AND_TESTED` | `api.test.ts` |
| C4 | Canonical terms hashed with SHA-256; versions of obligation and beneficiary included | `policy/terms.ts` | `IMPLEMENTED_AND_TESTED` | `execution.test.ts` |
| C5 | One-use approval nonce, hash stored, constant-time comparison, one approval per plan | `services/execution.ts` | `IMPLEMENTED_AND_TESTED` | `execution.test.ts` |
| C6 | Approval expiry capped at the earlier of quote expiry and five minutes | `services/execution.ts` | `IMPLEMENTED_AND_TESTED` | `execution.test.ts` |
| C7 | Atomic execution: approval consumption, transfer, journal, balance, outbox, audit in one transaction | `services/execution.ts` | `IMPLEMENTED_AND_TESTED` | `execution.test.ts` |
| C8 | Consistent lock order: obligation, account, plan | `services/execution.ts` | `IMPLEMENTED_AND_TESTED` | concurrency tests |
| C9 | Idempotency on `(session, key)` and uniqueness on `plan_id` | schema + service | `IMPLEMENTED_AND_TESTED` | 20-concurrent test |
| C10 | Obligation claim prevents two plans paying one tuition | `services/exposure.ts` | `IMPLEMENTED_AND_TESTED` | `overpay.test.ts` |
| C11 | Database CHECK constraints for balances, reservations, fee arithmetic, known vocabularies | `drizzle/0001_invariants.sql` | `IMPLEMENTED_AND_TESTED` | migration applied; suite depends on it |
| C12 | Model has no approve, execute, SQL, filesystem, shell or URL tool | `agent/tools.ts` | `IMPLEMENTED_AND_TESTED` | compromised-model test |
| C13 | Strict tool schemas generated from the validating Zod objects | `agent/schema.ts` | `IMPLEMENTED_AND_TESTED` | `agent.test.ts` |
| C14 | Server-enforced step, time, input and output bounds on agent runs | `agent/runner.ts` | `IMPLEMENTED_AND_TESTED` | `agent.test.ts` |
| C15 | Typed, safe errors; no database text, stack traces or secrets in responses | `services/errors.ts` | `IMPLEMENTED_AND_TESTED` | `api.test.ts` |
| C16 | Audit and evidence redaction of token, nonce, secret, key, cookie fields | `services/audit.ts` | `IMPLEMENTED_AND_TESTED` | redaction unit path, evidence bundle |
| C17 | Rate limits on session creation and agent turns | `api/http.ts` | `IMPLEMENTED_NOT_TESTED` | in-process only; see §7 |
| C18 | Operator kill switch checked at approval and at dispatch | `services/execution.ts` | `IMPLEMENTED_AND_TESTED` | `execution.test.ts` |
| C19 | Scenario controls refuse to run in a hosted environment and are session-scoped | `api/demo/simulate` | `IMPLEMENTED_AND_TESTED` | `api.test.ts` |
| C20 | Expired sessions refused at resolve; deletion by explicit command with a cascade check | `workspace.ts`, `scripts/purge.mjs` | `IMPLEMENTED_AND_TESTED` | `npm run purge` output |

---

## 5. Prompt injection

Handled structurally, not by instruction. The system prompt tells the model that documents are
data, but the **control** is that the dangerous capability does not exist.

The test that matters plays a fully compromised model that obeys a hostile invoice and calls
`approve_payment` and `execute_transfer`. Both return `UNKNOWN_TOOL`; no money moves. A claim of
administrator authority in a tool argument is rejected as an undeclared property.

Stored hostile strings (`<img src=x onerror=...>`, oversized references) are rendered by React as
text; no raw HTML is injected anywhere in the application.

---

## 6. Failure and recovery

| Situation | Behaviour |
|---|---|
| Transaction fails | Nothing is written. No partial financial state is reachable. |
| Dispatch response lost | `UNKNOWN_OUTCOME`, resolved by asking under the original id. Never resubmitted with a new identity. |
| Duplicate provider event | Absorbed. Terminal states never move backwards. |
| Provider rejects | Compensating journal entries restore the balance; history is not deleted. |
| Delivered but not posted | Tuition remains unpaid and the interface says so. |
| Model unavailable | Honest `MODEL_UNAVAILABLE`; the deterministic path is unaffected and the stub is **not** substituted. |
| Audit storage unavailable | Financial mutation fails closed; we do not claim a logged operation succeeded. |

---

## 7. Known weaknesses

Stated because they are true, not because they were discovered.

1. **No live model run exists.** The agent is implemented and its boundary is tested, but no
   `MODEL_API_KEY` is configured, so a live run is neither performed nor claimed.
2. **The review is a self-review.** It found one high-severity defect (an obligation could be
   overpaid), but a reviewer who shares the author's blind spots shares their mistakes. An
   independent pass is outstanding.
3. **Audit is append-only by discipline, not tamper-proof.** A database administrator can alter
   rows. Checksums prove a bundle is internally consistent, not that it is complete.
4. **The rate limiter is in-process.** It is enough to stop a demo being used as a free model
   endpoint. It is not distributed and would not survive multiple instances.
5. **Session isolation is a capability, not an identity.** No MFA, no KYC, no verified person.
6. **Education citations are unverified.** The three cards name sources no human has yet opened,
   and are served labelled `UNVERIFIED` until that happens.
7. **Browser tests are not automated.** The journey was checked manually in a real browser.
8. **Local environment**: the PostgreSQL superuser retains the installer's default password and
   the server listens on `0.0.0.0:5432`. Outside the application's controls, but a real weakness
   of the machine this was built on, and it should be corrected before that machine is on an
   untrusted network.
9. **No dependency vulnerability scan** has been run against the pinned lockfile.

---

## 8. What we do not claim

No compliance with GDPR, PCI DSS, AML/KYC or any banking regulation. No penetration test. No
certification. No guarantee of correctness beyond the 159 tests listed, which cover what they
cover and nothing more.

---

## 9. Production gaps

Verified customer authentication · provider onboarding and contracts · supported-corridor
validation · jurisdiction-specific legal review · real consent and identity processes · external
settlement reconciliation · operational monitoring and alerting · secure data lifecycle · incident
response · load and reliability testing. None of these is completed by this prototype, and a
successful sandbox demonstration does not substitute for any of them.
