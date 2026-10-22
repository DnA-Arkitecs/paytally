import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PAYTALLY_VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paytally-fallback-"));

const { createApp } = await import("../src/app.js");

async function withApp(options, fn) {
  const server = createApp(options).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body = {}) =>
    fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const state = () => fetch(base + "/api/state").then((r) => r.json());
  try {
    await fn({ post, state });
  } finally {
    server.close();
  }
}

test("a failed live run falls back to the recorded run, and says so", async () => {
  const noCredit = async () => {
    throw new Error("Your credit balance is too low");
  };
  await withApp({ extract: noCredit, hasClaudeKey: () => true }, async ({ post, state }) => {
    const out = await post("/api/build", { mode: "live" });
    assert.equal(out.status, 200);
    assert.equal(out.body.kind, "recorded");
    assert.equal(out.body.fallback, true);
    assert.match(out.body.notice, /credit balance is too low/);
    const s = await state();
    assert.equal(s.ledger.extractor.kind, "recorded");
    assert.ok(s.ledger.lines.length > 30);
    assert.match(s.activity.map((a) => a.text).join("\n"), /live Claude run failed/);
  });
});

test("with no key, a live request shows the recorded run", async () => {
  await withApp({ hasClaudeKey: () => false }, async ({ post, state }) => {
    const out = await post("/api/build", { mode: "live" });
    assert.equal(out.body.kind, "recorded");
    assert.match(out.body.notice, /No Anthropic key/);
    assert.equal((await state()).modes.live, false);
  });
});
