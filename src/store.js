// App state on disk: the cached extraction, the owner's decisions, the current
// ledger, sent invoices (current and earlier), client reply threads, PayPal
// webhook events already applied, and an activity log. One JSON file; fine for a demo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VAR_DIR = process.env.PAYTALLY_VAR_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "var");
const FILE = path.join(VAR_DIR, "state.json");

const empty = () => ({ extraction: null, live: null, resolutions: {}, ledger: null, invoices: {}, history: [], threads: {}, seen_events: [], activity: [] });

export function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return empty();
  }
}

export function save(state) {
  fs.mkdirSync(VAR_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function log(state, text, kind = "info") {
  state.activity.unshift({ at: new Date().toISOString(), kind, text });
  state.activity = state.activity.slice(0, 200);
}

export function reset() {
  save(empty());
}
