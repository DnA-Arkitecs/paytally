// PayPal's REST API (sandbox), for the calls the Agent Toolkit has no tool
// for: webhooks, and orders and refunds that use a saved payment method.
export const BASE = "https://api-m.sandbox.paypal.com";

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

// requestId makes a money call safe to retry: PayPal runs it once per id.
export async function api(method, path, body, { requestId } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  if (method === "POST") headers.Prefer = "return=representation";
  const res = await fetch(BASE + path, { method, headers, body: typeof body === "string" ? body : body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let why = text.slice(0, 300);
    try {
      const err = JSON.parse(text);
      why = [err.name, err.details?.[0]?.issue, err.details?.[0]?.description || err.message].filter(Boolean).join(": ");
    } catch {}
    throw new Error(`PayPal ${method} ${path.split("?")[0]} failed (${res.status}): ${why}`);
  }
  return text ? JSON.parse(text) : {};
}
