# PayTally video script (about 2:35, five beats)

A voiceover on a screen recording of the hosted demo. About 315 spoken words at an easy pace; it must end before 2:50 (judges stop at 3:00). An AI voiceover is allowed (Devpost update, Nov 2, 2026). Every claim about the builder comes from his fact bank or his approved real-week proof (sources at the bottom); every company, person and amount on screen is invented demo data.

**Before recording:** set the AG Studio license key in Render first (no "For Trial Use Only" watermark). Open the hosted link in a fresh browser window, wait for it to wake, click **Reset demo**. Record at 1920×1080 with the browser at 110% zoom. Mesa Ridge's Robert Okafor gets **D** (don't bill), so its invoice is $2,100. Record beat 3 as one continuous take. Cut every loading wait. Say the numbers on screen if they differ from the ones below. Upload early: YouTube processing can take hours.

**Captions** (on screen, lower third, one at a time): they name each PayPal and AI piece as it happens, so a judge watching muted still sees both.

| Time | On screen | Caption | Voice |
|---|---|---|---|
| 0:00–0:18 | Home page headline, then the **Work log** tab scrolling (calendar, CRM, emails). At 0:12 a plain text card, word for word: "On one real week of my own bookings (Oct 12–18, 2026), PayTally read all 96 and matched 15 of 15 billable meetings to my records at the right price, and flagged 1 for my review." No real data on screen. | "Paid per result? Month-end is reconciliation." | "If you're paid per result, per booked call or per qualified lead, month-end means matching a calendar, a CRM and client emails against each client's terms, by hand. My outbound system has booked 2,447 meetings for financial advisors, and billing them was the messiest step. So I built PayTally. On one real week of my own bookings, it matched fifteen of fifteen billable meetings." |
| 0:18–0:52 | Click **Read the work log**; the ledger fills. Click one billed line: its reason and source rows open. Press **N**: Priya Natarajan, "Completed", note "NS". Press **D**. Click **Approve & send** on each card; the cards turn "Sent". | "Claude Opus 5.5 reads every row" → "Code prices each line" → "PayPal Agent Toolkit: create_invoice, send_invoice" | "This is a made-up agency with three clients on different terms. Claude reads every row and cites its sources. Plain code applies each client's terms, so every line says why it's billed and where it came from. Here Claude caught a call marked Completed with the note NS, a no-show. It didn't guess. It flagged it. I press D, don't bill, approve, and PayPal's Agent Toolkit creates and sends the invoices." |
| 0:52–2:05 | One take. **Client's AI agent**: the mandate card and its $2,000 cap; start the check; get_ledger, explain_charge, dispute_line stream in. **Client replies**: PayTally's ruling recommends a credit; click **Credit $250.00 · Claude's call**, then **Credit $250.00 & send reply**; the card shows the invoice cancelled and a corrected one sent. Back to **Client's AI agent**: let the agent finish; it checks the corrected invoice and asks to pay; click **Approve $1,850.00** as Carla; PayPal's capture id appears; the invoice turns **Paid**. | "MCP: its token sees one client's bill" → "Cap enforced in code" → "PayPal: cancel_sent_invoice, create_invoice" → "PayPal Vault + Orders v2: saved card charged" → "PayPal webhook: invoice paid" | "Now the other side. Mesa Ridge has its own AI agent. It connects to PayTally over MCP with a token that sees only its own bill, and its human set a two-thousand-dollar cap that's enforced in code. It checks ten lines against its own field log, asks for proof on one, and disputes it. PayTally's agent reviews the dispute, cites the rows, and recommends a credit. The credit is my click. PayPal cancels the invoice and sends a corrected one: twenty-one hundred becomes eighteen fifty. The client's agent checks the new invoice and asks to pay. It can't move money itself. Its human approves the exact amount, PayPal charges the card saved in its vault, and PayPal's webhook marks the invoice paid." |
| 2:05–2:20 | Click **Collections dashboard**. Scroll the AG Studio page; ask the assistant "What needs a decision?"; show Claude's answer. | "AG Grid + AG Studio, assistant on Claude" | "At month-end the owner sees the whole month in one AG Grid dashboard, and can ask it questions. Claude answers from the same numbers." |
| 2:20–2:35 | The README's results table, then the PayTally logo on the home page. | "Claude reads. Code counts. People approve. PayPal pays." | "AI agents did the reading, the checking and the arguing. Code did the math. People approved every dollar, and PayPal moved it. I built it by directing AI coding agents. That's PayTally." |

## Where each claim comes from

| Line | Source |
|---|---|
| 2,447 meetings booked for financial advisors | fact bank `bookings_total` (booked, not held: say "booked") |
| One real week: 96 read, 15 of 15 matched, 1 flagged | PayTally's own code, unchanged, run 2026-10-22 on that week anonymized and compared with his tracker and advisor tally; approved by his word 2026-10-22; project note, Build state, "Real-week proof". Counts only: never add names, dollar amounts, prices or income to it |
| Built by directing AI coding agents | fact bank `ai_direction` |

The 531-to-507 correction and "advisors pay per meeting or share revenue" (fact bank `corrections_found`, `op_founded`) are in the Devpost description, not the video.

## Never say

- "Runs itself", "fully autonomous", "hands-off" or "zero-touch".
- Any advisor, client, firm or carrier; any income, revenue, commission or price from his business.
- The sending platform or the contact-data vendor.
