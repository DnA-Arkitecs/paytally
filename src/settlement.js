// What a client's own AI agent can see and ask for through PayTally's MCP
// server (src/mcp.js). Everything here is scoped to one client. The client's
// agent can read its bill, see the proof behind any line, dispute a line and
// ask to pay. It never changes a price, applies a credit or moves money: a
// credit waits for the agency owner's click, a payment for the client's human.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./sources.js";
import * as collect from "./collect.js";

export function loadClientAgents(dataDir = DATA_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "client-agents.json"), "utf8")).agents;
}

export class AgentError extends Error {}

const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const owed = (r) => Math.round((r.total - r.paid) * 100) / 100;

const clientRecords = (state, clientId) => collect.allRecords(state).filter((r) => r.client_id === clientId);

function findInvoice(state, clientId, number) {
  const record = clientRecords(state, clientId).find((r) => String(r.number) === String(number).trim());
  if (!record) throw new AgentError(`No invoice ${number} for this client. Call get_ledger for the invoice numbers.`);
  return record;
}

const disputesOn = (state, record) => Object.values(state.threads).filter((t) => t.client_id === record.client_id && t.invoice_number === record.number);

function invoiceView(state, record) {
  const replacedBy = record.replaced_by && collect.findRecord(state, record.replaced_by);
  const replaces = record.replaces && collect.findRecord(state, record.replaces);
  return {
    invoice_number: record.number,
    period: record.period,
    paypal_status: record.status,
    total: record.total,
    paid: record.paid,
    refunded: record.refunded,
    owed: collect.OPEN.has(record.status) ? owed(record) : 0,
    invoice_date: record.invoice_date,
    due_date: record.due_date,
    pay_in_paypal: record.href || null,
    replaces_invoice: replaces?.number || null,
    replaced_by_invoice: replacedBy?.number || null,
    lines: record.items.map((l) => ({ line_key: l.key, date: l.date, item: l.item, amount: l.amount, reason: l.reason, source_refs: l.sources })),
    disputes: disputesOn(state, record).map((t) => ({ dispute_id: t.id, line_key: t.line_key || t.draft?.line_key || null, status: t.status })),
  };
}

// get_ledger: every invoice this client has had, newest first, each line with
// its reason and source rows, plus what was deliberately not billed and why.
export function ledgerView(state, agency, clientId) {
  const client = agency.clients.find((c) => c.id === clientId);
  const records = clientRecords(state, clientId).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date) || (a.status === "CANCELLED") - (b.status === "CANCELLED"));
  const notBilled = (state.ledger?.lines || [])
    .filter((l) => l.client_id === clientId && l.status === "no_charge")
    .map((l) => ({ date: l.date, item: l.item, reason: l.reason, source_refs: l.sources }));
  return {
    from: agency.agency.name,
    client: client.name,
    period: agency.period.label,
    agreement: client.terms_text,
    invoices: records.map((r) => invoiceView(state, r)),
    not_billed_this_period: notBilled,
    note: records.length
      ? "Each line names the work-log rows it comes from; explain_charge shows those rows word for word."
      : `No invoice sent yet for ${agency.period.label}.`,
  };
}

function lineOnInvoice(state, clientId, lineKey) {
  for (const record of clientRecords(state, clientId)) {
    const line = record.items.find((l) => l.key === lineKey);
    if (line) return { record, line };
  }
  throw new AgentError(`No line ${lineKey} on this client's invoices. Use a line_key from get_ledger.`);
}

// explain_charge: the line, the clause it applied, and its source rows exactly
// as they appear in the agency's work log.
export function explainCharge(state, agency, sources, clientId, lineKey) {
  const { record, line } = lineOnInvoice(state, clientId, lineKey);
  const client = agency.clients.find((c) => c.id === clientId);
  const clauses = [...new Set(line.reason.match(/§\d+/g) || [])];
  return {
    line_key: line.key,
    on_invoice: record.number,
    invoice_status: record.status,
    date: line.date,
    item: line.item,
    amount: line.amount,
    reason: line.reason,
    clauses_applied: client.terms_text.filter((t) => clauses.some((c) => t.startsWith(c))),
    source_rows: line.sources.map((ref) =>
      ref === "terms" ? { ref, what: "The client agreement" } : sources.byRef[ref] ? { ref, what: sources.byRef[ref].label, text: sources.byRef[ref].raw } : { ref, what: "Not in this month's work log" },
    ),
    calendar_header: line.sources.some((r) => r.startsWith("calendar:")) ? sources.calendar.header : undefined,
  };
}

// dispute_line: opens a dispute thread the owner sees next to emailed replies.
export function openDispute(state, agency, agent, { line_key, reason, evidence = "" }) {
  const { record, line } = lineOnInvoice(state, agent.client_id, line_key);
  if (record.status === "CANCELLED") throw new AgentError(`Invoice ${record.number} was cancelled; dispute lines on ${record.replaced_by ? "the corrected invoice" : "a current invoice"}.`);
  const open = disputesOn(state, record).find((t) => t.line_key === line_key && t.status === "open");
  if (open) throw new AgentError(`This line is already in dispute (${open.id}). Call get_dispute.`);
  const client = agency.clients.find((c) => c.id === agent.client_id);
  const id = `A${Object.values(state.threads).filter((t) => t.channel === "agent").length + 1}`;
  const thread = {
    id,
    channel: "agent",
    client_id: client.id,
    client_name: client.name,
    from: `${agent.name}, for ${agent.human} (via MCP)`,
    subject: `Dispute: ${line.item}`,
    body: [String(reason).trim(), evidence ? `Evidence from our records: ${String(evidence).trim()}` : ""].filter(Boolean).join("\n\n").slice(0, 3000),
    arrived_at: new Date().toISOString(),
    invoice_number: record.number,
    line_key,
    recording_key: `agent|${line_key}`,
    status: "open",
    draft: null,
    draft_meta: null,
    answer: null,
  };
  state.threads[id] = thread;
  return thread;
}

