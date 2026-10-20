# BridgeWise

**An AI-native cross-border money app for international students.**
Topic C — Cross-border & Student Finance Assistant · iCANX Fintechathon · Team Innovative Brothers

An international student lives in two currencies: money arrives from family in one, tuition and rent
are billed in another. Today that means a home bank app, a remittance app, a spreadsheet and a
calendar — and losing money to exchange-rate margins nobody shows them.

BridgeWise is one account for every currency they live in, with an **AI assistant at the centre that
does the work**: it reads their tuition invoice, works out how to pay it, watches the rate, compares
what real banks would charge, and prepares every payment and conversion. **It never moves money
itself** — every action is a card the student approves.

## What it does

| | |
|---|---|
| **Home briefing** | The assistant opens with what matters today: bills due and whether they're covered, how the student's own exchange rate moved this week, alerts that fired, actions waiting |
| **Multi-currency wallet** | GBP, USD, CNY, PKR, INR, EUR and more, one pocket each, valued at live rates; add money, pay, convert with the fee shown before you approve |
| **Statement** | Every movement on every pocket with the balance after it, filterable by pocket and category |
| **Send money** | Save the people you pay (family, landlord, friends) and send to them in their currency at a live rate, on approval |
| **Budget** | Where the money went by category, daily average, how long the wallet lasts, monthly budgets with alerts |
| **Tuition from an invoice** | Paste the invoice. A parser extracts amount, due date, reference and payee; the assistant saves the bill and prepares the payment, refusing anything that breaks the student's living reserve |
| **Compare real providers** | Live quotes from 17 named banks and transfer providers — HSBC, Barclays, NatWest, Wise, Remitly, MoneyGram, WorldRemit… — including the margin hidden in each exchange rate |
| **Markets** | 30-day ECB history for the student's currencies; rate alerts |

## The agent

The assistant has two kinds of tool and only two: **read** (accounts, statement, spending, live rates, rate
history, provider quotes, invoice parsing) and **propose** (convert, pay a bill, send to a saved recipient,
set an alert or budget). It can only send to recipients the student saved themselves, so no message or
invoice can get it to pay a new account. There is no tool that
executes. A proposal becomes an approval card carrying a SHA-256 hash of its exact terms; only the
student's tap executes it, and the server re-checks everything under lock — balance, reserve, the bill,
the payee — before posting a balanced double-entry. A hostile instruction pasted into the chat can at
worst produce a card the student declines.

Runs on Claude (tool use) when `MODEL_API_KEY` is set; otherwise a deterministic **guided** planner
drives the same tools and is labelled as such.

## What is real

| Real, live | BridgeWise's own |
|---|---|
| Exchange rates — European Central Bank (Frankfurter), exchangerate-api | The ledger: double-entry core banking book |
| 30-day rate history — ECB | Balances are test funds in that ledger |
| 17 provider quotes — Wise public comparison | External settlement rails are integration points, not called |

Moving money between a student's own pockets is exactly what a bank does inside its books. What needs a
banking licence is settling externally; that hand-off is marked and stubbed, and a paid bill is reported
as **sent**, not as confirmed by the university.

## Run it

```bash
cp .env.example .env        # DATABASE_URL, SESSION_SECRET; optional MODEL_API_KEY, MODEL_NAME
npm ci
npm run db:migrate
npm run build && npm start  # http://localhost:3000
```

Node 20+, PostgreSQL 17.

## Tests

```bash
npm run test:unit           # 93  — money maths, planner, live-data adapters
npm run test:integration    # 113 — real PostgreSQL: wallet, statement, approvals, concurrency, isolation
npm run test:security       # 37  — attacks the running HTTP API (start the app first)
npm run test:e2e            # 9   — Playwright, desktop and phone
npm run eval:stub           # agent boundary, scripted
npm run eval:live           # agent with a real model (needs MODEL_API_KEY)
```

## Documents

`docs/ARCHITECTURE.md` (start here) · `docs/SECURITY_REPORT.md` · `docs/REVIEW_FINDINGS.md` ·
`docs/AI-DISCLOSURE.md`
