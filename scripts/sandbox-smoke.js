// Runs the whole flow against the real PayPal sandbox through the app's own
// routes: last month's overdue invoice and its reminder, approve and send,
// a test card payment, a dispute credited as a real refund, a dispute credited
// as a corrected invoice, and Mesa Ridge's agent settling over MCP (recorded
// run) with its human approving a charge to the card saved in PayPal Vault.
// Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox).
//   npm run smoke:sandbox                  status from "Check PayPal" (no public URL, so no webhook)
//   npm run smoke:sandbox -- <base URL>    drive a deployed copy instead, where PayPal's webhook marks it paid
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const remote = process.argv[2];
let base = remote?.replace(/\/$/, "");
let server = null;
if (!base) {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) first.");
    process.exit(1);
  }
  process.env.PAYPAL_MODE = "sandbox";
  process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-smoke-"));
  const { createApp } = await import("../src/app.js");
  server = createApp({ hasClaudeKey: () => false }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const post = async (url, body = {}) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${out.error}`);
  return out;
};
const state = () => fetch(`${base}/api/state`).then((r) => r.json());
const record = (s, pid) => s.collections.find((r) => r.paypal_id === pid);
const step = (text) => console.log(`- ${text}`);

// Waits for PayPal: on a deployed copy the webhook does it; locally, "Check PayPal".
async function until(check, what) {
  const end = Date.now() + 120_000;
  for (;;) {
    if (!remote) await post("/api/collections/refresh");
    const s = await state();
    if (check(s)) return s;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function approve(id, decision = "bill") {
  let s = await state();
  for (const l of s.ledger.lines.filter((x) => x.client_id === id && x.status === "flagged")) {
    await post("/api/lines/resolve", { key: l.key, decision, note: "smoke test" });
  }
  s = await state();
  const total = s.ledger.clients.find((c) => c.id === id).total;
  return (await post(`/api/clients/${id}/approve`, { expected_total: total })).invoice;
}

try {
  await post("/api/reset");
  await post("/api/build");
  let s = await state();
  if (s.modes.paypal !== "sandbox") throw new Error(`PayPal is in ${s.modes.paypal} mode.`);
  step(`PayPal ${s.modes.paypal}, webhook ${s.modes.webhook}`);

  const sept = s.collections.find((r) => r.kind === "history");
  step(`September invoice ${sept.number} (${sept.paypal_id}) is ${sept.days_overdue} days overdue`);
  await post(`/api/invoices/${sept.paypal_id}/remind`, sept.reminder);
  step("reminder sent through send_invoice_reminder");

  const hp = await approve("harbor-pine");
  step(`Harbor & Pine invoice ${hp.number} sent: $${hp.total}, due ${hp.due_date}, client link ${hp.href}`);
  await post(`/api/invoices/${hp.paypal_id}/test-pay`);
  s = await until((x) => ["PAID", "MARKED_AS_PAID"].includes(record(x, hp.paypal_id).status), "the payment");
  step(`invoice ${hp.number} paid, via ${record(s, hp.paypal_id).paid_via}`);

  await post("/api/replies/R1/arrive");
  s = await state();
  const r1 = s.threads.find((t) => t.id === "R1");
  step(`R1 draft (${r1.draft_meta.kind}): ${r1.draft.line_key}, ${r1.draft.finding}, credit ${r1.credit.amount} by ${r1.credit.how}`);
  await post("/api/replies/R1/send", { decision: "credit", text: r1.draft.reply_if_credit, expected_credit: r1.credit.amount });
  s = await until((x) => record(x, hp.paypal_id).status.includes("REFUNDED"), "the refund");
  const hpRec = record(s, hp.paypal_id);
  step(`invoice ${hp.number} is ${hpRec.status}, $${hpRec.refunded} refunded; card capture ${hpRec.payments[0]?.capture_id}, refund ${hpRec.refunds?.[0]?.refund_id || "(none)"}`);
  if (!hpRec.refunds?.[0]?.refund_id) throw new Error("The credit did not move money back to the card.");

  const cobalt = await approve("cobalt-dental");
  step(`Cobalt invoice ${cobalt.number} sent: $${cobalt.total}`);
  await post("/api/replies/R2/arrive");
  s = await state();
  const r2 = s.threads.find((t) => t.id === "R2");
  step(`R2 draft: ${r2.draft.line_key}, ${r2.draft.finding}, Claude recommends credit: ${r2.draft.recommend_credit}; owner credits ${r2.credit.amount} anyway`);
  await post("/api/replies/R2/send", { decision: "credit", text: "Taken off; PayPal will send the corrected invoice.", expected_credit: r2.credit.amount });
  s = await state();
  const next = s.invoices["cobalt-dental"];
  step(`invoice ${cobalt.number} is ${record(s, cobalt.paypal_id).status}; corrected invoice ${next.number} sent for $${next.total}`);

  // Mesa Ridge: its own agent checks the invoice over MCP, disputes Victor
  // Osei, the owner credits it, the agent asks to pay, Carla approves.
  const mesa = await approve("mesa-ridge", "no_charge");
  step(`Mesa Ridge invoice ${mesa.number} sent: $${mesa.total}; card ${(await state()).client_agents[0].saved_method?.vault_id ? "saved in Vault" : "NOT SAVED"}`);
  await post("/api/settlement/start");
  s = await until((x) => !x.settlement.running && x.settlement.steps.length > 1, "the agent's audit");
  const a1 = s.threads.find((t) => t.channel === "agent");
  if (!a1) throw new Error(s.settlement.steps.at(-1)?.text || "The agent opened no dispute.");
  step(`agent disputed ${a1.line_key}; PayTally recommends credit: ${a1.draft.recommend_credit}`);
  await post(`/api/replies/${a1.id}/send`, { decision: "credit", text: a1.draft.reply_if_credit, expected_credit: a1.credit.amount });
  await post("/api/settlement/resume");
  s = await until((x) => !x.settlement.running && x.settlement.phases_done.includes("settle"), "the agent's payment request");
  const pr = s.payment_requests.find((p) => p.status === "awaiting_approval");
  if (!pr) throw new Error(s.settlement.steps.at(-1)?.text || "The agent asked for no payment.");
  step(`agent asked to pay $${pr.amount} on invoice ${pr.invoice_number}`);
  await post(`/api/payments/${pr.id}/approve`, { expected_amount: pr.amount });
  s = await until((x) => x.payment_requests.find((p) => p.id === pr.id).status === "paid", "the vault payment");
  step(`Carla approved; PayPal charged the saved card, capture ${s.payment_requests.find((p) => p.id === pr.id).paypal.capture_id}; invoice paid`);

  console.log("\nActivity (newest first):");
  for (const a of s.activity.slice(0, 24)) console.log(`  [${a.kind}] ${a.text}`);
  console.log("\nSmoke test passed.");
} catch (err) {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  server?.close();
}
