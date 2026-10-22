import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-settle-test-"));
delete process.env.PAYPAL_MODE;

const { createApp } = await import("../src/app.js");
const { connect } = await import("../src/client-agent.js");

async function withApp(fn) {
  const server = createApp({ hasClaudeKey: () => false }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body = {}) =>
    fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const state = () => fetch(base + "/api/state").then((r) => r.json());
  const until = async (check) => {
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (check(s)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Timed out.");
  };
  try {
    await fn({ base, post, state, until });
  } finally {
    server.close();
  }
}

// Mesa Ridge's invoice as the recorded run expects it: Robert Okafor not billed.
async function sendMesaRidge({ post, state }) {
  await post("/api/reset");
  await post("/api/build", { mode: "recorded" });
  let s = await state();
  for (const l of s.ledger.lines.filter((x) => x.client_id === "mesa-ridge" && x.status === "flagged")) {
    await post("/api/lines/resolve", { key: l.key, decision: "no_charge" });
  }
  s = await state();
  const total = s.ledger.clients.find((c) => c.id === "mesa-ridge").total;
  assert.equal(total, 2100);
  return (await post("/api/clients/mesa-ridge/approve", { expected_total: total })).body.invoice;
}

const toolJson = (out) => JSON.parse(out.content[0].text);

test("the recorded two-agent settlement runs end to end with no API key", async () => {
  await withApp(async (app) => {
    await sendMesaRidge(app);
    const { post, until } = app;
    assert.equal((await post("/api/settlement/resume")).status, 409, "can't settle before the audit");

    assert.equal((await post("/api/settlement/start")).status, 200);
    let s = await until((x) => !x.settlement.running && x.settlement.phases_done.includes("audit"));
    const dispute = s.threads.find((t) => t.channel === "agent");
    assert.equal(dispute.line_key, "mesa-ridge|calendar:25");
    assert.equal(dispute.draft_meta.kind, "recorded");
    assert.equal(dispute.draft.recommend_credit, true);
    assert.equal(dispute.credit.amount, 250);
    assert.equal((await post("/api/settlement/resume")).status, 409, "waits for the owner's answer");

    const sent = await post(`/api/replies/${dispute.id}/send`, { decision: "credit", text: dispute.draft.reply_if_credit, expected_credit: 250 });
    assert.equal(sent.status, 200);
    assert.equal((await post("/api/settlement/resume")).status, 200);
    s = await until((x) => !x.settlement.running && x.settlement.phases_done.includes("settle"));
    const request = s.payment_requests.find((p) => p.status === "awaiting_approval");
    assert.equal(request.amount, 1850);

    assert.equal((await post(`/api/payments/${request.id}/approve`, { expected_amount: 1900 })).status, 409, "approval is tied to the amount shown");
    assert.equal((await post(`/api/payments/${request.id}/approve`, { expected_amount: 1850 })).status, 200);
    s = await until((x) => x.payment_requests.find((p) => p.id === request.id).status === "paid");
    assert.ok(s.settlement.steps.some((x) => x.who === "paypal" && /captured \$1,850\.00/.test(x.text)));
    assert.ok(s.settlement.steps.every((x) => !x.pending), "every tool call has its result");
  });
});

test("the MCP server holds the client's agent to its mandate", async () => {
  await withApp(async (app) => {
    const invoice = await sendMesaRidge(app);
    const unauthorized = await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(unauthorized.status, 401);

    const mcp = await connect(`${app.base}/mcp`, "demo-mesa-ridge");
    try {
      const { tools } = await mcp.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["approve_and_pay", "dispute_line", "explain_charge", "get_dispute", "get_ledger", "get_payment"]);

      const ledger = toolJson(await mcp.callTool({ name: "get_ledger", arguments: {} }));
      assert.equal(ledger.invoices[0].owed, 2100);
      assert.ok(ledger.invoices.every((i) => i.lines.every((l) => l.line_key.startsWith("mesa-ridge|"))), "only this client's lines");

      const proof = toolJson(await mcp.callTool({ name: "explain_charge", arguments: { line_key: "mesa-ridge|calendar:25" } }));
      assert.match(proof.source_rows[0].text, /Victor Osei/);

      const other = await mcp.callTool({ name: "explain_charge", arguments: { line_key: "cobalt-dental|crm:1" } });
      assert.equal(other.isError, true, "another client's line is not visible");

      const wrong = await mcp.callTool({ name: "approve_and_pay", arguments: { invoice_number: invoice.number, amount: 2000 } });
      assert.match(toolJson(wrong).error, /not \$2,000\.00/);
      const overCap = await mcp.callTool({ name: "approve_and_pay", arguments: { invoice_number: invoice.number, amount: 2100 } });
      assert.match(toolJson(overCap).error, /above the \$2,000\.00 cap/);
    } finally {
      await mcp.close();
    }
    const s = await app.state();
    assert.equal(s.payment_requests.length, 0, "nothing was set up to pay");
    assert.ok(s.mcp.log.some((m) => m.tool === "approve_and_pay" && !m.ok));
  });
});
