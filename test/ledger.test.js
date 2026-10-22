import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgency, loadSources } from "../src/sources.js";
import { extractFromAnswerKey } from "../src/extract.js";
import { buildLedger, invoiceDraft } from "../src/ledger.js";

const agency = loadAgency();
const sources = loadSources();
const build = (resolutions = {}, extraction = extractFromAnswerKey()) =>
  buildLedger({ agency, extraction, sources, resolutions, extractor: { kind: "answer_key" } });
const client = (ledger, id) => ledger.clients.find((c) => c.id === id);
const line = (ledger, person, clientId) => ledger.lines.find((l) => l.person === person && (!clientId || l.client_id === clientId));

test("the work log has 30 calendar rows, 18 CRM rows and 7 emails", () => {
  assert.equal(sources.calendar.rows.length, 30);
  assert.equal(sources.crm.rows.length, 18);
  assert.equal(sources.emails.length, 7);
  assert.equal(sources.byRef["calendar:4"].fields.Subject, "Roof estimate call - Dana Whitfield (Harbor & Pine)");
  assert.equal(sources.byRef["calendar:5"].fields.Notes, "went well, wants a quote");
});

test("the answer key accounts for every row", () => {
  const ledger = build();
  assert.equal(ledger.unassigned_flags, 0);
});

test("Harbor & Pine: $150 per held call, no-shows free, late client cancel billed", () => {
  const ledger = build();
  assert.equal(client(ledger, "harbor-pine").total, 1050);
  assert.equal(client(ledger, "harbor-pine").open_flags, 1);
  assert.equal(line(ledger, "Luis Ortega").status, "no_charge");
  assert.match(line(ledger, "Ava Brooks").reason, /15\.8 hours ahead, under 24 hours: billed/);
  assert.equal(line(ledger, "Sofia Reyes").status, "flagged");
  const tom = ledger.lines.filter((l) => l.person === "Tom Ellery");
  assert.deepEqual(tom.map((l) => l.amount), [0, 150]);
});

test("Cobalt: retainer plus $45 per qualified lead, duplicates count once", () => {
  const ledger = build();
  const c = client(ledger, "cobalt-dental");
  assert.equal(c.total, 1200 + 11 * 45);
  assert.equal(c.open_flags, 2);
  const amelia = ledger.lines.filter((l) => l.person === "Amelia Hart");
  assert.deepEqual(amelia.map((l) => l.amount), [45, 0]);
  assert.match(amelia[1].reason, /counts once a month/);
});

test("Mesa Ridge: 48-hour no-show window and the 9th-consultation tier", () => {
  const ledger = build();
  assert.equal(line(ledger, "Owen Fischer").amount, 0);
  assert.equal(line(ledger, "Imani Scott").amount, 200);
  assert.match(line(ledger, "Imani Scott").reason, /past the 48-hour window/);
  assert.equal(line(ledger, "Robert Okafor").status, "flagged");
  assert.equal(line(ledger, "Lena Moretti").amount, 250);
  assert.equal(client(ledger, "mesa-ridge").total, 7 * 200 + 3 * 250);
});

test("crediting a disputed line re-prices the lines after it", () => {
  const key = line(build(), "Robert Okafor").key;
  const credited = build({ [key]: { decision: "no_charge", note: "prior quote", at: "x" } });
  assert.equal(line(credited, "Robert Okafor").amount, 0);
  assert.equal(line(credited, "Lena Moretti").amount, 200);
  assert.equal(client(credited, "mesa-ridge").total, 8 * 200 + 2 * 250);
  assert.equal(client(credited, "mesa-ridge").open_flags, 0);

  const billed = build({ [key]: { decision: "bill", note: "", at: "x" } });
  assert.equal(line(billed, "Robert Okafor").amount, 200);
  assert.equal(client(billed, "mesa-ridge").total, 8 * 200 + 3 * 250);
});

test("rows the agent skips or invents become flags, not charges", () => {
  const extraction = extractFromAnswerKey();
  extraction.ignored = extraction.ignored.filter((i) => i.source !== "calendar:13");
  extraction.items[0] = { ...extraction.items[0], sources: ["calendar:99"] };
  extraction.items.push({ ...extraction.items[1] });
  const ledger = build({}, extraction);
  const unassigned = ledger.lines.filter((l) => l.client_id === "unassigned");
  assert.deepEqual(unassigned.map((l) => l.sources[0]), ["calendar:3", "calendar:13"]);
  assert.match(line(ledger, "Hannah Price").flag, /calendar:99/);
  const dana = ledger.lines.filter((l) => l.person === "Dana Whitfield");
  assert.equal(dana.length, 2);
  assert.match(dana[1].flag, /already on another line/);
});

test("the invoice draft carries only billed lines", () => {
  const draft = invoiceDraft(build(), agency, "harbor-pine");
  assert.equal(draft.lines.length, 7);
  assert.equal(draft.total, 1050);
  assert.ok(draft.lines.every((l) => l.amount > 0 && l.reason && l.sources.length));
});
