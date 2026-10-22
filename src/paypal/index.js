// The only door to PayPal. Every call that reaches a client (an invoice, a
// reminder, a cancellation, a refund) first checks the owner's approval of that
// exact action. In the sandbox the calls go through the PayPal Agent Toolkit's
// invoicing tools (sandbox.js); otherwise a local stand-in answers (mock.js).
//
// PayPal stays mocked until PAYPAL_MODE=sandbox and both sandbox keys are set.
import { assertApproved } from "../approvals.js";
import * as mock from "./mock.js";
import * as sandbox from "./sandbox.js";

export const mode =
  process.env.PAYPAL_MODE === "sandbox" && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
    ? "sandbox"
    : "mock";

const impl = mode === "sandbox" ? sandbox : mock;

export const today = () => new Date().toISOString().slice(0, 10);

const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Our invoice draft -> the toolkit's create_invoice input. The toolkit sets no
// payment term, so the due date travels in the note and PayTally tracks it.
export function toPayPalInvoice(draft) {
  const note = [
    draft.replaces ? `Corrected invoice, replacing invoice ${draft.replaces.number}: ${draft.replaces.why}` : "",
    `Results billed for ${draft.period.label}, due by ${longDate(draft.due_date)}.`,
    "Each line names the row in our work log it comes from; reply with any question.",
  ].filter(Boolean).join(" ");
  return {
    currency_code: draft.currency,
    invoice_date: draft.invoice_date,
    reference: `${draft.period.label} · ${draft.client_id}`,
    note: note.slice(0, 4000),
    invoicer_business_name: draft.invoicer.name,
    primary_recipients: [{ billing_info: { business_name: draft.client_name, email_address: draft.billing_email } }],
    items: draft.lines.map((l) => ({
      name: l.item.slice(0, 200),
      description: `${l.date}: ${l.reason} Source: ${l.sources.join(", ")}.`.slice(0, 1000),
      quantity: "1",
      unit_amount: { currency_code: draft.currency, value: l.amount.toFixed(2) },
      unit_of_measure: "QUANTITY",
    })),
  };
}

export async function createInvoice(draft, approval) {
  assertApproved(draft, approval);
  return impl.createInvoice(toPayPalInvoice(draft));
}

export async function sendInvoice(invoiceId, draft, approval) {
  assertApproved(draft, approval);
  return impl.sendInvoice(invoiceId, { send_to_recipient: true, note: "Thank you for your business." });
}

// reminder: { kind: "reminder", invoice_id, subject, note }
export async function sendInvoiceReminder(reminder, approval) {
  assertApproved(reminder, approval);
  return impl.sendInvoiceReminder(reminder.invoice_id, { subject: reminder.subject, note: reminder.note });
}

// cancel: { kind: "cancel", invoice_id, note }
export async function cancelSentInvoice(cancel, approval) {
  assertApproved(cancel, approval);
  return impl.cancelSentInvoice(cancel.invoice_id, { note: cancel.note, send_to_recipient: true });
}

// refund: { kind: "refund", invoice_id, amount, currency }
export async function recordRefund(refund, approval) {
  assertApproved(refund, approval);
  return impl.recordRefund(refund.invoice_id, {
    method: "BANK_TRANSFER",
    refund_date: today(),
    amount: { currency_code: refund.currency, value: refund.amount.toFixed(2) },
  });
}

// Demo only: stands in for the client paying. PayPal records the payment and
// then sends its own "invoice paid" webhook, which is what marks it paid here.
export async function recordTestPayment(invoiceId, amount, currency) {
  return impl.recordPayment(invoiceId, {
    method: "BANK_TRANSFER",
    payment_date: today(),
    amount: { currency_code: currency, value: amount.toFixed(2) },
    note: "PayTally demo: test payment recorded in the PayPal sandbox.",
  });
}

export async function getInvoice(invoiceId) {
  return impl.getInvoice(invoiceId);
}

export async function listInvoices() {
  return impl.listInvoices();
}
