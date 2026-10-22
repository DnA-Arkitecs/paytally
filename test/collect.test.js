import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-collect-"));
delete process.env.PAYPAL_MODE;

const { createApp } = await import("../src/app.js");
const paypal = await import("../src/paypal/index.js");
const collect = await import("../src/collect.js");
const { issueApproval } = await import("../src/approvals.js");
const { loadRecordedDrafts } = await import("../src/replies.js");

let server;
let base;
let liveDrafts = 0;

before(async () => {
  const fakeClaude = async ({ reply }) => {
    liveDrafts += 1;
    return { draft: loadRecordedDrafts()[reply.id].draft, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } };
  };
  server = createApp({ draftReply: fakeClaude, hasClaudeKey: () => true }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (url, body = {}) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const state = () => fetch(base + "/api/state").then((r) => r.json());
const record = (s, pid) => s.collections.find((r) => r.paypal_id === pid);

// PayPal's webhooks arrive a moment after the call that causes them.
async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state();
    if (check(s)) return s;
    if (Date.now() > end) throw new Error("Timed out waiting for the webhook.");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function approveClient(id) {
  let s = await state();
  for (const l of s.ledger.lines.filter((x) => x.client_id === id && x.status === "flagged")) {
    await post("/api/lines/resolve", { key: l.key, decision: "bill" });
  }
  s = await state();
  const total = s.ledger.clients.find((c) => c.id === id).total;
  const out = await post(`/api/clients/${id}/approve`, { expected_total: total });
  assert.equal(out.status, 200);
  return out.body.invoice;
}

test("the toolkit's create_invoice accepts every field PayTally sends", async () => {
  const { PayPalAgentToolkit } = (await import("@paypal/agent-toolkit/ai-sdk")).default;
  const tools = new PayPalAgentToolkit({ clientId: "x", clientSecret: "y", configuration: { actions: { invoices: { create: true } }, context: { sandbox: true } } }).getTools();
  const accepted = Object.keys(tools.create_invoice.parameters.shape);
  const draft = {
    client_id: "c", client_name: "C", billing_email: "c@example.com", invoicer: { name: "A" }, period: { label: "October 2026" },
    currency: "USD", invoice_date: "2026-10-31", due_date: "2026-11-15", total: 150,
    lines: [{ key: "k", date: "2026-10-02", item: "Booked call", amount: 150, reason: "Held.", sources: ["calendar:4"] }],
  };
  const params = paypal.toPayPalInvoice(draft);
  for (const key of Object.keys(params)) assert.ok(accepted.includes(key), `${key} is not a create_invoice field`);
  assert.match(params.note, /due by Nov 15, 2026/);
});

test("reminders, refunds and cancellations need the owner's approval of that exact action", async () => {
  const reminder = { kind: "reminder", invoice_id: "INV2-X", subject: "s", note: "n" };
  await assert.rejects(paypal.sendInvoiceReminder(reminder), /owner's approval/);
  await assert.rejects(paypal.sendInvoiceReminder({ ...reminder, note: "changed" }, issueApproval(reminder, { approvedBy: "x" })), /changed after it was approved/);
  await assert.rejects(paypal.recordRefund({ kind: "refund", invoice_id: "INV2-X", amount: 5, currency: "USD" }), /owner's approval/);
  await assert.rejects(paypal.cancelSentInvoice({ kind: "cancel", invoice_id: "INV2-X", note: "n" }), /owner's approval/);
});

test("the recorded reply drafts are real Claude runs that fit this work log and match the answers", async () => {
  const { loadAgency, loadSources } = await import("../src/sources.js");
  const { loadRecordedRun } = await import("../src/extract.js");
  const { buildLedger, invoiceDraft } = await import("../src/ledger.js");
  const { loadClientReplies, draftProblem, scoreDraft } = await import("../src/replies.js");
  const agency = loadAgency();
  const sources = loadSources();
  const ledger = buildLedger({ agency, extraction: loadRecordedRun(sources.hash).extraction, sources, extractor: {} });
  const recorded = loadRecordedDrafts();
  for (const reply of loadClientReplies()) {
    const rec = recorded[reply.id];
    assert.ok(rec, `no recorded draft for ${reply.id}`);
    assert.match(rec.model, /^claude-/);
    const lines = invoiceDraft(ledger, agency, reply.client_id).lines;
    const invoice = { lines };
    assert.equal(draftProblem(rec.draft, invoice, sources), "");
    assert.equal(scoreDraft(rec.draft, reply.expected, invoice).ok, true);
  }
});

test("a webhook event is applied once, and only to invoices this app sent", () => {
  const s = { invoices: { a: { paypal_id: "INV2-A", client_name: "A", number: "0001", status: "SENT", total: 100, paid: 0 } }, history: [], seen_events: [] };
  const event = { id: "WH-1", event_type: "INVOICING.INVOICE.PAID", create_time: "2026-10-22T20:00:00Z", resource: { invoice: { id: "INV2-A", status: "PAID", payments: { paid_amount: { value: "100.00" } } } } };
  assert.match(collect.applyEvent(s, event, "PayPal webhook"), /paid \(\$100\.00\)/);
  assert.equal(s.invoices.a.status, "PAID");
  assert.equal(collect.applyEvent(s, event, "PayPal webhook"), "");
  assert.equal(collect.applyEvent(s, { ...event, id: "WH-2", resource: { invoice: { id: "INV2-OTHER" } } }, "PayPal webhook"), "");
});

test("paid by webhook, overdue reminder, and disputes credited through PayPal (mock)", async () => {
  assert.equal(paypal.mode, "mock");
  assert.equal((await fetch(`${base}/api/paypal/webhook`, { method: "POST", body: "{}" })).status, 404, "outside webhooks are refused in mock mode");
  assert.equal((await post("/api/build")).status, 200);
  let s = await state();

  // Last month's invoice is in PayPal, unpaid and overdue.
  const sept = s.collections.find((r) => r.kind === "history");
  assert.equal(sept.period, "September 2026");
  assert.equal(sept.total, 1380);
  assert.equal(sept.due_date, "2026-10-15");
  assert.ok(sept.days_overdue > 0);
  const edited = await post(`/api/invoices/${sept.paypal_id}/remind`, { subject: sept.reminder.subject, note: `${sept.reminder.note} Pay now.` });
  assert.equal(edited.status, 409, "a reminder that differs from what the owner saw is refused");
  assert.equal((await post(`/api/invoices/${sept.paypal_id}/remind`, sept.reminder)).status, 200);
  assert.equal(record(await state(), sept.paypal_id).reminders.length, 1);

  // Harbor & Pine: sent, not yet due, then paid. Only PayPal's webhook marks it paid.
  const hp = await approveClient("harbor-pine");
  assert.equal(hp.status, "SENT");
  assert.equal(hp.due_date, new Date(Date.parse(`${hp.invoice_date}T00:00:00Z`) + 15 * 86400000).toISOString().slice(0, 10));
  assert.equal((await post(`/api/invoices/${hp.paypal_id}/remind`, {})).status, 409, "not overdue, so no reminder");
  assert.equal((await post("/api/replies/R1/arrive")).status, 409, "Jordan's reply comes after paying, so its draft can promise a refund");
  assert.equal((await post(`/api/invoices/${hp.paypal_id}/test-pay`)).status, 200);
  s = await state();
  assert.equal(record(s, hp.paypal_id).status, "SENT", "recording the payment alone does not mark it paid");
  s = await until((x) => record(x, hp.paypal_id).status === "MARKED_AS_PAID");
  assert.equal(record(s, hp.paypal_id).paid, hp.total);
  assert.match(record(s, hp.paypal_id).paid_via, /webhook/);
  assert.equal(record(s, hp.paypal_id).awaiting, null);

  // Jordan disputes Ethan Cole after paying: Claude cites the row and recommends a credit; crediting records a refund.
  assert.equal((await post("/api/replies/R1/arrive")).status, 200);
  s = await state();
  let r1 = s.threads.find((t) => t.id === "R1");
  assert.equal(r1.draft_meta.kind, "recorded");
  assert.equal(r1.draft.line_key, "harbor-pine|calendar:29");
  assert.ok(r1.draft.cited_sources.includes("calendar:29"));
  assert.equal(r1.draft.recommend_credit, true);
  assert.deepEqual([r1.credit.amount, r1.credit.how], [150, "refund"]);
  assert.equal((await post("/api/replies/R1/draft", { mode: "live" })).status, 200);
  assert.equal(liveDrafts, 1);
  r1 = (await state()).threads.find((t) => t.id === "R1");
  assert.equal(r1.draft_meta.kind, "live");
  assert.equal(r1.draft_meta.score.ok, true);
  const stale = await post("/api/replies/R1/send", { decision: "credit", text: r1.draft.reply_if_credit, expected_credit: 100 });
  assert.equal(stale.status, 409);
  assert.equal((await post("/api/replies/R1/send", { decision: "credit", text: r1.draft.reply_if_credit, expected_credit: 150 })).status, 200);
  s = await until((x) => record(x, hp.paypal_id).status === "PARTIALLY_REFUNDED");
  assert.equal(record(s, hp.paypal_id).refunded, 150);
  assert.equal(s.ledger.lines.find((l) => l.key === "harbor-pine|calendar:29").status, "no_charge");
  assert.equal(s.threads.find((t) => t.id === "R1").status, "answered");

  // Cobalt disputes Rosa Delgado before paying. Claude says the charge stands; the owner credits anyway,
  // so PayPal cancels the invoice and a corrected one goes out for $45 less.
  const cobalt = await approveClient("cobalt-dental");
  assert.equal((await post("/api/replies/R2/arrive")).status, 200);
  s = await state();
  const r2 = s.threads.find((t) => t.id === "R2");
  assert.equal(r2.draft.line_key, "cobalt-dental|crm:19");
  assert.equal(r2.draft.recommend_credit, false);
  assert.deepEqual([r2.credit.amount, r2.credit.how, r2.credit.new_total], [45, "corrected_invoice", cobalt.total - 45]);
  assert.equal((await post("/api/replies/R2/send", { decision: "credit", text: "Taken off.", expected_credit: 45 })).status, 200);
  s = await state();
  const old = record(s, cobalt.paypal_id);
  const next = s.invoices["cobalt-dental"];
  assert.equal(old.status, "CANCELLED");
  assert.equal(old.replaced_by, next.paypal_id);
  assert.equal(next.replaces, cobalt.paypal_id);
  assert.equal(next.total, cobalt.total - 45);
  assert.equal(next.status, "SENT");
  const page = await fetch(`${base}/mock-paypal/invoice/${next.paypal_id}`).then((r) => r.text());
  assert.match(page, new RegExp(`Corrected invoice, replacing invoice ${old.number}`));
  assert.equal((await post("/api/replies/R2/send", { decision: "keep", text: "again" })).status, 409, "an answered reply can't be sent twice");
});
