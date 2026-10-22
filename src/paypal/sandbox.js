// PayPal sandbox adapter: wired in week 2 (Oct 30 – Nov 4), once sandbox keys exist.
// Each function maps to one PayPal Agent Toolkit invoicing tool and must return
// the same shape as mock.js:
//   createInvoice(body)              -> create_invoice         -> { id, status, href }
//   sendInvoice(id, options)         -> send_invoice           -> { id, status, href }
//   sendInvoiceReminder(id, options) -> send_invoice_reminder  -> { id, status }
//   listInvoices()                   -> list_invoices          -> { items }
// Note for wiring: in the sandbox, the invoicer email must be the sandbox
// business account's email, not the demo agency's.

const notYet = (tool) => {
  throw new Error(`PayPal sandbox ${tool} is not wired yet. Set PAYPAL_MODE=mock until week 2.`);
};

export async function createInvoice() { notYet("create_invoice"); }
export async function sendInvoice() { notYet("send_invoice"); }
export async function sendInvoiceReminder() { notYet("send_invoice_reminder"); }
export async function listInvoices() { notYet("list_invoices"); }
