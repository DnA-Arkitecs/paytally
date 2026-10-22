// PayPal webhooks (sandbox): registering PayTally's URL and checking that an
// incoming event really came from PayPal. The Agent Toolkit has no webhook
// tools, so these two calls use PayPal's REST API directly.
const BASE = "https://api-m.sandbox.paypal.com";
export const EVENT_TYPES = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED", "INVOICING.INVOICE.REFUNDED"];

let token = null;

async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token request failed (${res.status}).`);
  const body = await res.json();
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

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
