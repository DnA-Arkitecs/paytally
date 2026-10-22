// PayPal sandbox through the PayPal Agent Toolkit (@paypal/agent-toolkit). Each
// function calls one of the toolkit's invoicing tools and returns the same
// shape as mock.js:
//   createInvoice(params)             create_invoice              -> { id, status }
//   sendInvoice(id, options)          send_invoice                -> { id, status, href }
//   sendInvoiceReminder(id, options)  send_invoice_reminder       -> { id }
//   cancelSentInvoice(id, options)    cancel_sent_invoice         -> { id, status }
//   recordPayment(id, payment)        record_payment_for_invoice  -> { id, payment_id }
//   recordRefund(id, refund)          record_refund_for_invoice   -> { id, refund_id }
//   getInvoice(id)                    get_invoice                 -> summary (see summarize)
//   listInvoices()                    list_invoices               -> { items: [summary] }
// The toolkit keeps its OAuth token for the life of the instance, and sandbox
// tokens last about nine hours, so the toolkit is rebuilt every eight.
import toolkitPkg from "@paypal/agent-toolkit/ai-sdk";

const { PayPalAgentToolkit } = toolkitPkg;
const TOKEN_LIFE_MS = 8 * 60 * 60 * 1000;

let toolkit = null;
let builtAt = 0;

function tools() {
  if (!toolkit || Date.now() - builtAt > TOKEN_LIFE_MS) {
    toolkit = new PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      configuration: {
        actions: {
          invoices: { create: true, list: true, get: true, send: true, sendReminder: true, cancel: true, recordPayment: true, recordRefund: true },
        },
        context: { sandbox: true },
      },
    });
    builtAt = Date.now();
  }
  return toolkit.getTools();
}

// The toolkit returns JSON text and reports PayPal errors as { ok: false, status, message }.
async function run(tool, args) {
  const text = await tools()[tool].execute(args, {});
  const out = text ? JSON.parse(text) : "";
  if (out && typeof out === "object" && (out.ok === false || out.error)) {
    throw new Error(`PayPal ${tool}: ${out.message || out.error?.message || "failed"}${out.status ? ` (${out.status})` : ""}`);
  }
  return out;
}

const value = (m) => (m ? Number(m.value) : 0);

// What PayTally reads from a PayPal invoice, in one flat shape.
export function summarize(inv) {
  return {
    id: inv.id,
    status: inv.status,
    number: inv.detail?.invoice_number || "",
    invoice_date: inv.detail?.invoice_date || "",
    reference: inv.detail?.reference || "",
    total: value(inv.amount),
    paid: value(inv.payments?.paid_amount),
    refunded: value(inv.refunds?.refund_amount),
    payer_url: inv.detail?.metadata?.recipient_view_url || "",
  };
}

export async function createInvoice(params) {
  const out = await run("create_invoice", params);
  const id = out.id || String(out.href || "").split("/").pop();
  if (!id) throw new Error("PayPal create_invoice returned no invoice id.");
  return { id, status: "DRAFT" };
}

export async function sendInvoice(id, options) {
  const out = await run("send_invoice", { invoice_id: id, ...options });
  return { id, status: "SENT", href: out?.href || "" };
}

export async function sendInvoiceReminder(id, options) {
  await run("send_invoice_reminder", { invoice_id: id, ...options });
  return { id };
}

export async function cancelSentInvoice(id, options) {
  await run("cancel_sent_invoice", { invoice_id: id, ...options });
  return { id, status: "CANCELLED" };
}

export async function recordPayment(id, payment) {
  const out = await run("record_payment_for_invoice", { invoice_id: id, ...payment });
  return { id, payment_id: out?.payment_id || "" };
}

export async function recordRefund(id, refund) {
  const out = await run("record_refund_for_invoice", { invoice_id: id, ...refund });
  return { id, refund_id: out?.refund_id || "" };
}

export async function getInvoice(id) {
  return summarize(await run("get_invoice", { invoice_id: id }));
}

export async function listInvoices({ page = 1, page_size = 100 } = {}) {
  const out = await run("list_invoices", { page, page_size, total_required: true });
  return { items: (out.items || []).map(summarize) };
}
