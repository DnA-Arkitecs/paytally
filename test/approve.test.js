import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-test-"));
delete process.env.PAYPAL_MODE;

const { createApp } = await import("../src/app.js");
const paypal = await import("../src/paypal/index.js");
const { issueApproval } = await import("../src/approvals.js");
const { extractFromAnswerKey } = await import("../src/extract.js");

let server;
let base;
let claudeCalls = 0;

before(async () => {
  const fakeClaude = async () => {
    claudeCalls += 1;
    return { extraction: extractFromAnswerKey(), model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
  };
  server = createApp({ extract: fakeClaude, hasClaudeKey: () => true }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (url, body = {}) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const state = () => fetch(base + "/api/state").then((r) => r.json());

test("PayPal refuses anything without an owner approval", async () => {
  const draft = { client_id: "x", total: 1, lines: [], currency: "USD", period: { label: "x" }, invoicer: { name: "a", billing_email: "b" }, client_name: "c", billing_email: "d" };
  await assert.rejects(paypal.createInvoice(draft), /owner's approval/);
  await assert.rejects(paypal.createInvoice(draft, { ...issueApproval(draft, { approvedBy: "x" }) }), /owner's approval/);
  const approval = issueApproval(draft, { approvedBy: "x" });
  await assert.rejects(paypal.createInvoice({ ...draft, total: 2 }, approval), /changed after it was approved/);
});

test("build, resolve, approve: the only path to PayPal", async () => {
  assert.equal(paypal.mode, "mock");
  assert.equal((await post("/api/build")).status, 200);
  await post("/api/build");
  assert.equal(claudeCalls, 1, "an unchanged log is not re-read");

  let s = await state();
  const hp = s.ledger.clients.find((c) => c.id === "harbor-pine");
  const blocked = await post("/api/clients/harbor-pine/approve", { expected_total: hp.total });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /flagged/);

  const sofia = s.ledger.lines.find((l) => l.person === "Sofia Reyes");
  assert.equal((await post("/api/lines/resolve", { key: sofia.key, decision: "bill", note: "Jordan confirmed" })).status, 200);
  s = await state();
  const total = s.ledger.clients.find((c) => c.id === "harbor-pine").total;
  assert.equal(total, 1200);

  const stale = await post("/api/clients/harbor-pine/approve", { expected_total: 1050 });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since you reviewed/);

  const ok = await post("/api/clients/harbor-pine/approve", { expected_total: 1200 });
  assert.equal(ok.status, 200);
  assert.match(ok.body.invoice.paypal_id, /^INV2-MOCK-/);
  assert.equal(ok.body.invoice.status, "SENT");
  assert.equal(ok.body.invoice.lines, 8);

  const again = await post("/api/clients/harbor-pine/approve", { expected_total: 1200 });
  assert.equal(again.status, 409);
  const locked = await post("/api/lines/resolve", { key: sofia.key, decision: "no_charge" });
  assert.equal(locked.status, 409);

  const page = await fetch(`${base}/mock-paypal/invoice/${ok.body.invoice.paypal_id}`).then((r) => r.text());
  assert.match(page, /Total due/);
  assert.match(page, /1200\.00/);
});
