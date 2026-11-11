# Devpost submission: PayTally

Every field for the PayPal AI Hackathon form, ready to paste. Claims about the builder come from his fact bank; every company, person and amount in the demo is invented. Items marked **(after upload)** wait on the YouTube link.

## Project name

PayTally

## Elevator pitch (200 characters max)

AI billing for pay-per-result work: Claude reads the messy month, code prices it, the owner approves, PayPal invoices, and the client's own AI agent disputes and pays over MCP.

## Try it out (links)

- https://paytally-wyzc.onrender.com (live demo, no sign-in; the free host takes about 30 seconds to wake)
- https://paytally-wyzc.onrender.com/studio.html (collections dashboard)
- https://github.com/DnA-Arkitecs/paytally (code, MIT license)

## Video demo link

**(after upload)** The public YouTube link.

## Built with

claude, claude-api, anthropic, claude-code, paypal, paypal-agent-toolkit, paypal-invoicing, paypal-webhooks, paypal-vault, paypal-orders-api, paypal-payments-api, model-context-protocol, mcp, ag-grid, ag-studio, render, node.js, express, javascript, zod

## About the project

### Inspiration

Anyone paid per result bills from scattered records: lead-generation and appointment-setting agencies, recruiters, performance marketers, freelancers paid per milestone. Each client has different terms, and the proof sits in a calendar, a CRM and an inbox. Month-end means counting by hand, and the count is where the money leaks.

I built and run an outbound system that has booked 2,424 meetings for 14 financial advisors since October 2025. Advisors pay per meeting or share revenue, so every month someone has to count what's billable. One month the count on file was 531. Twenty-four were test bookings. The real number was 507. Billing was the messiest step in the business, so I built the agent I wanted.

On one real week of my own bookings (Oct 12–18, 2026), PayTally read all 96 and matched 15 of 15 billable meetings to my records at the right price, and flagged 1 for my review.

### What it does

1. **Claude reads the month.** A calendar export, a CRM sheet and client emails go to Claude Opus 5.5, which says what happened in each case and cites the rows it relied on. When the log can't settle something, it flags it instead of guessing.
2. **Code checks the agent and does the money.** Every row must be accounted for, every cited row must exist, nothing is billed twice. A terms engine prices each line under that client's terms and writes the reason in plain English.
3. **The owner decides in an AG Grid ledger.** Lines are grouped by client; each one opens its source rows inside the grid. Flagged lines wait for a bill or don't-bill click (keys N, B, D move through them).
4. **One click sends, through PayPal.** Approve is the only route to PayPal, and it is tied to a hash of the exact invoice the owner saw. PayPal's Agent Toolkit creates and sends the invoice; PayPal's webhook, never PayTally, marks it paid.
5. **The client's own AI agent settles over MCP.** PayTally is also an MCP server. The client's agent connects with a token that sees only its own bill and gets six tools: read the bill, ask for the proof behind a line, dispute, check the dispute, ask to pay, check the payment. It cannot change a price, give itself a credit or move money.
6. **PayTally's agent rules on the dispute; the owner clicks the credit.** Claude checks the dispute against the log and the terms, cites rows and recommends credit or keep. A credit reaches PayPal only through the owner's click: a refund of the card capture if the invoice is paid, a cancelled invoice and a corrected one if not.
7. **The client's human approves the exact payment.** The agent asks to pay; its human approves the amount with one tap; PayPal charges the card saved in its Vault. The spending cap the human set ($2,000 in the demo) is enforced in code, not in the prompt.
8. **Collections.** Overdue invoices get a reminder the owner reads first, sent through PayPal. An AG Studio dashboard shows billed, at stake, owed and money moved, with a Claude assistant that answers from the same numbers.

### How PayPal is used (sandbox, real API calls)

- **PayPal Agent Toolkit** invoicing tools: `create_invoice`, `send_invoice`, `send_invoice_reminder`, `list_invoices`, `get_invoice`, `cancel_sent_invoice`, `record_refund_for_invoice`. Each invoice line keeps its reason and source rows.
- **Webhooks:** the app registers its own sandbox webhook at startup and verifies every event with `verify-webhook-signature`. An invoice changes status only when PayPal says so: on the hosted demo, through its invoice paid, cancelled and refunded events and card capture events, each applied once.
- **Vault v3:** the client's card is saved with a setup token and a payment token.
- **Orders v2:** an approved payment is a merchant-initiated charge on the saved card, captured at once.
- **Payments v2:** crediting a paid line refunds that capture, and the refund is recorded on the invoice.
- **Idempotency:** every money call carries a `PayPal-Request-Id`, so a retry can never charge or refund twice.

### How AI is used, and the AI tools

