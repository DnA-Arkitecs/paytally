// App state on disk: the cached extraction, the owner's decisions, the current
// ledger, sent invoices (current and earlier), client reply and dispute
// threads, payments clients' agents asked for, payment methods clients saved in
// PayPal, every MCP call, PayPal webhook events already applied, and an
// activity log. One JSON file; fine for a demo. The agent settlement's running
// transcript has its own file, so a long PayPal call elsewhere can't overwrite it.
//
// Each browser has its own demo (a cookie names it), so two judges on the
// public link never see or reset each other's work. The demo is carried with
// the request (AsyncLocalStorage), so everything below reads and writes the
// right one. Scripts and tests send no cookie and share the "main" demo.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

export const VAR_DIR = process.env.PAYTALLY_VAR_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "var");
export const MAIN = "main";
const DEMOS_DIR = path.join(VAR_DIR, "demos");
const demo = new AsyncLocalStorage();

export const isDemoId = (id) => id === MAIN || /^[a-f0-9]{16}$/.test(String(id));
export const currentDemo = () => demo.getStore() || MAIN;
export const inDemo = (id, fn) => demo.run(isDemoId(id) ? id : MAIN, fn);
const dir = () => (currentDemo() === MAIN ? VAR_DIR : path.join(DEMOS_DIR, currentDemo()));
const stateFile = () => path.join(dir(), "state.json");
const settlementFile = () => path.join(dir(), "settlement.json");

// Every demo on this server, "main" first.
export function demoIds() {
  let ids = [];
  try {
    ids = fs.readdirSync(DEMOS_DIR).filter((id) => id !== MAIN && isDemoId(id));
  } catch {}
  return [MAIN, ...ids];
}

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
    return { ...emptySettlement(), ...JSON.parse(fs.readFileSync(settlementFile(), "utf8")) };
  } catch {
    return emptySettlement();
  }
}

// Load, change and save in one synchronous step, so concurrent requests can't
// lose each other's changes.
export function updateSettlement(fn) {
  const s = loadSettlement();
  fn(s);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(settlementFile(), JSON.stringify(s, null, 2));
  return s;
}

export function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(stateFile(), "utf8")) };
  } catch {
    return empty();
  }
}

export function save(state) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
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
