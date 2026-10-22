// Scores Claude's reading of the work log against the hand-checked answer key.
// Needs ANTHROPIC_API_KEY. Each run is one Claude call (about $0.25 at current prices).
//   npm run eval
import { loadAgency, loadSources } from "../src/sources.js";
import { extractWithClaude, extractFromAnswerKey } from "../src/extract.js";
import { buildLedger } from "../src/ledger.js";
import { primarySource } from "../src/terms.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}

const agency = loadAgency();
const sources = loadSources();
const key = extractFromAnswerKey();
const started = Date.now();
const { extraction, model, usage } = await extractWithClaude({ agency, sources });

const byRow = (items) => new Map(items.map((i) => [primarySource(i), i]));
const want = byRow(key.items);
const got = byRow(extraction.items);
const flagged = (i) => Boolean(i.unclear || i.dispute_email);

let match = 0;
const misses = [];
for (const [row, w] of want) {
  const g = got.get(row);
  const same = g && g.client_id === w.client_id && g.outcome === w.outcome && Boolean(g.duplicate_of) === Boolean(w.duplicate_of) && flagged(g) === flagged(w);
  if (same) match += 1;
  else misses.push(`${row} ${w.person}: want ${w.client_id}/${w.outcome}${flagged(w) ? "/flag" : ""}, got ${g ? `${g.client_id}/${g.outcome}${flagged(g) ? "/flag" : ""}` : "nothing"}`);
}
const extra = [...got.keys()].filter((row) => !want.has(row));

const totals = (x) => buildLedger({ agency, extraction: x, sources, extractor: {} }).clients.map((c) => `${c.id} $${c.total} (${c.open_flags} flags)`).join(", ");

console.log(`Model: ${model} · ${Math.round((Date.now() - started) / 1000)}s · tokens in ${usage.input_tokens}, out ${usage.output_tokens}`);
console.log(`Items matching the answer key: ${match}/${want.size}`);
if (misses.length) console.log(`Misses:\n  ${misses.join("\n  ")}`);
if (extra.length) console.log(`Items not in the answer key: ${extra.join(", ")}`);
console.log(`Answer key ledger: ${totals(key)}`);
console.log(`Claude ledger:     ${totals(extraction)}`);
