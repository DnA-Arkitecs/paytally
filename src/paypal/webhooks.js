// PayPal webhooks (sandbox): registering PayTally's URL and checking that an
// incoming event really came from PayPal. The Agent Toolkit has no webhook
// tools, so these calls use PayPal's REST API directly (rest.js).
import { api } from "./rest.js";

export const EVENT_TYPES = [
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.REFUNDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
];

// Finds the sandbox webhook for this URL, or creates it. Returns its id, which
// signature checks need.
export async function ensureWebhook(url) {
  const { webhooks = [] } = await api("GET", "/v1/notifications/webhooks");
  const existing = webhooks.find((w) => w.url === url);
  if (existing) {
    const have = new Set(existing.event_types.map((e) => e.name));
    if (EVENT_TYPES.every((t) => have.has(t))) return { id: existing.id, created: false };
    await api("PATCH", `/v1/notifications/webhooks/${existing.id}`, [
      { op: "replace", path: "/event_types", value: EVENT_TYPES.map((name) => ({ name })) },
    ]);
    return { id: existing.id, created: false };
  }
  const made = await api("POST", "/v1/notifications/webhooks", { url, event_types: EVENT_TYPES.map((name) => ({ name })) });
  return { id: made.id, created: true };
}

// Asks PayPal whether this event is genuine. The raw body is passed through
// byte for byte: re-serialising the JSON can break the check.
export async function verifySignature(headers, rawBody, webhookId) {
  const field = (name) => JSON.stringify(String(headers[name] || ""));
  const body = `{"auth_algo":${field("paypal-auth-algo")},"cert_url":${field("paypal-cert-url")},"transmission_id":${field("paypal-transmission-id")},"transmission_sig":${field("paypal-transmission-sig")},"transmission_time":${field("paypal-transmission-time")},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;
  const out = await api("POST", "/v1/notifications/verify-webhook-signature", body);
  return out.verification_status === "SUCCESS";
}
