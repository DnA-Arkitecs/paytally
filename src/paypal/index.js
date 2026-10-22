// The only door to PayPal. Every call that reaches a client or moves money (an
// invoice, a reminder, a cancellation, a refund, a payment) first checks a
// human's approval of that exact action: the owner's, or for a payment, the
// client's. In the sandbox, invoicing goes through the PayPal Agent Toolkit's
// tools (sandbox.js) and money through Orders, Vault and Payments
// (payments.js); otherwise a local stand-in answers (mock.js).
//
// PayPal stays mocked until PAYPAL_MODE=sandbox and both sandbox keys are set.
import { assertApproved } from "../approvals.js";
import * as mock from "./mock.js";
import * as sandbox from "./sandbox.js";
import * as payments from "./payments.js";

export const mode =
  process.env.PAYPAL_MODE === "sandbox" && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
    ? "sandbox"
    : "mock";

const impl = mode === "sandbox" ? sandbox : mock;
const money = mode === "sandbox" ? payments : mock;
export const { TEST_CARDS } = payments;

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

// refund: { kind: "refund", invoice_id, amount, currency, capture_id, note, request_id }
// When the invoice was paid through PayPal (capture_id), PayPal returns the
// money to the client (Payments v2 refund) and the refund is then noted on the
// invoice. A payment recorded outside PayPal can only have its refund noted.
export async function refundPayment(refund, approval) {
  assertApproved(refund, approval);
  const moved = refund.capture_id
    ? await money.refundCapture(refund.capture_id, { amount: refund.amount, currency: refund.currency, note: refund.note || "Credit after your question about the invoice.", request_id: refund.request_id })
    : null;
  await impl.recordRefund(refund.invoice_id, {
    method: moved ? "PAYPAL" : "BANK_TRANSFER",
    refund_date: today(),
    amount: { currency_code: refund.currency, value: refund.amount.toFixed(2) },
  });
  return { refund_id: moved?.refund_id || null, moved_money: Boolean(moved) };
}

// The client's own one-time setup: their card saved in PayPal Vault, so a
// payment they approve later needs no checkout. Returns the vault id.
export async function saveCard(card) {
  return money.saveCard(card);
}

// The payment is then recorded on the PayPal invoice, which makes PayPal send
// its "invoice paid" webhook; that webhook is what marks the invoice paid here.
async function recordOnInvoice(invoiceId, amount, currency, paid) {
  await impl.recordPayment(invoiceId, {
    method: "PAYPAL",
    payment_date: today(),
    amount: { currency_code: currency, value: amount.toFixed(2) },
    note: `Paid through PayPal, capture ${paid.capture_id}.`,
  });
  return paid;
}

// payment: { kind: "payment", invoice_id, number, amount, currency, vault_id, request_id }
// The client's human approved this exact payment. PayPal charges the client's
// saved payment method (Orders v2, captured at once).
export async function payInvoice(payment, approval) {
  assertApproved(payment, approval);
  const paid = await money.charge({
    amount: payment.amount,
    currency: payment.currency,
    custom_id: payment.invoice_id,
    invoice_id: `PT-${payment.number}-${payment.request_id}`,
    description: `Invoice ${payment.number}`,
    vault_id: payment.vault_id,
    request_id: payment.request_id,
  });
  return recordOnInvoice(payment.invoice_id, payment.amount, payment.currency, paid);
}

// Demo only: stands in for a client paying an invoice by card themselves.
// PayPal takes a real sandbox payment from one of its published test cards.
export async function payWithTestCard(invoiceId, number, amount, currency) {
  const paid = await money.charge({
    amount,
    currency,
    custom_id: invoiceId,
    invoice_id: `PT-${number}-${Date.now()}`,
    description: `Invoice ${number}`,
    card: { ...TEST_CARDS.default, name: "PayTally demo client" },
  });
  return recordOnInvoice(invoiceId, amount, currency, paid);
}

export async function getInvoice(invoiceId) {
  return impl.getInvoice(invoiceId);
}

export async function listInvoices() {
  return impl.listInvoices();
}
