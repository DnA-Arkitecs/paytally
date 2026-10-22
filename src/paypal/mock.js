// A stand-in for PayPal with the same calls and response shapes as sandbox.js
// and payments.js. It keeps invoices in var/mock-paypal.json and sends nothing anywhere. Like
// PayPal, it reports payments and refunds a moment later as webhook events,
// delivered in-process to whatever onEvent() registered.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VAR_DIR } from "../store.js";

const FILE = path.join(VAR_DIR, "mock-paypal.json");
export const EVENT_DELAY_MS = 1500;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { invoices: {}, next_number: 1 };
  }
}

function save(db) {
  fs.mkdirSync(VAR_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

const newId = () =>
  `INV2-MOCK-${crypto.randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g).join("-")}`;

const total = (params) =>
  params.items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);

const listeners = [];
export function onEvent(fn) {
  listeners.push(fn);
}

function emit(type, invoice) {
  const event = {
    id: `WH-MOCK-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    event_type: type,
    create_time: new Date().toISOString(),
    resource_type: "invoices",
    resource: {
      invoice: {
        id: invoice.id,
        status: invoice.status,
        payments: { paid_amount: { currency_code: "USD", value: invoice.paid.toFixed(2) } },
        refunds: { refund_amount: { currency_code: "USD", value: invoice.refunded.toFixed(2) } },
      },
    },
  };
  setTimeout(() => listeners.forEach((fn) => fn(event)), EVENT_DELAY_MS).unref?.();
}

function find(db, id) {
  const invoice = db.invoices[id];
  if (!invoice) throw new Error(`Mock PayPal: no invoice ${id}`);
  return invoice;
}

const log = (invoice, event, extra = {}) => invoice.history.push({ at: new Date().toISOString(), event, ...extra });

export function summarize(inv) {
  return {
    id: inv.id,
    status: inv.status,
    number: inv.number,
    invoice_date: inv.params.invoice_date,
    reference: inv.params.reference,
    total: inv.total,
    paid: inv.paid,
    refunded: inv.refunded,
    payer_url: `/mock-paypal/invoice/${inv.id}`,
  };
}

export async function createInvoice(params) {
  const db = load();
  const id = newId();
  const number = `M${String(db.next_number++).padStart(4, "0")}`;
  db.invoices[id] = { id, number, status: "DRAFT", params, total: total(params), paid: 0, refunded: 0, history: [] };
  log(db.invoices[id], "created");
  save(db);
  return { id, status: "DRAFT" };
}

export async function sendInvoice(id, options) {
  const db = load();
  const invoice = find(db, id);
  invoice.status = "SENT";
  log(invoice, "sent", { note: options.note });
  save(db);
  return { id, status: "SENT", href: `/mock-paypal/invoice/${id}` };
}

export async function sendInvoiceReminder(id, options) {
  const db = load();
  log(find(db, id), "reminder", { subject: options.subject, note: options.note });
  save(db);
  return { id };
}

export async function cancelSentInvoice(id, options) {
  const db = load();
  const invoice = find(db, id);
  if (!["SENT", "UNPAID"].includes(invoice.status)) throw new Error(`Mock PayPal: can't cancel a ${invoice.status} invoice.`);
  invoice.status = "CANCELLED";
  log(invoice, "cancelled", { note: options.note });
  save(db);
  emit("INVOICING.INVOICE.CANCELLED", invoice);
  return { id, status: "CANCELLED" };
}

export async function recordPayment(id, payment) {
  const db = load();
  const invoice = find(db, id);
  invoice.paid = Number(payment.amount.value);
  invoice.status = invoice.paid >= invoice.total ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
  log(invoice, "payment", { amount: payment.amount.value });
  save(db);
  emit("INVOICING.INVOICE.PAID", invoice);
  return { id, payment_id: `EXTR-MOCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}` };
}

export async function recordRefund(id, refund) {
  const db = load();
  const invoice = find(db, id);
  invoice.refunded += Number(refund.amount.value);
  invoice.status = invoice.refunded >= invoice.paid ? "REFUNDED" : "PARTIALLY_REFUNDED";
  log(invoice, "refund", { amount: refund.amount.value });
  save(db);
  emit("INVOICING.INVOICE.REFUNDED", invoice);
  return { id, refund_id: `EXTR-MOCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}` };
}

// Orders, Vault and refunds (payments.js in the sandbox).
const mockId = (prefix) => `${prefix}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

function emitPayment(type, resource) {
  const event = { id: mockId("WH-MOCK-"), event_type: type, create_time: new Date().toISOString(), resource_type: type.includes("REFUND") ? "refund" : "capture", resource };
  setTimeout(() => listeners.forEach((fn) => fn(event)), EVENT_DELAY_MS).unref?.();
}

export async function saveCard({ number }) {
  return { vault_id: mockId("VAULT-MOCK-"), brand: "VISA", last_digits: number.slice(-4) };
}

export async function charge({ amount, currency, custom_id, invoice_id }) {
  const capture_id = mockId("CAP-MOCK-");
  emitPayment("PAYMENT.CAPTURE.COMPLETED", { id: capture_id, status: "COMPLETED", custom_id, invoice_id, amount: { currency_code: currency, value: Number(amount).toFixed(2) } });
  return { order_id: mockId("ORDER-MOCK-"), capture_id, status: "COMPLETED" };
}

export async function refundCapture(captureId, { amount, currency }) {
  const refund_id = mockId("REF-MOCK-");
  emitPayment("PAYMENT.CAPTURE.REFUNDED", { id: refund_id, status: "COMPLETED", amount: { currency_code: currency, value: Number(amount).toFixed(2) }, links: [{ rel: "up", href: `/v2/payments/captures/${captureId}` }] });
  return { refund_id, status: "COMPLETED" };
}

export async function getInvoice(id) {
  const inv = load().invoices[id];
  return inv ? summarize(inv) : null;
}

// The raw stored invoice, for the mock invoice page.
export async function rawInvoice(id) {
  return load().invoices[id] || null;
}

export async function listInvoices() {
  return { items: Object.values(load().invoices).map(summarize) };
}

export function reset() {
  save({ invoices: {}, next_number: 1 });
}
