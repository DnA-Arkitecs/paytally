import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-demos-test-"));
delete process.env.PAYPAL_MODE;

const { createApp } = await import("../src/app.js");
const { connect } = await import("../src/client-agent.js");

const toolJson = (out) => JSON.parse(out.content[0].text);

// One browser: opening the page sets its demo cookie, and every call after sends it.
async function browser(base) {
  const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  const cookie = page.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie || "", /^paytally_demo=[a-f0-9]{16}$/, "opening the page gives this browser its own demo");
  const headers = { "content-type": "application/json", cookie };
  const post = (url, body = {}) => fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const state = () => fetch(`${base}/api/state`, { headers }).then((r) => r.json());
  const until = async (check) => {
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (check(s)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Timed out.");
  };
  return { id: cookie.split("=")[1], post, state, until };
}

test("two judges on the public link each get their own demo", async () => {
  const server = createApp({ hasClaudeKey: () => false }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await browser(base);
    const b = await browser(base);
    assert.notEqual(a.id, b.id);

    // Judge A builds the ledger and sends Mesa Ridge's invoice, with Robert Okafor not billed.
    assert.equal((await a.post("/api/build", { mode: "recorded" })).status, 200);
    let s = await a.state();
    for (const l of s.ledger.lines.filter((x) => x.client_id === "mesa-ridge" && x.status === "flagged")) {
      await a.post("/api/lines/resolve", { key: l.key, decision: "no_charge" });
    }
    s = await a.state();
    const total = s.ledger.clients.find((c) => c.id === "mesa-ridge").total;
    const invoice = (await a.post("/api/clients/mesa-ridge/approve", { expected_total: total })).body.invoice;
    assert.equal(invoice.total, 2100);

    // Judge B sees a fresh demo, and B's reset leaves A's work alone.
    assert.equal((await b.state()).ledger, null);
    assert.equal((await b.post("/api/reset")).status, 200);
    assert.equal((await a.state()).invoices["mesa-ridge"].paypal_id, invoice.paypal_id);
    // Scripts without a cookie use the shared demo, which is untouched too.
    assert.equal((await fetch(`${base}/api/state`).then((r) => r.json())).ledger, null);

    // A's connect line carries A's demo, and an outside agent using it sees A's invoice.
    const token = s.client_agents[0].token;
    assert.equal(token, `demo-mesa-ridge.${a.id}`);
    const mcp = await connect(`${base}/mcp`, token);
    try {
      assert.equal(toolJson(await mcp.callTool({ name: "get_ledger", arguments: {} })).invoices[0].owed, 2100);
    } finally {
      await mcp.close();
    }
    const outsider = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer demo-mesa-ridge.not-a-demo" }, body: "{}" });
    assert.equal(outsider.status, 401, "a token naming no demo is refused");

    // A's agent settles inside A's demo: dispute, credit, payment, and PayPal's events land in A.
    assert.equal((await a.post("/api/settlement/start")).status, 200);
    s = await a.until((x) => !x.settlement.running && x.settlement.phases_done.includes("audit"));
    const dispute = s.threads.find((t) => t.channel === "agent");
    assert.equal(dispute.line_key, "mesa-ridge|calendar:25");
    assert.equal((await a.post(`/api/replies/${dispute.id}/send`, { decision: "credit", text: dispute.draft.reply_if_credit, expected_credit: 250 })).status, 200);
    assert.equal((await a.post("/api/settlement/resume")).status, 200);
    s = await a.until((x) => !x.settlement.running && x.settlement.phases_done.includes("settle"));
    const request = s.payment_requests.find((p) => p.status === "awaiting_approval");
    assert.equal(request.amount, 1850);
    assert.equal((await a.post(`/api/payments/${request.id}/approve`, { expected_amount: 1850 })).status, 200);
    s = await a.until((x) => x.payment_requests.find((p) => p.id === request.id).status === "paid");
    assert.ok(s.settlement.steps.some((x) => x.who === "paypal" && /captured \$1,850\.00/.test(x.text)), "PayPal's event reached A's demo");

    const other = await b.state();
    assert.equal(other.settlement.steps.length, 0, "B saw none of it");
    assert.equal(other.mcp.log.length, 0);
  } finally {
    server.close();
  }
});
