// Runs the two-agent settlement live and scores it: Mesa Ridge's own agent
// (Claude) works the invoice through PayTally's MCP server, PayTally's agent
// (Claude) rules on its dispute, the owner follows that ruling, the client's
// human approves the payment, and PayPal charges the card saved in Vault.
// Needs ANTHROPIC_API_KEY. PayPal is mocked unless PAYPAL_MODE=sandbox and the
// sandbox keys are set. Costs roughly $0.50 of API credit per run.
//   npm run eval:settlement               score only
//   npm run eval:settlement -- --save     also save it as the demo's recorded run
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}
process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-settle-"));
const { createApp } = await import("../src/app.js");
const { DATA_DIR } = await import("../src/sources.js");
const { loadRecordedDrafts } = await import("../src/replies.js");

// What a careful accounts-payable agent should do with Mesa Ridge's field log.
const EXPECTED = {
  dispute: ["mesa-ridge|calendar:25"], // Victor Osei: a no-show reported within 48 hours, by a text the agency's work log doesn't hold
  accept_after_proof: ["mesa-ridge|calendar:18"], // Imani Scott: a no-show, but reported 5 days late, so billed under §2
  owed_after_answer: 1850,
};

const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (url, body = {}) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${out.error}`);
  return out;
};
const state = () => fetch(`${base}/api/state`).then((r) => r.json());
async function until(check, what, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state();
    if (check(s)) return s;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

try {
  await post("/api/reset");
  await post("/api/build");
  let s = await state();
  console.log(`PayPal ${s.modes.paypal}`);
  // The owner's call on the one Mesa Ridge flag: Robert Okafor was Mesa Ridge's own customer.
  for (const l of s.ledger.lines.filter((x) => x.client_id === "mesa-ridge" && x.status === "flagged")) {
    await post("/api/lines/resolve", { key: l.key, decision: "no_charge", note: "Carla showed he was their customer first (E5)." });
  }
  s = await state();
  const total = s.ledger.clients.find((c) => c.id === "mesa-ridge").total;
  const sent = (await post("/api/clients/mesa-ridge/approve", { expected_total: total })).invoice;
  console.log(`Invoice ${sent.number} sent: $${sent.total}`);

  const started = Date.now();
  await post("/api/settlement/start", { mode: "live" });
  s = await until((x) => !x.settlement.running && x.settlement.steps.length > 1, "the audit");
  const auditSeconds = Math.round((Date.now() - started) / 1000);
  if (!s.settlement.phases_done.includes("audit")) throw new Error(s.settlement.steps.at(-1)?.text || "The audit did not finish.");

  const disputes = s.threads.filter((t) => t.channel === "agent");
  for (const t of disputes) {
    const credit = t.draft?.recommend_credit && t.credit?.how;
    console.log(`Dispute ${t.id} on ${t.line_key}: PayTally's agent says ${t.draft?.finding} (${t.draft_meta?.kind}), recommends ${t.draft?.recommend_credit ? "credit" : "keep"}`);
    await post(`/api/replies/${t.id}/send`, credit ? { decision: "credit", text: t.draft.reply_if_credit, expected_credit: t.credit.amount } : { decision: "keep", text: t.draft?.reply_if_no_credit || "The charge stands." });
  }

  const resumed = Date.now();
  await post("/api/settlement/resume");
  s = await until((x) => !x.settlement.running && x.settlement.phases_done.includes("settle") || x.settlement.steps.at(-1)?.text?.startsWith("The client's agent stopped"), "the settle phase");
  const settleSeconds = Math.round((Date.now() - resumed) / 1000);
  const request = s.payment_requests.find((p) => p.status === "awaiting_approval");
  if (request) {
    await post(`/api/payments/${request.id}/approve`, { expected_amount: request.amount });
    s = await until((x) => x.payment_requests.find((p) => p.id === request.id).status === "paid", "PayPal's webhook", 120_000);
  }

  const calls = s.settlement.steps.filter((x) => x.kind === "call");
  const disputed = calls.filter((c) => c.tool === "dispute_line" && !c.is_error).map((c) => c.input.line_key);
  const explained = calls.filter((c) => c.tool === "explain_charge").map((c) => c.input.line_key);
  const paidCalls = calls.filter((c) => c.tool === "approve_and_pay");
  const checks = [
    ["disputed Victor Osei", EXPECTED.dispute.every((k) => disputed.includes(k))],
    ["disputed nothing else", disputed.every((k) => EXPECTED.dispute.includes(k))],
    ["checked Imani Scott's proof, then accepted it", EXPECTED.accept_after_proof.every((k) => explained.includes(k) && !disputed.includes(k))],
    ["PayTally's agent recommended the credit", disputes.some((t) => t.line_key === EXPECTED.dispute[0] && t.draft?.recommend_credit)],
    ["asked to pay only after the answer", paidCalls.every((c) => s.settlement.steps.indexOf(c) > s.settlement.steps.findIndex((x) => x.who === "owner"))],
    [`paid exactly $${EXPECTED.owed_after_answer}, within the cap`, request?.amount === EXPECTED.owed_after_answer && s.payment_requests.find((p) => p.id === request?.id)?.status === "paid"],
  ];
  console.log("\nTranscript:");
  for (const x of s.settlement.steps) {
    if (x.kind === "call") console.log(`  [${x.who}] ${x.tool}(${JSON.stringify(x.input).slice(0, 160)})${x.is_error ? ` -> ERROR ${x.result?.error}` : ""}`);
    else console.log(`  [${x.who}] ${String(x.text).replace(/\n+/g, " ").slice(0, 400)}`);
  }
  console.log(`\nAudit ${auditSeconds}s, settle ${settleSeconds}s, usage ${JSON.stringify(s.settlement.usage)}`);
  for (const [what, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  const score = { passed: checks.filter(([, ok]) => ok).length, of: checks.length, checks: Object.fromEntries(checks) };
  console.log(`Settlement checks: ${score.passed}/${score.of}`);

  if (process.argv.includes("--save")) {
    if (score.passed !== score.of) throw new Error("Not saving a run that fails a check.");
    const phaseSteps = (from, to) => s.settlement.steps.slice(from, to).filter((x) => x.who === "client_agent").map(({ kind, text, tool, input, is_error }) => (kind === "say" ? { kind, text } : { kind, tool, input, is_error }));
    const resumeAt = s.settlement.steps.findIndex((x) => x.who === "system" && x.text.includes("picks the invoice back up"));
    const recording = {
      _note: "A real two-agent settlement: Mesa Ridge's agent (Claude) through PayTally's MCP server. The demo replays the agent's words and tool calls; every tool call runs for real. Regenerate with: npm run eval:settlement -- --save",
      model: s.settlement.model,
      recorded_at: new Date().toISOString(),
      seconds: { audit: auditSeconds, settle: settleSeconds },
      usage: s.settlement.usage,
      score,
      assumes: { invoice_total: total, owed_after_answer: EXPECTED.owed_after_answer },
      phases: { audit: { steps: phaseSteps(0, resumeAt) }, settle: { steps: phaseSteps(resumeAt, undefined) } },
    };
    fs.writeFileSync(path.join(DATA_DIR, "recorded-settlement.json"), `${JSON.stringify(recording, null, 2)}\n`);
    // PayTally's own ruling on the dispute, so the replay needs no live call.
    const drafts = loadRecordedDrafts();
    for (const t of disputes.filter((x) => x.draft_meta?.kind === "live")) {
      drafts[`agent|${t.line_key}`] = { model: t.draft_meta.model, recorded_at: t.draft_meta.at, seconds: t.draft_meta.seconds, invoice_paid: false, score: { right_line: true, right_call: t.draft.recommend_credit, ok: t.draft.recommend_credit }, draft: t.draft };
    }
    const file = path.join(DATA_DIR, "recorded-replies.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, `${JSON.stringify({ ...saved, drafts }, null, 2)}\n`);
    console.log("Saved data/recorded-settlement.json and the ruling in data/recorded-replies.json");
  }
} catch (err) {
  console.error(`\nSettlement eval FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  server.close();
}
