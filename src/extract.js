// The agent step: Claude reads the raw work log and reports what happened,
// item by item, with the rows it relied on. It never prices anything; the
// terms engine does that. With no API key, the hand-checked answer key stands
// in so the demo still runs (and the UI says so).
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DATA_DIR, renderForModel } from "./sources.js";

export const MODEL = "claude-opus-5-5";

export const OUTCOMES = [
  "held",
  "no_show",
  "rescheduled",
  "cancelled_by_client",
  "cancelled_by_prospect",
  "qualified",
  "unqualified",
  "not_reviewed",
  "unknown",
];

const ITEM_FIELDS = [
  "client_id", "kind", "person", "date", "time", "outcome", "cancelled_at", "duplicate_of",
  "no_show_reported_at", "dispute_email", "dispute_claim", "sources", "evidence", "unclear",
];

export function extractionSchema(clientIds) {
  const str = (description) => ({ type: "string", description });
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            client_id: { type: "string", enum: clientIds },
            kind: { type: "string", enum: ["appointment", "lead"] },
            person: str("The prospect's name as written in the log."),
            date: str("YYYY-MM-DD, local date from the log."),
            time: str("HH:MM 24-hour local time; empty for CRM leads."),
            outcome: { type: "string", enum: OUTCOMES },
            cancelled_at: str("YYYY-MM-DDTHH:MM when the client cancelled; empty otherwise."),
            duplicate_of: str("Ref of the earlier row this repeats (same person); empty otherwise."),
            no_show_reported_at: str("YYYY-MM-DDTHH:MM when the client reported the no-show; empty otherwise."),
            dispute_email: str("Email id (e.g. E5) disputing this line; empty otherwise."),
            dispute_claim: str("The client's claim in one sentence; empty otherwise."),
            sources: { type: "array", items: { type: "string" }, description: "Refs this item relies on, main row first." },
            evidence: str("One plain sentence on what the rows say."),
            unclear: str("Why the log can't settle this, in one sentence; empty when clear."),
          },
          required: ITEM_FIELDS,
          additionalProperties: false,
        },
      },
      ignored: {
        type: "array",
        items: {
          type: "object",
          properties: { source: { type: "string" }, why: { type: "string" } },
          required: ["source", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["items", "ignored"],
    additionalProperties: false,
  };
}

const SYSTEM_PROMPT = `You are the billing clerk for a lead-generation agency. You read the agency's raw work log for one month and report what happened, one item per real appointment or lead, so that a separate terms engine can price each item. You never price anything yourself.

How to read the log:
- Account for every tagged ref: each calendar row, CRM row and email appears in at least one item's sources or in "ignored" with a short reason (internal meetings, tests, sync duplicates, rows outside the billing period, emails with nothing billable in them).
- Outcomes: held; no_show; rescheduled (the original slot of a moved appointment, while the new slot is its own item); cancelled_by_client (the agency's client cancelled, with cancelled_at); cancelled_by_prospect; for CRM leads, qualified, unqualified or not_reviewed, judged against that client's own definition in its terms; unknown.
- A CRM lead that repeats an earlier person (same email, any capitalization) is its own item with duplicate_of set to the earlier row's ref.
- Client emails can change what happened (a reported no-show outweighs a Completed status) or dispute a line. Record when a client reported a no-show in no_show_reported_at. Record a dispute in dispute_email and dispute_claim, and keep the outcome the log shows.
- When the log doesn't settle what happened, or whether a client's definition is met, say why in "unclear" in one sentence instead of guessing. The agency owner decides those.
- evidence is one plain sentence the client would accept, saying what the row or email shows.
- Write dates as YYYY-MM-DD and times as HH:MM (24-hour), in the local wall-clock time the log shows; ignore UTC offsets. Use empty strings for fields that don't apply.`;

function describeAgency(agency) {
  const clients = agency.clients.map((c) =>
    [
      `<client id="${c.id}" name="${c.name}" also_written_as="${c.aliases.join("; ")}">`,
      ...c.terms_text,
      "</client>",
    ].join("\n"),
  );
  return [
    `<agency name="${agency.agency.name}" billing_period="${agency.period.start} to ${agency.period.end}">`,
    ...clients,
    "</agency>",
  ].join("\n");
}

export function checkShape(extraction) {
  if (!extraction || !Array.isArray(extraction.items) || !Array.isArray(extraction.ignored)) {
    throw new Error("Extraction must have items and ignored arrays.");
  }
  for (const [i, item] of extraction.items.entries()) {
    for (const f of ITEM_FIELDS) {
      if (!(f in item)) throw new Error(`Item ${i} is missing ${f}.`);
    }
    if (!Array.isArray(item.sources)) throw new Error(`Item ${i} sources must be a list.`);
    if (!OUTCOMES.includes(item.outcome)) throw new Error(`Item ${i} has unknown outcome ${item.outcome}.`);
  }
  return extraction;
}

export function extractFromAnswerKey(dataDir = DATA_DIR) {
  const key = JSON.parse(fs.readFileSync(path.join(dataDir, "answer-key.json"), "utf8"));
  return checkShape({ items: key.items, ignored: key.ignored });
}

export async function extractWithClaude({ agency, sources, client = new Anthropic() }) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: extractionSchema(agency.clients.map((c) => c.id)) },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${describeAgency(agency)}\n\n${renderForModel(sources)}`,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "Report every item for the billing period, and account for every ref." },
        ],
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined to read this log (${message.stop_details?.category ?? "no category"}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude ran out of output room before finishing the ledger.");
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    extraction: checkShape(JSON.parse(text)),
    model: message.model,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}
