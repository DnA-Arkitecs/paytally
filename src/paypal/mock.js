// A stand-in for PayPal with the same calls and response shapes we rely on.
// It keeps invoices in var/mock-paypal.json and sends nothing anywhere.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VAR_DIR } from "../store.js";

const FILE = path.join(VAR_DIR, "mock-paypal.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { invoices: {} };
  }
}

function save(db) {
  fs.mkdirSync(VAR_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

const newId = () =>
  `INV2-MOCK-${crypto.randomBytes(8).toString("hex").toUpperCase().match(/.{4}/g).join("-")}`;

const total = (invoice) =>
  invoice.items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0).toFixed(2);

export async function createInvoice(body) {
  const db = load();
  const id = newId();
  db.invoices[id] = { id, status: "DRAFT", ...body, amount: { currency_code: body.detail.currency_code, value: total(body) }, history: [{ at: new Date().toISOString(), event: "created" }] };
  save(db);
  return { id, status: "DRAFT", href: `/mock-paypal/invoice/${id}` };
}

export async function sendInvoice(id, options) {
  const db = load();
  const invoice = db.invoices[id];
  if (!invoice) throw new Error(`Mock PayPal: no invoice ${id}`);
  invoice.status = "SENT";
  invoice.history.push({ at: new Date().toISOString(), event: "sent", subject: options.subject });
  save(db);
  return { id, status: "SENT", href: `/mock-paypal/invoice/${id}` };
}

export async function sendInvoiceReminder(id, options) {
  const db = load();
  const invoice = db.invoices[id];
  if (!invoice) throw new Error(`Mock PayPal: no invoice ${id}`);
  invoice.history.push({ at: new Date().toISOString(), event: "reminder", subject: options.subject });
  save(db);
  return { id, status: invoice.status };
}

export async function listInvoices() {
  return { items: Object.values(load().invoices) };
}

export async function getInvoice(id) {
  return load().invoices[id] || null;
}

export function reset() {
  save({ invoices: {} });
}
