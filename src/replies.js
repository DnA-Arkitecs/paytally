// The dispute step: a client replies to a sent invoice and questions a line.
// Claude finds the line, checks the rows it came from against the client's
// terms, and drafts two replies (one if the owner credits the line, one if the
// charge stands). It recommends; it never decides. The owner chooses, code
// computes any credit, and PayPal only hears about it through the owner's click.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DATA_DIR, renderForModel } from "./sources.js";
import { MODEL } from "./extract.js";

export const FINDINGS = ["log_supports_charge", "log_supports_client", "log_cannot_settle"];

const DRAFT_FIELDS = ["line_key", "finding", "cited_sources", "recommend_credit", "owner_summary", "reply_if_credit", "reply_if_no_credit"];

export function loadClientReplies(dataDir = DATA_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "client-replies.json"), "utf8")).replies;
}

export function draftSchema(lineKeys) {
  const str = (description) => ({ type: "string", description });
  return {
    type: "object",
    properties: {
      line_key: { type: "string", enum: lineKeys, description: "The invoice line the client is questioning." },
      finding: { type: "string", enum: FINDINGS },
      cited_sources: { type: "array", items: { type: "string" }, description: "Refs of the rows and emails your finding rests on, main row first; \"terms\" for the agreement." },
      recommend_credit: { type: "boolean", description: "Whether you recommend the owner credit this line." },
      owner_summary: str("Two or three plain sentences for the owner: what the client says, what the cited rows and terms show, and your recommendation."),
      reply_if_credit: str("The email reply if the owner credits the line."),
      reply_if_no_credit: str("The email reply if the owner keeps the charge."),
    },
    required: DRAFT_FIELDS,
    additionalProperties: false,
  };
}

const SYSTEM_PROMPT = `You help the owner of a lead-generation agency answer clients who question a line on an invoice that has already been sent. You read the client's email, find the line they mean, check the work-log rows that line came from against that client's terms, and draft the owner's reply. You recommend; the owner decides whether to credit the line, and the billing system computes any amount.

How to judge:
- log_supports_charge: the rows and the terms show the charge is right, and the client's point doesn't change that.
- log_supports_client: the rows or the terms show the client is right.
- log_cannot_settle: the rows don't show what happened (for example, a status with nothing to back it) and the client is reporting something only they would know. Weigh what the terms say about such reports.
- Recommend a credit when the client is right, or when the log can't settle it and the terms favour the client's account. Otherwise recommend keeping the charge.
- Cite only refs that appear in the work log, plus "terms" for the agreement. Never claim a row says something it doesn't.

How to write the replies:
- Short (under 120 words), warm and plain, from the owner, signed with the owner's first name and the agency's name. No subject line.
- Point to the evidence the way the client would recognise it (the date, the person, what the row says, the clause of their terms), not by internal refs.
- reply_if_credit says the line comes off and what PayPal does next: if the invoice is paid, PayPal refunds that line; if it is unpaid, PayPal cancels it and sends a corrected invoice. Do not state amounts.
- reply_if_no_credit explains, with the evidence, why the charge stands, and offers to talk it through.`;

function describe({ agency, client, invoice }) {
  const lines = invoice.lines.map(
    (l) => `<line key="${l.key}" date="${l.date}" amount="${l.amount.toFixed(2)}" sources="${l.sources.join(", ")}">${l.item}. ${l.reason}</line>`,
  );
  return [
    `<agency name="${agency.agency.name}" owner="${agency.agency.owner}" />`,
    `<client id="${client.id}" name="${client.name}" contact="${client.contact}">`,
    ...client.terms_text,
    "</client>",
    `<invoice number="${invoice.number}" period="${invoice.period}" total="${invoice.total.toFixed(2)}" status="${invoice.paid ? "paid" : "unpaid"}">`,
    ...lines,
    "</invoice>",
  ].join("\n");
}

export function checkDraftShape(draft) {
  if (!draft || typeof draft !== "object") throw new Error("The draft must be an object.");
  for (const f of DRAFT_FIELDS) if (!(f in draft)) throw new Error(`The draft is missing ${f}.`);
  if (!FINDINGS.includes(draft.finding)) throw new Error(`Unknown finding ${draft.finding}.`);
  if (!Array.isArray(draft.cited_sources)) throw new Error("cited_sources must be a list.");
  return draft;
}

// Code checks the agent: the line must be on this invoice and every cited row
// must exist. Returns the problem in one sentence, or "" when the draft holds.
export function draftProblem(draft, invoice, sources) {
  if (!invoice.lines.some((l) => l.key === draft.line_key)) return `The draft is about a line (${draft.line_key}) that is not on this invoice.`;
  const missing = draft.cited_sources.filter((ref) => ref !== "terms" && !sources.byRef[ref]);
  if (missing.length) return `The draft cites ${missing.join(", ")}, which is not in the work log.`;
  if (!draft.cited_sources.length) return "The draft cites no rows.";
  return "";
}

export function scoreDraft(draft, expected, invoice) {
  const line = invoice.lines.find((l) => l.key === draft.line_key);
  const right_line = Boolean(line && line.item.includes(expected.person));
  const right_call = draft.recommend_credit === expected.recommend_credit;
  return { right_line, right_call, ok: right_line && right_call };
}

export function loadRecordedDrafts(dataDir = DATA_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "recorded-replies.json"), "utf8")).drafts;
  } catch {
    return {};
  }
}

export async function draftReplyWithClaude({ agency, client, invoice, sources, reply, anthropic = new Anthropic() }) {
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: draftSchema(invoice.lines.map((l) => l.key)) },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: renderForModel(sources), cache_control: { type: "ephemeral" } },
          {
            type: "text",
            text: `${describe({ agency, client, invoice })}\n\n<client_reply from="${reply.from}" subject="${reply.subject}">\n${reply.body}\n</client_reply>\n\nFind the line this reply is about, judge it against the rows and the terms, and draft both replies.`,
          },
        ],
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined to draft this reply (${message.stop_details?.category ?? "no category"}).`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude ran out of output room before finishing the draft.");
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    draft: checkDraftShape(JSON.parse(text)),
    model: message.model,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}
