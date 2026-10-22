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
6. **PayPal does the invoicing.** `src/paypal/sandbox.js` calls the official [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit) invoicing tools: `create_invoice`, `send_invoice`, `send_invoice_reminder`, `list_invoices`, `get_invoice`, `cancel_sent_invoice` and `record_refund_for_invoice`. Each line on the PayPal invoice keeps its reason and source rows.
7. **PayPal's webhook marks it paid.** `/api/paypal/webhook` takes `INVOICING.INVOICE.PAID`, `CANCELLED` and `REFUNDED`, checks PayPal's signature with `verify-webhook-signature`, and applies each event once (`src/paypal/webhooks.js`, `src/collect.js`). Nothing in PayTally marks an invoice paid on its own.
8. **Overdue invoices get a reminder.** The **Collections** tab lists every invoice with its PayPal status and the due date from the client's terms (15 days). An overdue one gets a reminder the owner reads first; the approval is tied to that exact text.
9. **Claude answers disputes, the owner decides.** When a client questions a line (**Client replies** tab), Claude finds the line, checks the rows it came from against the terms, cites them, recommends credit or keep, and drafts both replies (`src/replies.js`). Code checks every cited row exists. If the owner credits the line, the terms engine re-prices it and PayPal gets the change through the owner's click: a recorded refund if the invoice is paid, or a cancelled invoice and a corrected one if it isn't.

## Notes for judges

- **The demo always works.** **Read the work log** shows a recorded run: a real Claude Opus 5.5 reading of the demo log, saved in `data/recorded-run.json` and checked against a hand-checked answer key (39 of 40 items match; on the 40th, Claude flagged a row whose status says "Completed" while its note says "NS" and asked instead of guessing). No live API credit is needed to see it working.
- **Run live with Claude** appears when the server has an Anthropic key. It makes a fresh call (about a minute), scores the new reading against the same answer key, and shows the result. If the call fails for any reason (no credit, rate limit, network), the screen says why and falls back to the recorded run.
- **Try the human checkpoint:** open a flagged line (amber), read its sources, choose bill or don't bill, then approve that client's invoice. The **Work log** tab shows every raw row and the ledger line it became, or why it was left out. **Reset demo** at the bottom starts over.
- **Then follow the money.** On a sent invoice, **Client pays (test)** records a test payment in the PayPal sandbox; the card turns paid when PayPal's webhook arrives. **Client replies** brings in a dispute: Harbor & Pine's comes after paying (a credit becomes a refund), Cobalt Dental's before (a credit becomes a corrected invoice). **Collections** has last month's invoice, already overdue, ready for a reminder.
- **Dispute drafts work the same way as the reading:** recorded real Claude drafts by default (both match the hand-checked answer), with **Draft live with Claude** when the server has a key, falling back to the recording if the call fails.
- **Everything PayPal-side is the sandbox,** with invented buyer accounts. No real money moves.

## Run it

Requires Node 20 or later.

```bash
npm install
npm start
```

Open http://localhost:3000 and click **Read the work log**.

- With `ANTHROPIC_API_KEY` set, **Run live with Claude** is available. Without it, the recorded run is shown (or, if the demo data changed since it was recorded, `data/answer-key.json`), and the screen says which.
- PayPal is mocked until `PAYPAL_MODE=sandbox` and sandbox keys (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) are set. The mock keeps invoices locally, sends nothing, and fires its own "webhook" a moment after each payment or refund.
- On a public host, the app registers its own sandbox webhook at startup for `RENDER_EXTERNAL_URL` (set by Render) or `PUBLIC_URL`. Set `PAYPAL_WEBHOOK_ID` to use an existing one. Without a public URL, **Check PayPal now** reads the status directly.

```bash
npm test                          # terms engine, agent checks, fallback, approval guard, webhook handling, full mock flow
npm run eval                      # scores a live Claude reading against the answer key (needs an API key)
npm run eval -- --save            # same, and saves it as the recorded run
npm run eval:replies [-- --save]  # scores Claude's dispute drafts against the hand-checked answers
npm run smoke:sandbox [base URL]  # runs the whole flow against the real PayPal sandbox (local, or a deployed copy)
```

## Deploy (Render)

`render.yaml` is a Blueprint for one web service: build command `npm install`, start command `npm start`. Environment: `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and optionally `ANTHROPIC_API_KEY`. Render's free tier keeps no disk between restarts, so each restart is a fresh demo.

## Demo data

Everything in `data/` is invented: the agency (Lanternfish Leads), its three clients, every person, and every amount. Emails use the reserved `example.com` domains.

## Status

Week 2 of 3: real PayPal sandbox invoicing through the Agent Toolkit, paid by webhook, overdue reminders, and Claude dispute replies that cite the source row, with every credit through the owner's click. Next: the hosted demo, the video and the write-up.

## License

MIT. See [LICENSE](LICENSE).
