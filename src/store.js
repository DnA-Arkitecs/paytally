// App state on disk: the cached extraction, the owner's decisions, the current
// ledger, sent invoices (current and earlier), client reply and dispute
// threads, payments clients' agents asked for, payment methods clients saved in
// PayPal, every MCP call, PayPal webhook events already applied, and an
// activity log. One JSON file; fine for a demo. The agent settlement's running
// transcript has its own file, so a long PayPal call elsewhere can't overwrite it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VAR_DIR = process.env.PAYTALLY_VAR_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "var");
const FILE = path.join(VAR_DIR, "state.json");
const SETTLEMENT_FILE = path.join(VAR_DIR, "settlement.json");

const empty = () => ({
  extraction: null,
  live: null,
  resolutions: {},
  ledger: null,
  invoices: {},
  history: [],
  threads: {},
  payment_requests: {},
  saved_methods: {},
  mcp_log: [],
  seen_events: [],
  activity: [],
});

const emptySettlement = () => ({ client_id: null, mode: null, running: null, phases_done: [], steps: [], messages: [], id_map: {}, notice: "", model: null, usage: null });

export function loadSettlement() {
  try {
    return { ...emptySettlement(), ...JSON.parse(fs.readFileSync(SETTLEMENT_FILE, "utf8")) };
  } catch {
    return emptySettlement();
  }
}

// Load, change and save in one synchronous step, so concurrent requests can't
// lose each other's changes.
export function updateSettlement(fn) {
  const s = loadSettlement();
  fn(s);
  fs.mkdirSync(VAR_DIR, { recursive: true });
  fs.writeFileSync(SETTLEMENT_FILE, JSON.stringify(s, null, 2));
  return s;
}

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
  updateSettlement((s) => Object.assign(s, emptySettlement()));
}

export function logMcp(state, entry) {
  state.mcp_log.unshift({ at: new Date().toISOString(), ...entry });
  state.mcp_log = state.mcp_log.slice(0, 100);
}