const citedRows = (sources, refs) => refs.map((ref) => (ref === "terms" ? { ref, what: "The client agreement" } : { ref, what: sources.byRef[ref]?.label || ref, text: sources.byRef[ref]?.raw }));

// get_dispute / the answer to dispute_line. The agency agent's finding is shown
// as a recommendation to the owner; only the owner's answer settles it.
export function disputeView(state, sources, thread, credit, owner) {
  const d = thread.draft;
  const out = {
    dispute_id: thread.id,
    line_key: thread.line_key,
    invoice_number: thread.invoice_number,
    status: thread.status === "open" ? `waiting for ${owner} (agency owner) to decide` : "answered",
    agency_agent: d
      ? {
          finding: d.finding.replace(/_/g, " "),
          recommends: d.recommend_credit ? "credit the line" : "keep the charge",
          summary: d.owner_summary,
          rows_checked: citedRows(sources, d.cited_sources),
        }
      : null,
  };
  if (thread.status === "open" && credit?.how) {
    out.if_credited = {
      credit: credit.amount,
      new_invoice_total: credit.new_total,
      in_paypal: credit.how === "refund" ? "PayPal refunds the credit" : "PayPal cancels this invoice and sends a corrected one",
    };
  }
  if (thread.answer) {
    const next = thread.answer.decision === "credit" && thread.answer.how === "corrected_invoice" ? state.invoices[thread.client_id] : null;
    out.answer = {
      decision: thread.answer.decision === "credit" ? "credited" : "charge stands",
      credit: thread.answer.credit || 0,
      in_paypal: thread.answer.decision !== "credit" ? "nothing changes" : thread.answer.how === "refund" ? "refund" : "invoice cancelled and corrected",
      corrected_invoice: next ? { invoice_number: next.number, total: next.total, owed: owed(next), paypal_status: next.status } : null,
      reply_from_owner: thread.answer.text,
      answered_at: thread.answer.at,
    };
  }
  return out;
}

// approve_and_pay: the client's agent asks to pay one invoice. Checked against
// the client's mandate here; nothing moves until the client's human approves.
export function requestPayment(state, agent, { invoice_number, amount }) {
  const record = findInvoice(state, agent.client_id, invoice_number);
  const due = owed(record);
  if (!collect.OPEN.has(record.status)) throw new AgentError(`Invoice ${record.number} is ${record.status.toLowerCase().replace(/_/g, " ")}; there is nothing to pay on it.`);
  if (record.awaiting) throw new AgentError(`Invoice ${record.number} is waiting for PayPal to confirm a change. Try again in a minute.`);
  const open = disputesOn(state, record).filter((t) => t.status === "open");
  if (open.length) throw new AgentError(`Invoice ${record.number} has ${open.length} open dispute(s) (${open.map((t) => t.id).join(", ")}). Wait for the agency's answer.`);
  if (Math.round(Number(amount) * 100) !== Math.round(due * 100)) throw new AgentError(`The amount owed on invoice ${record.number} is ${money(due)}, not ${money(Number(amount) || 0)}. Pay the exact amount owed.`);
  if (due > agent.cap) throw new AgentError(`${money(due)} is above the ${money(agent.cap)} cap ${agent.human} set for you. Ask ${agent.human} to pay it or raise the cap.`);
  const pending = Object.values(state.payment_requests).find((p) => p.paypal_id === record.paypal_id && p.status === "awaiting_approval");
  if (pending) return pending;
  const request = {
    id: `PR-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    client_id: agent.client_id,
    paypal_id: record.paypal_id,
    invoice_number: record.number,
    amount: due,
    currency: "USD",
    payee: record.period,
    requested_by: agent.name,
    approver: agent.human,
    cap: agent.cap,
    status: "awaiting_approval",
    requested_at: new Date().toISOString(),
    approved_at: null,
    paypal: null,
  };
  state.payment_requests[request.id] = request;
  return request;
}

export function paymentView(state, request) {
  const record = collect.findRecord(state, request.paypal_id);
  const status = {
    awaiting_approval: `waiting for ${request.approver} to approve it`,
    declined: `${request.approver} declined it`,
    sending: "approved; PayPal is taking the payment",
    sent_to_paypal: "approved; PayPal took the payment and its webhook is on the way",
    paid: "paid through PayPal",
    failed: "PayPal did not complete it",
  }[request.status];
  return {
    payment_id: request.id,
    invoice_number: request.invoice_number,
    amount: request.amount,
    status,
    within_cap: `${money(request.amount)} of a ${money(request.cap)} cap`,
    paypal: request.paypal,
    invoice_paypal_status: record?.status || null,
    approved_at: request.approved_at,
  };
}
