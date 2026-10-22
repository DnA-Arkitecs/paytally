# PayTally

**An AI billing agent for pay-per-result work.** PayTally reads a month of messy work records (a calendar export, a CRM sheet, client emails), applies each client's terms, and drafts invoices where every line says why it is there and which row it came from. The owner approves with one click; only then does anything go to PayPal.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026).

![Ledger review screen](docs/ledger-week1.png)

## Why

Agencies that bill per result (per booked call, per qualified lead, per appointment that actually happens) spend the end of every month reconciling: which calls took place, which were no-shows, which were reported in time, which lead was a duplicate, which line the client disputes. The data is spread across tools, and the terms differ by client. PayTally does that reconciliation and shows its work.

## How it works

1. **Claude reads the log.** `src/extract.js` sends every row, tagged with its reference (`calendar:12`, `crm:5`, `email:E3`), to Claude Opus 5.5 with a strict JSON schema. Claude reports what happened, item by item, with the rows it relied on. When the log can't settle something, it says why instead of guessing.
2. **Code checks the agent.** `src/ledger.js` confirms every row is accounted for, every cited row exists, and no row is billed twice. Anything that fails becomes a flagged line, never a charge.
3. **Code does the money.** `src/terms.js` prices each item under that client's terms (per held call; retainer plus per qualified lead; tiered per consultation with a 48-hour no-show window). Every line gets a plain-English reason naming the clause it applied.
4. **The owner decides.** The AG Grid review screen shows each line with its reason and sources. Flagged lines (a dispute, a missing outcome, an unclear lead) need a click: bill or credit, with a note. Prices re-compute, including tiers.
5. **One click sends.** Approve is the only route to PayPal. The approval is tied to a hash of the exact invoice the owner saw; if a line or a cent changes, PayPal refuses it (`src/approvals.js`, `src/paypal/index.js`).

## Notes for judges

- **The demo always works.** **Read the work log** shows a recorded run: a real Claude Opus 5.5 reading of the demo log, saved in `data/recorded-run.json` and checked against a hand-checked answer key (39 of 40 items match; on the 40th, Claude flagged a row whose status says "Completed" while its note says "NS" and asked instead of guessing). No live API credit is needed to see it working.
- **Run live with Claude** appears when the server has an Anthropic key. It makes a fresh call (about a minute), scores the new reading against the same answer key, and shows the result. If the call fails for any reason (no credit, rate limit, network), the screen says why and falls back to the recorded run.
- **Try the human checkpoint:** open a flagged line (amber), read its sources, choose bill or don't bill, then approve that client's invoice. The **Work log** tab shows every raw row and the ledger line it became, or why it was left out. **Reset demo** at the bottom starts over.

## Run it

Requires Node 20 or later.

```bash
npm install
npm start
```

Open http://localhost:3000 and click **Read the work log**.

- With `ANTHROPIC_API_KEY` set, **Run live with Claude** is available. Without it, the recorded run is shown (or, if the demo data changed since it was recorded, `data/answer-key.json`), and the screen says which.
- PayPal is mocked until `PAYPAL_MODE=sandbox` and sandbox keys are set. The mock keeps invoices locally and sends nothing.

```bash
npm test                 # terms engine, agent checks, fallback, approval guard, Claude request shape
npm run eval             # scores a live Claude reading against the answer key (needs an API key)
npm run eval -- --save   # same, and saves it as the recorded run
```

## Demo data

Everything in `data/` is invented: the agency (Lanternfish Leads), its three clients, every person, and every amount. Emails use the reserved `example.com` domains.

## Status

Week 1 of 3: the ledger, terms engine, review screen and approval guard run locally on the demo data. Next: PayPal sandbox invoicing through the Agent Toolkit (create, send, reminders, paid webhook), dispute replies that cite the source row, and hosting on Render.

## License

MIT. See [LICENSE](LICENSE).
