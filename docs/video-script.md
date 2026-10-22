# PayTally video script (2:45)

For Richman to voice over a screen recording of the hosted demo. About 390 spoken words at an easy pace. Every claim about him and his business comes from his fact bank (sources at the bottom); every company, person and amount on screen is invented demo data.

**Before recording:** open the hosted link, wait for it to wake (up to a minute), click **Reset demo**, decide every flagged line before approving (Mesa Ridge's Robert Okafor: **D**, don't bill, so its invoice is $2,100), and record at 1920×1080 with the browser at 110% zoom. Say the numbers that are on screen if they differ from the ones below.

| Time | On screen | Voice |
|---|---|---|
| 0:00–0:14 | PayTally home page, then the **Work log** tab scrolling (calendar, CRM, emails). | "I built and run an outbound system that has booked 2,447 meetings for 14 financial advisors since October 2025. Advisors pay per meeting or share revenue, so every month someone has to count what's billable." |
| 0:14–0:24 | Stay on the messy rows. | "That count is where mistakes hide. One month the count on file was 531. Twenty-four were test bookings. The real number was 507. So I built PayTally." |
| 0:24–0:42 | Click **Read the work log**. The ledger fills. Click one billed line: its reason, the terms clause and its source rows open below it. | "This is a made-up agency with three clients on different terms. Claude reads the calendar, the CRM and the client emails. Plain code applies each client's terms. Every line says why it's billed and which rows it came from." |
| 0:42–0:58 | Press **N**: Priya Natarajan's call opens, status "Completed", note "NS". Press **D**. Click **Approve & send** on each client card; the cards turn "Sent". | "Here's an error caught. This call says Completed, but the note says NS, a no-show. Claude didn't guess. It flagged it for me. I press D: don't bill. Then I approve, and the invoices go out through PayPal." |
| 0:58–1:24 | **Client's AI agent** tab: the mandate card with the $2,000 cap, the MCP connect line, then the steps stream in: get_ledger, explain_charge, dispute_line. | "Now the other side. Mesa Ridge has its own AI agent. It connects to PayTally over MCP, with a token that only sees its own bill. Its human gave it rules: check every line against our field log, dispute only what our records support, and never pay over two thousand dollars without asking. It checks ten lines, asks for proof on one, and disputes it: a no-show the client reported by text." |
| 1:24–1:46 | **Client replies**: PayTally's agent's ruling recommends a credit. Click **Credit $250.00 · Claude's call**, then **Credit $250.00 & send reply**. The card shows invoice M0002 cancelled and M0003 sent. | "PayTally's agent checks the dispute. The text isn't in our log, but the client's account is specific and on time, so it recommends a credit and says what to check. The credit is my click. PayPal cancels the invoice and sends a corrected one. Twenty-one hundred becomes eighteen fifty." |
| 1:46–2:08 | Back on **Client's AI agent**: the agent checks M0003 and asks to pay. The payment card shows $1,850. Click **Approve $1,850.00** as Carla. PayPal's capture id appears; the invoice turns **Paid**. | "The client's agent checks the new invoice line by line and asks to pay. It can't move money by itself. Its human approves the exact amount with one tap. PayPal charges the card saved in its vault, and PayPal's webhook marks the invoice paid. The money landed." |
| 2:08–2:22 | Click **Collections dashboard**. Scroll the AG Studio page; click **Edit layout**, ask "What needs a decision", show Claude's answer. | "At month-end, the owner sees the whole month in one AG Grid dashboard, and can ask it questions. Claude answers from the same numbers." |
| 2:22–2:45 | The README's results table, then the PayTally logo on the home page. | "AI agents did the reading, the checking and the arguing. Code did the math. People approved every dollar. On one real week of my own bookings, PayTally read all 96 and matched 15 of 15 billable meetings to my records at the right price, and flagged one for my review. I built it by directing AI coding agents. That's PayTally." |

## Where each claim comes from

| Line | Source |
|---|---|
| 2,447 meetings, 14 financial advisors, since October 2025 | fact bank `bookings_total` (booked, not held: say "booked") |
| Advisors pay per meeting or share revenue | fact bank `op_founded` |
| 531 on file, 24 test bookings, 507 real | fact bank `corrections_found` (September 2026) |
| One real week: 96 read, 15 of 15 matched, 1 flagged | project note, approved as a video line by his word 2026-10-22 |
| Built by directing AI coding agents | fact bank `ai_direction` |

## Never say

- "Runs itself", "fully autonomous", "hands-off" or "zero-touch".
- Any advisor, client, firm or carrier; any income, revenue, commission or price from his business.
- The sending platform or the contact-data vendor.
