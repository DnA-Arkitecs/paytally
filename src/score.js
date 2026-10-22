// Compares an extraction with the hand-checked answer key, item by item, keyed
// on each item's main row. Same client, outcome, duplicate and flag = a match.
import { primarySource } from "./terms.js";

const flagged = (i) => Boolean(i.unclear || i.dispute_email);
const show = (i) => `${i.client_id}/${i.outcome}${flagged(i) ? "/flag" : ""}`;

export function scoreExtraction(extraction, answerKey) {
  const byRow = (items) => new Map(items.map((i) => [primarySource(i), i]));
  const want = byRow(answerKey.items);
  const got = byRow(extraction.items);
  let matching = 0;
  const misses = [];
  for (const [row, w] of want) {
    const g = got.get(row);
    const same =
      g &&
      g.client_id === w.client_id &&
      g.outcome === w.outcome &&
      Boolean(g.duplicate_of) === Boolean(w.duplicate_of) &&
      flagged(g) === flagged(w);
    if (same) matching += 1;
    else misses.push(`${row} ${w.person}: want ${show(w)}, got ${g ? show(g) : "nothing"}`);
  }
  const extra = [...got.keys()].filter((row) => !want.has(row));
  return { matching, of: want.size, misses, extra };
}
