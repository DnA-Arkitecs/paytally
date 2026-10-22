import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgency, loadSources } from "../src/sources.js";
import { extractWithClaude, extractFromAnswerKey, MODEL } from "../src/extract.js";

// A stand-in for the Anthropic client that records the request and returns a canned message.
function fakeClient(message) {
  const calls = [];
  return {
    calls,
    beta: { messages: { stream: (params) => { calls.push(params); return { finalMessage: async () => message }; } } },
  };
}

const agency = loadAgency();
const sources = loadSources();

test("the Claude request uses the current model, a strict schema and server-side fallback", async () => {
  const answer = extractFromAnswerKey();
  const client = fakeClient({
    model: MODEL,
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(answer) }],
    usage: { input_tokens: 9000, output_tokens: 7000, cache_read_input_tokens: 0 },
  });
  const out = await extractWithClaude({ agency, sources, client });
  assert.equal(out.extraction.items.length, answer.items.length);

  const req = client.calls[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.output_config.format.type, "json_schema");
  assert.deepEqual(req.output_config.format.schema.properties.items.items.properties.client_id.enum, ["harbor-pine", "cobalt-dental", "mesa-ridge"]);
  const text = req.messages[0].content[0].text;
  assert.match(text, /\[calendar:31\] Harbor & Pine - Walter Ng/);
  assert.match(text, /\[email:E7\]/);
  assert.match(text, /§2 A no-show is free if Mesa Ridge reports it within 48 hours/);
});

test("a refusal or a cut-off answer is an error, never a ledger", async () => {
  const refused = fakeClient({ model: MODEL, stop_reason: "refusal", stop_details: { category: null }, content: [], usage: {} });
  await assert.rejects(extractWithClaude({ agency, sources, client: refused }), /declined/);
  const cut = fakeClient({ model: MODEL, stop_reason: "max_tokens", content: [{ type: "text", text: "{" }], usage: {} });
  await assert.rejects(extractWithClaude({ agency, sources, client: cut }), /ran out of output room/);
});