- **Claude Opus 5.5 (Claude API)** does four jobs in the product: it reads every row of the work log into structured findings with a strict JSON schema; it rules on each dispute (credit or keep, citing rows) and drafts both replies; it plays the client's agent, calling PayTally's MCP tools; and it powers the AG Studio dashboard's assistant through a server-side adapter, so the key never reaches the browser.
- **Model Context Protocol** (official TypeScript SDK, Streamable HTTP): the door for any client's agent. Any MCP client can connect; the connect line is on the Client's AI agent tab.
- **Claude Code** built the app at my direction: the code, the tests and the evals. I decided what each part must do, set the checks it had to pass, and tested it against my own real records.
- **Measured, not assumed:** Claude's reading matches a hand-checked answer key on 39 of 40 items (the 40th it flagged instead of guessing); its dispute drafts pick the right line and the right call 2 of 2; the two-agent settlement passes 7 of 7 checks. The demo replays these recorded real Claude runs by default, so it works for every judge even after live credit runs out; "Run live with Claude" makes a fresh call and falls back to the recording if it fails.

### How I built it

Node 20 and Express 5, AG Grid Community 36 and AG Studio, the MCP TypeScript SDK, the PayPal Agent Toolkit and PayPal's REST APIs, and the Claude API. It is hosted on Render from a one-file Blueprint (`render.yaml`) and redeploys on every push; the app registers its PayPal webhook from Render's public URL. 24 automated tests cover the terms engine, the approval guard, webhook handling, the MCP mandate, the two-agent settlement and per-judge demos. First commit: October 22, 2026, inside the submission period.

### Challenges I ran into

- **The Agent Toolkit drops PayPal's payment term,** so PayTally sets each due date itself (15 days, from the client's terms).
- **PayPal's sandbox refused one of its own published test cards** (PAYER_CANNOT_PAY), so the demo uses another.
- **An early settlement run kept a charge** that the client's text message showed was a no-show, because the text wasn't in the log. PayTally's agent now treats a call or text as outside the log and tells the owner what to check.
- **Testing the hosted demo as a second judge would** showed every refund after the first one failing: the refund's `PayPal-Request-Id` repeated across demo runs, and PayPal never forgets one. The id now names the card capture it refunds, and a test runs the refund twice.
- **Many judges, one public server.** Each browser now gets its own demo, so nobody sees or resets someone else's run; PayPal's webhook finds the demo that owns its invoice, and the client agent's token carries its demo.

### Accomplishments that I'm proud of

Two companies' AI agents settle a real bill end to end in the PayPal sandbox: one disputes, the other rules, a person approves every dollar, and PayPal moves the money. On one real week of my own bookings, it matched 15 of 15 billable meetings.

### What I learned

The model is excellent at reading messy records and explaining itself; code has to own the money; and a person has to own each decision that moves it. Scoping an agent by its token, rather than by its prompt, is what makes it safe to let another company's agent in.

### What's next for PayTally

Run it on my own month-end, connect calendars and CRMs directly instead of exports, move from the sandbox to live PayPal, and let each client issue its agent a token and a spending cap of its own.

## Testing instructions (for judges)

1. Open https://paytally-wyzc.onrender.com (no sign-in, no keys; the free host can take about 30 seconds to wake). Your browser gets its own demo.
2. Click **Read the work log**. Press **N** to jump to a flagged line, then **B** (bill) or **D** (don't bill). For Mesa Ridge, choose **D** for Robert Okafor so its invoice is $2,100.
3. Click **Approve & send** on a client card; the invoice goes to the PayPal sandbox.
4. On Harbor & Pine's sent invoice, click **Client pays (test)**; it turns paid when PayPal's webhook arrives. Then **Client replies**: Claude's ruling on the dispute; crediting it refunds the card through PayPal.
5. **Client's AI agent**: start Mesa Ridge's agent; it checks 10 lines and disputes one. Answer it in **Client replies**, let the agent finish, and approve its payment as its human. PayPal charges the saved card and the invoice turns paid.
6. Optional: connect your own MCP client with the connect line on the **Client's AI agent** tab (Claude Code: `claude mcp add --transport http paytally https://paytally-wyzc.onrender.com/mcp --header "Authorization: Bearer demo-mesa-ridge"`).
7. **Reset demo** at the bottom starts your demo over. Everything is the PayPal sandbox with invented companies and PayPal's test cards; no real money moves.

To run it yourself: `npm install`, `npm start`, open http://localhost:3000. PayPal is mocked until `PAYPAL_MODE=sandbox` and sandbox keys are set; Claude runs live only with `ANTHROPIC_API_KEY`. Details in the README.

## Prizes to opt into (if the form asks)

Best Use of AG Grid (ledger grid and AG Studio dashboard), Best Use of Render (hosted from a Blueprint, webhook from Render's URL). The honorable mentions that fit: Best Use of Agentic Commerce, Best Use of PayPal + AI.
