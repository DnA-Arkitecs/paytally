// Scores Claude's reading of the work log against the hand-checked answer key.
// Needs ANTHROPIC_API_KEY. Each run is one Claude call (about $0.30 at list prices).
//   npm run eval               score only
//   npm run eval -- --save     also save the run as data/recorded-run.json, the demo's default
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, loadAgency, loadSources } from "../src/sources.js";
import { extractWithClaude, extractFromAnswerKey } from "../src/extract.js";
import { buildLedger } from "../src/ledger.js";
import { scoreExtraction } from "../src/score.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}

const agency = loadAgency();
const sources = loadSources();
const key = extractFromAnswerKey();
const started = Date.now();
const { extraction, model, usage } = await extractWithClaude({ agency, sources });
const seconds = Math.round((Date.now() - started) / 1000);
const score = scoreExtraction(extraction, key);

const totals = (x) => buildLedger({ agency, extraction: x, sources, extractor: {} }).clients.map((c) => `${c.id} $${c.total} (${c.open_flags} flags)`).join(", ");

if (process.argv.includes("--save")) {
  const recorded = {
    _note: "A real Claude run over data/raw, saved so the demo works without live API credit. Regenerate with: npm run eval -- --save",
    model,
    recorded_at: new Date().toISOString(),
    seconds,
    usage,
    source_hash: sources.hash,
    score,
    extraction,
  };
  fs.writeFileSync(path.join(DATA_DIR, "recorded-run.json"), `${JSON.stringify(recorded, null, 2)}\n`);
  console.log("Saved data/recorded-run.json");
}

console.log(`Model: ${model} · ${seconds}s · tokens: ${JSON.stringify(usage)}`);
console.log(`Items matching the answer key: ${score.matching}/${score.of}`);
if (score.misses.length) console.log(`Misses:\n  ${score.misses.join("\n  ")}`);
if (score.extra.length) console.log(`Items not in the answer key: ${score.extra.join(", ")}`);
console.log(`Answer key ledger: ${totals(key)}`);
console.log(`Claude ledger:     ${totals(extraction)}`);
