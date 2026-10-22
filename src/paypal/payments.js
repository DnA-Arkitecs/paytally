// Real money in the PayPal sandbox: saving a client's payment method in PayPal
// Vault, charging it, and refunding a charge. Uses Orders v2, Vault v3 and
// Payments v2 directly (rest.js): the Agent Toolkit's create_order can't take a
// saved payment method. Same function shapes as the mock in mock.js.
//   saveCard(card)                       -> { vault_id, brand, last_digits }
//   charge({ amount, ..., vault_id | card }) -> { order_id, capture_id, status }
//   refundCapture(captureId, refund)     -> { refund_id, status }
import crypto from "node:crypto";
import { api } from "./rest.js";

// PayPal's published sandbox test cards (developer.paypal.com/tools/sandbox/card-testing).
// They only work in the sandbox; no real card is ever used.
export const TEST_CARDS = {
  "mesa-ridge": { number: "4012000033330026", expiry: "2030-12", brand: "Visa" },
  // 4005519200000004 is refused in the sandbox (PAYER_CANNOT_PAY) as of Oct 2026.
  default: { number: "4012000033330026", expiry: "2030-12", brand: "Visa" },
};

const value = (n) => Number(n).toFixed(2);

// Vault without a purchase: a setup token for the card, then a payment token.
export async function saveCard({ name, number, expiry }) {
  const setup = await api("POST", "/v3/vault/setup-tokens", { payment_source: { card: { number, expiry, name } } }, { requestId: crypto.randomUUID() });
  const token = await api("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setup.id, type: "SETUP_TOKEN" } } }, { requestId: crypto.randomUUID() });
  return { vault_id: token.id, brand: token.payment_source?.card?.brand || "CARD", last_digits: token.payment_source?.card?.last_digits || number.slice(-4) };
}

// One order, captured at once. A saved card is charged as a merchant-initiated
// payment (the client's human approved this exact amount in PayTally first).
// custom_id carries the PayPal invoice id so webhooks find their invoice.
export async function charge({ amount, currency, custom_id, invoice_id, description, vault_id, card, request_id }) {
  const payment_source = vault_id
    ? { card: { vault_id, stored_credential: { payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" } } }
    : { card: { number: card.number, expiry: card.expiry, name: card.name } };
  const order = await api(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [{ custom_id, invoice_id, description: description.slice(0, 127), amount: { currency_code: currency, value: value(amount) } }],
      payment_source,
    },
    { requestId: request_id || crypto.randomUUID() },
  );
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
    throw new Error(`PayPal did not complete the payment (order ${order.status || "?"}, capture ${capture?.status || "none"}).`);
  }
  return { order_id: order.id, capture_id: capture.id, status: capture.status };
}

export async function refundCapture(captureId, { amount, currency, note, request_id }) {
  const out = await api(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: { currency_code: currency, value: value(amount) }, note_to_payer: note.slice(0, 255) },
    { requestId: request_id || crypto.randomUUID() },
  );
  return { refund_id: out.id, status: out.status };
}
