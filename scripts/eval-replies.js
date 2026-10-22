// Scores Claude's drafts for the demo's client replies against the hand-checked
// answers in data/client-replies.json (right line, right recommendation).
// Needs ANTHROPIC_API_KEY. Each reply is one Claude call.
//   npm run eval:replies               score only
//   npm run eval:replies -- --save     also save them as data/recorded-replies.json, the demo's default
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, loadAgency, loadSources } from "../src/sources.js";
import { loadRecordedRun, extractFromAnswerKey } from "../src/extract.js";
import { buildLedger, invoiceDraft } from "../src/ledger.js";
import { loadClientReplies, loadRecordedDrafts, draftReplyWithClaude, draftProblem, scoreDraft } from "../src/replies.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}

const agency = loadAgency();
const sources = loadSources();
const extraction = loadRecordedRun(sources.hash)?.extraction || extractFromAnswerKey();

// The invoice each client would get if the owner billed every flagged line.
const first = buildLedger({ agency, extraction, sources, extractor: {} });
const billAll = Object.fromEntries(first.lines.filter((l) => l.status === "flagged").map((l) => [l.key, { decision: "bill", note: "", at: "" }]));
const ledger = buildLedger({ agency, extraction, sources, resolutions: billAll, extractor: {} });

const drafts = {};
let ok = 0;
const replies = loadClientReplies();
for (const reply of replies) {
  const client = agency.clients.find((c) => c.id === reply.client_id);
  const draft = invoiceDraft(ledger, agency, client.id);
  // As in the demo: some replies come after the client pays, some before.
  const invoice = { number: "0001", period: draft.period.label, total: draft.total, paid: reply.arrives === "paid", lines: draft.lines };
  const started = Date.now();
  const out = await draftReplyWithClaude({ agency, client, invoice, sources, reply });
  const seconds = Math.round((Date.now() - started) / 1000);
  const problem = draftProblem(out.draft, invoice, sources);
  const score = scoreDraft(out.draft, reply.expected, invoice);
  if (score.ok && !problem) ok += 1;
  drafts[reply.id] = { model: out.model, recorded_at: new Date().toISOString(), seconds, usage: out.usage, invoice_paid: invoice.paid, score, draft: out.draft };
  console.log(`\n${reply.id} ${client.name} · ${seconds}s · ${JSON.stringify(out.usage)}`);
  console.log(`  line: ${out.draft.line_key} (${score.right_line ? "right" : "WRONG"}) · ${out.draft.finding} · recommend credit: ${out.draft.recommend_credit} (${score.right_call ? "right" : "WRONG"})`);
  console.log(`  cites: ${out.draft.cited_sources.join(", ")}${problem ? ` · PROBLEM: ${problem}` : ""}`);
  console.log(`  owner: ${out.draft.owner_summary}`);
}
console.log(`\nDrafts matching the hand-checked answers: ${ok}/${replies.length}`);

if (process.argv.includes("--save")) {
  const recorded = {
    _note: "Real Claude drafts for the demo's client replies, saved so the demo works without live API credit. Regenerate with: npm run eval:replies -- --save",
    // Keeps other saved rulings (the agent dispute in eval-settlement.js).
    drafts: { ...loadRecordedDrafts(), ...drafts },
  };
  fs.writeFileSync(path.join(DATA_DIR, "recorded-replies.json"), `${JSON.stringify(recorded, null, 2)}\n`);
  console.log("Saved data/recorded-replies.json");
}
