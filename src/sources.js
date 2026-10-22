// Loads the raw work log (calendar export, CRM export, client emails) and gives
// every row a stable reference like "calendar:12", "crm:5" or "email:E3".
// Row numbers match what you see in a spreadsheet: the header is row 1.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

// Minimal RFC 4180 CSV line splitter: handles quoted fields with commas and "" escapes.
export function splitCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { fields.push(field); field = ""; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}

function csvRows(kind, label, text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitCsvLine(lines[0]);
  return {
    header: lines[0],
    rows: lines.slice(1).map((raw, i) => {
      const values = splitCsvLine(raw);
      const fields = Object.fromEntries(header.map((h, j) => [h, values[j] ?? ""]));
      const row = i + 2;
      return { ref: `${kind}:${row}`, kind, label: `${label} row ${row}`, raw, fields };
    }),
  };
}

function emailRows(text) {
  return text
    .split(/^=== (E\d+) ===\s*$/m)
    .slice(1)
    .reduce((out, part, i, arr) => {
      if (i % 2 === 0) {
        const id = part;
        const raw = arr[i + 1].trim();
        const header = (name) => (raw.match(new RegExp(`^${name}: (.*)$`, "m")) || [])[1] || "";
        out.push({
          ref: `email:${id}`,
          kind: "email",
          label: `Email ${id}`,
          raw,
          fields: { id, from: header("From"), date: header("Date"), subject: header("Subject") },
        });
      }
      return out;
    }, []);
}

export function loadAgency(dataDir = DATA_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "agency.json"), "utf8"));
}

export function loadSources(dataDir = DATA_DIR) {
  const read = (f) => fs.readFileSync(path.join(dataDir, "raw", f), "utf8");
  const calendarText = read("calendar_export.csv");
  const crmText = read("crm_leads.csv");
  const emailText = read("client_emails.txt");
  const calendar = csvRows("calendar", "Calendar", calendarText);
  const crm = csvRows("crm", "CRM", crmText);
  for (const r of crm.rows) r.label += ` (${r.fields.lead_id})`;
  const emails = emailRows(emailText);
  const all = [...calendar.rows, ...crm.rows, ...emails];
  const hash = crypto.createHash("sha256").update(calendarText + crmText + emailText).digest("hex").slice(0, 16);
  return {
    hash,
    calendar,
    crm,
    emails,
    byRef: Object.fromEntries(all.map((r) => [r.ref, r])),
    refs: all.map((r) => r.ref),
  };
}

// The text the agent reads: every row tagged with its reference.
export function renderForModel(sources) {
  const tag = (r) => `[${r.ref}] ${r.raw}`;
  return [
    "<calendar_export>",
    `[header] ${sources.calendar.header}`,
    ...sources.calendar.rows.map(tag),
    "</calendar_export>",
    "",
    "<crm_export client=\"cobalt-dental\">",
    `[header] ${sources.crm.header}`,
    ...sources.crm.rows.map(tag),
    "</crm_export>",
    "",
    "<client_emails>",
    ...sources.emails.map((e) => `[${e.ref}]\n${e.raw}\n`),
    "</client_emails>",
  ].join("\n");
}
