// After an invoice goes out: the record PayTally keeps of each PayPal invoice,
// what PayPal's webhooks change on it, and which invoices are overdue.
// PayPal is the source of truth for status; PayTally tracks the due date,
// because the agency's terms (not PayPal) set it.
export const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
export const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);

const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const allRecords = (state) => [...Object.values(state.invoices), ...state.history];
export const findRecord = (state, paypalId) => allRecords(state).find((r) => r.paypal_id === paypalId) || null;

export function newRecord({ draft, invoice, approval, mode, kind = "current" }) {
  return {
    paypal_id: invoice.id,
    number: invoice.number,
    kind,
    client_id: draft.client_id,
    client_name: draft.client_name,
    period: draft.period.label,
    total: draft.total,
    lines: draft.lines.length,
    items: draft.lines,
    to: draft.billing_email,
    invoice_date: draft.invoice_date,
    due_date: draft.due_date,
    status: invoice.status,
    href: invoice.payer_url,
    approved_by: approval.approved_by,
    approved_at: approval.approved_at,
    approval_hash: approval.hash,
    mode,
    paid: 0,
    refunded: 0,
    paid_at: null,
    paid_via: "",
    reminders: [],
    payments: [],
    refunds: [],
    awaiting: null,
    replaces: draft.replaces?.id || null,
    replaced_by: null,
  };
}

// What Claude and the dispute screen read about a sent invoice.
export const invoiceView = (record) => ({ number: record.number, period: record.period, total: record.total, paid: record.paid > 0, lines: record.items });

// Demo replies arrive at a set point: "paid" after the client pays, "unpaid" before.
export const replyCanArrive = (reply, record) => Boolean(record) && (reply.arrives === "paid" ? PAID.has(record.status) : OPEN.has(record.status));

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function daysOverdue(record, today) {
  if (!OPEN.has(record.status)) return 0;
  return Math.max(0, daysBetween(record.due_date, today));
}

// The reminder the owner reviews. Built in code so dates and amounts are exact;
// the owner's approval is tied to this exact text.
export function reminderFor(record, agency, today) {
  const days = daysOverdue(record, today);
  const owed = record.total - record.paid;
  return {
    kind: "reminder",
    invoice_id: record.paypal_id,
    subject: `Reminder: ${agency.agency.name} invoice ${record.number} (${record.period})`,
    note: `Invoice ${record.number} for ${money(owed)} (${record.period}) was due on ${longDate(record.due_date)}, ${days} day${days === 1 ? "" : "s"} ago. Each line on it names the work-log row it comes from, so it should be quick to check. If anything looks off, reply and we'll sort it out. Thank you, ${agency.agency.owner.split(" ")[0]}, ${agency.agency.name}`,
  };
}

// Which invoice a PayPal event is about: invoice events name it; a capture
// carries the invoice id in custom_id; a refund links back to its capture.
export function recordForEvent(state, event) {
  const r = event.resource || {};
  if (event.event_type.startsWith("INVOICING.")) return findRecord(state, r.invoice?.id);
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") return findRecord(state, r.custom_id);
  const captureId = (r.links || []).find((l) => l.rel === "up")?.href?.split("/").pop();
  return allRecords(state).find((rec) => rec.payments?.some((p) => p.capture_id === captureId)) || null;
}

// Applies one PayPal webhook event. Returns the activity line, or "" when the
// event is a repeat or is about an invoice this app does not track.
export function applyEvent(state, event, via) {
  const inv = event.resource?.invoice || {};
  const record = recordForEvent(state, event);
  if (!record || state.seen_events.includes(event.id)) return "";
  state.seen_events = [event.id, ...state.seen_events].slice(0, 200);
  const label = `${record.client_name} invoice ${record.number}`;
  switch (event.event_type) {
    case "INVOICING.INVOICE.PAID":
      record.status = inv.status || "PAID";
      record.paid = Number(inv.payments?.paid_amount?.value ?? record.total);
      record.paid_at = event.create_time;
      record.paid_via = via;
      record.awaiting = null;
      return `${via}: ${label} paid (${money(record.paid)}). Marked paid.`;
    case "INVOICING.INVOICE.CANCELLED":
      record.status = "CANCELLED";
      return `${via}: ${label} cancelled.`;
    case "INVOICING.INVOICE.REFUNDED":
      record.status = inv.status || "PARTIALLY_REFUNDED";
      record.refunded = Number(inv.refunds?.refund_amount?.value ?? record.refunded);
      record.awaiting = null;
      return `${via}: ${label} refund of ${money(record.refunded)} recorded.`;
    case "PAYMENT.CAPTURE.COMPLETED":
      return `${via}: PayPal captured ${money(Number(event.resource.amount?.value || 0))} for ${label} (capture ${event.resource.id}). The money moved.`;
    case "PAYMENT.CAPTURE.REFUNDED":
      return `${via}: PayPal refunded ${money(Number(event.resource.amount?.value || 0))} to ${record.client_name} on ${label} (refund ${event.resource.id}). The money moved back.`;
    default:
      return "";
  }
}

// Brings a record in line with what PayPal reports when asked directly (the
// "Check PayPal" button). Returns the activity line, or "" when nothing changed.
export function reconcile(record, summary) {
  if (!summary || summary.status === record.status) return "";
  const was = record.status;
  record.status = summary.status;
  record.paid = summary.paid;
  record.refunded = summary.refunded;
  record.awaiting = null;
  if (summary.paid && !record.paid_at) {
    record.paid_at = new Date().toISOString();
    record.paid_via = "checked PayPal";
  }
  return `Checked PayPal: ${record.client_name} invoice ${record.number} is ${summary.status.toLowerCase().replace(/_/g, " ")} (was ${was.toLowerCase().replace(/_/g, " ")}).`;
}
