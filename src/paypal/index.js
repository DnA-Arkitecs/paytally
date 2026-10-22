// The only door to PayPal. Every call that sends something to a client checks
// the owner's approval first. The functions are named after the PayPal Agent
// Toolkit invoicing tools (create_invoice, send_invoice, send_invoice_reminder,
// list_invoices) so the sandbox adapter can drop in behind them unchanged.
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

// Our invoice draft -> a PayPal Invoicing v2 invoice body.
export function toPayPalInvoice(draft) {
  return {
    detail: {
      currency_code: draft.currency,
      invoice_date: new Date().toISOString().slice(0, 10),
      reference: `${draft.period.label} · ${draft.client_id}`,
      note: `Results billed for ${draft.period.label}. Each line names the row in our work log it comes from; reply with any question.`,
      payment_term: { term_type: "NET_15" },
    },
    invoicer: {
      business_name: draft.invoicer.name,
      email_address: draft.invoicer.billing_email,
    },
    primary_recipients: [
      {
        billing_info: {
          business_name: draft.client_name,
          email_address: draft.billing_email,
        },
      },
    ],
    items: draft.lines.map((l) => ({
      name: l.item,
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
  return impl.sendInvoice(invoiceId, {
    send_to_recipient: true,
    subject: `${draft.invoicer.name}: ${draft.period.label} invoice`,
    note: "Thank you for your business.",
  });
}

export async function sendInvoiceReminder(invoiceId, draft, approval) {
  assertApproved(draft, approval);
  return impl.sendInvoiceReminder(invoiceId, {
    subject: `Reminder: ${draft.invoicer.name} ${draft.period.label} invoice`,
    note: "A friendly reminder that this invoice is due.",
  });
}

export async function listInvoices() {
  return impl.listInvoices();
}
