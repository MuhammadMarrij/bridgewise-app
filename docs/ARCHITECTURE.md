# BridgeWise — product architecture

**An AI-native cross-border money app for international students.**
Topic C · iCANX Fintechathon · judged by WeBank · supersedes the P0–P8 single-flow scope.

---

## 1. The product, as a bank would pitch it

An international student lives in two currencies and three time zones. Money arrives
from family in one currency, tuition is billed in another, rent and food in a third.
Today they juggle a home bank app, a remittance app, a spreadsheet and a calendar — and
lose money in FX margins they cannot see and deadlines they miss.

**BridgeWise is one app with an AI agent at its centre that runs this for them.**
The agent watches their money, warns them before problems happen, compares real
providers, and *does the work* — converting, scheduling, paying — with the student
approving every action that moves money.

### Who it is for
- **Wei**, 20, Chinese undergraduate in London. Parents send CNY monthly. Tuition GBP.
- **Ayesha**, 24, Pakistani master's student in the US. Family remits PKR. Tuition USD.

### What they get

| Module | What the student does | What the agent does |
|---|---|---|
| **Home** | Opens the app | Briefs them: balances, what's due, what changed, what to do |
| **Wallet** | Holds GBP, USD, CNY, PKR, EUR pockets | Values everything at live rates; converts on approval |
| **Tuition** | Pastes or uploads their fee invoice | Extracts amount, deadline, reference; builds a payment plan; schedules it |
| **Send & receive** | Sends money home or asks family for money | Compares 17 real providers live; shows the hidden margin; tracks arrival |
| **Budget** | Sees runway | Forecasts when money runs out; flags overspend; protects the living reserve |
| **FX** | Sets "tell me when CNY/GBP hits X" | Monitors real ECB rates; alerts; shows 30-day history, never predicts |
| **Credit** | New country, no history | Personal checklist to build credit; tracks on-time payments |

---

## 2. What is real and what is not

Stated once, plainly, because judges will ask.

| Real (live, sourced) | Ours |
|---|---|
| FX reference rates — ECB via Frankfurter | The **ledger**: BridgeWise's own double-entry core banking book |
| 30-day FX history — ECB | Account balances are test funds in that ledger |
| 17 provider quotes — named banks and MTOs via Wise's public comparison | External rails (SWIFT, provider APIs) are integration points, not called |
| Fee, rate, margin and landed amount per provider | |
| The AI agent (Claude, tool use) | |

A bank's product *is* its ledger. Moving money inside our own book is not a simulation
of anything — it is exactly what a bank does. What we cannot do without a licence is
settle externally, so those hand-offs are stubbed at a clearly marked boundary.

---

## 3. Architecture

```
┌──────────────────────────── Browser (Next.js, React) ────────────────────────────┐
│  App shell: Home · Wallet · Tuition · Send · Budget · FX · Credit                │
│  Assistant panel (persistent)  ·  Approval cards  ·  Insight feed                │
└──────────────┬──────────────────────────────────────────────┬────────────────────┘
               │ REST (JSON, decimal strings)                  │ agent turns
┌──────────────▼───────────────┐              ┌────────────────▼─────────────────────┐
│  API routes (Zod at the edge)│              │  Agent orchestrator                   │
│  session · origin · rate-lim │              │  Claude tool-use loop (live)          │
└──────────────┬───────────────┘              │  Guided planner (no-key fallback)     │
               │                              │  Read tools  →  facts                 │
               │                              │  Propose tools → ActionProposal       │
               │                              └────────────────┬─────────────────────┘
┌──────────────▼──────────────────────────────────────────────▼─────────────────────┐
│  Domain services                                                                  │
│  ledger · wallet · fx · providers · tuition · remittance · budget · alerts ·      │
│  credit · insights · approvals/execution · audit                                  │
└──────────────┬──────────────────────────────────────────────┬─────────────────────┘
┌──────────────▼───────────────┐              ┌────────────────▼─────────────────────┐
│ PostgreSQL                   │              │ Market data (live, cached)            │
│ double-entry ledger, audit   │              │ ECB rates + history · provider quotes │
│ hash chain, proposals        │              └───────────────────────────────────────┘
└──────────────────────────────┘
```

### The rule that makes it safe

**The agent never moves money.** Every tool it has is either a *read* (balances, rates,
quotes, bills) or a *proposal* (convert X, pay Y, send Z). A proposal becomes an
**approval card** in the UI with the exact terms, hashed. Only the student's tap
executes it, through the existing approval/execution service: terms hash, one-use
nonce, idempotency, per-currency double entry, tamper-evident audit. That's the 30%
security score, and it's already built and tested.

### Data model additions

| Table | Purpose |
|---|---|
| `accounts` (exists) | Becomes **pockets**: one per currency per user |
| `action_proposals` | Agent-proposed action, exact terms, hash, status, expiry |
| `budgets` | Category, monthly limit, currency |
| `rate_alerts` | Pair, direction, threshold, fired-at |
| `insights` | Generated feed items, severity, dismissed-at |
| `credit_tasks` | Checklist items and completion |

---

## 4. The agent

| Tool | Kind | |
|---|---|---|
| `get_overview` | read | balances, total in home currency, upcoming bills, runway |
| `get_fx` | read | live rate + 30-day history for a pair |
| `compare_providers` | read | 17 real quotes for an amount and deadline |
| `get_bills` / `get_budget` | read | |
| `parse_invoice` | read | structured extraction from pasted invoice text |
| `propose_conversion` | propose | wallet FX between pockets |
| `propose_tuition_payment` | propose | pay a bill on a date |
| `propose_transfer` | propose | send money via a chosen provider |
| `propose_alert` / `propose_budget` | propose | low-risk, still approved |

Proactive insights are computed deterministically (deadline in N days, rate moved X%,
runway below Y weeks, spend over budget) and the agent narrates them on Home.

Live model when a key works; guided planner otherwise, labelled.

---

## 5. Milestones

| # | Milestone | Done when | Budget |
|---|---|---|---|
| **M1** | Wallet core: multi-currency pockets, live valuation, conversion through approval | Convert CNY→GBP at a live rate end to end, ledger balanced | 1.5h |
| **M2** | Agent core: tool registry, proposals, approval cards, assistant panel | Agent proposes a conversion from chat; user approves; ledger moves | 2h |
| **M3** | Tuition + Send: invoice parse, real provider compare, scheduled payment | Paste invoice → agent plans → approve → paid | 1.5h |
| **M4** | Home + insights + FX alerts + budget runway | Home briefing generated from real state | 1.5h |
| **M5** | Bank-grade UI shell | Looks and navigates like a banking app | 1h |
| **M6** | Credit builder (lite) | Checklist + on-time tracking | 0.5h |
| **M7** | Tests, evidence, video | Suites green, demo recorded | 1h |

Must-ship: M1, M2, M3, M5. M4 partial acceptable. M6 cut first.

## 6. What is reused

Money maths, ledger and double entry, approval/execution with terms hash and nonce,
audit hash chain, session isolation, origin checks, live FX, live provider quotes,
deadline planner, invoice intake with timezone resolution. The single-scenario
tuition demo screens are retired.
