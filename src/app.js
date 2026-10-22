import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as store from "./store.js";
import * as paypal from "./paypal/index.js";
import * as mockPaypal from "./paypal/mock.js";
import { ensureWebhook, verifySignature } from "./paypal/webhooks.js";
import { DATA_DIR, loadAgency, loadSources } from "./sources.js";
import { MODEL, extractFromAnswerKey, extractWithClaude, loadRecordedRun } from "./extract.js";
import { scoreExtraction } from "./score.js";
import { buildLedger, invoiceDraft } from "./ledger.js";
import { issueApproval, ApprovalError } from "./approvals.js";
import * as collect from "./collect.js";
import { loadClientReplies, loadRecordedDrafts, draftReplyWithClaude, draftProblem, scoreDraft } from "./replies.js";
import * as settle from "./settlement.js";
import { mountMcp, TOOLS } from "./mcp.js";
import { runPhase, replayPhase } from "./client-agent.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function loadRecordedSettlement(dataDir = DATA_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "recorded-settlement.json"), "utf8"));
  } catch {
    return null;
  }
}

export function createApp({
  extract = extractWithClaude,
  draftReply = draftReplyWithClaude,
  runClientPhase = runPhase,
  replayClientPhase = replayPhase,
  hasClaudeKey = () => Boolean(process.env.ANTHROPIC_API_KEY),
  registerWebhook = true,
} = {}) {
  const app = express();
  const agency = loadAgency();
  const owner = agency.agency.owner;
  const clientReplies = loadClientReplies();
  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "history.json"), "utf8")).invoices;
  const clientAgents = settle.loadClientAgents().map((a) => ({ ...a, client_name: agency.clients.find((c) => c.id === a.client_id).name }));
  const agentFor = (clientId) => clientAgents.find((a) => a.client_id === clientId);

  // ---------- PayPal webhooks ----------
  // In the sandbox, PayPal posts invoice events here and each one is checked
  // with PayPal before it changes anything. The mock delivers its events in-process.
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  const webhook = { url: publicUrl ? `${publicUrl}/api/paypal/webhook` : "", id: process.env.PAYPAL_WEBHOOK_ID || "" };
  if (paypal.mode === "sandbox" && webhook.url && !webhook.id && registerWebhook) {
    ensureWebhook(webhook.url)
      .then(({ id, created }) => {
        webhook.id = id;
        console.log(`PayPal sandbox webhook ${created ? "registered" : "found"} for ${webhook.url}`);
      })
      .catch((err) => console.error(`PayPal webhook registration failed: ${err.message}`));
  }

  function receive(event, via) {
    const state = store.load();
    const line = collect.applyEvent(state, event, via);
    if (!line) return;
    store.log(state, line, "paypal");
    // A payment a client's agent asked for is done when PayPal says the invoice is paid.
    for (const p of Object.values(state.payment_requests)) {
      const record = collect.findRecord(state, p.paypal_id);
      if (p.status === "sent_to_paypal" && record && collect.PAID.has(record.status)) {
        p.status = "paid";
        settlementStep(p.client_id, { who: "paypal", text: `PayPal's webhook: invoice ${p.invoice_number} paid, ${money(p.amount)}. Settled.` });
      }
    }
    if (event.event_type.startsWith("PAYMENT.CAPTURE")) {
      const record = collect.recordForEvent(state, event);
      settlementStep(record.client_id, { who: "paypal", text: line });
    }
    store.save(state);
  }

  // The agent settlement transcript: one client's agent, PayTally's answers and
  // every human checkpoint, in order. Steps only land while that client's
  // settlement is the one on screen. A tool call is logged when it starts and
  // filled in, in place, when its result is back.
  function settlementStep(clientId, step) {
    store.updateSettlement((s) => {
      if (s.client_id !== clientId) return;
      const started = step.call_id ? s.steps.findIndex((x) => x.call_id === step.call_id) : -1;
      if (started >= 0) s.steps[started] = { ...s.steps[started], ...step, pending: false };
      else s.steps.push({ at: new Date().toISOString(), ...step });
    });
  }
  if (paypal.mode === "mock") mockPaypal.onEvent((event) => receive(event, "PayPal webhook (mock)"));

  app.post("/api/paypal/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    if (paypal.mode !== "sandbox") return res.status(404).json({ error: "Webhooks are received in sandbox mode only." });
    if (!webhook.id) return res.status(503).json({ error: "The webhook is not registered yet." });
    const raw = req.body.toString("utf8");
    try {
      if (!(await verifySignature(req.headers, raw, webhook.id))) return res.status(400).json({ error: "PayPal did not confirm this event." });
    } catch (err) {
      console.error(`Webhook check failed: ${err.message}`);
      return res.status(502).json({ error: "Could not check the event with PayPal." });
    }
    receive(JSON.parse(raw), "PayPal webhook");
    res.json({ ok: true });
  });

  app.use(express.json());
  app.use(express.static(path.join(ROOT, "public")));
  app.use("/vendor/ag-grid", express.static(path.join(ROOT, "node_modules", "ag-grid-community", "dist")));

  // ---------- Ledger ----------
  function ledgerFor(state, sources, resolutions = state.resolutions) {
    return buildLedger({ agency, extraction: state.extraction.data, sources, resolutions, extractor: state.extraction.meta });
  }

  function rebuild(state, sources = loadSources()) {
    state.ledger = ledgerFor(state, sources);
  }

  // What crediting a reply's disputed line would do. The terms engine re-prices
  // the client without it, so tiers and counts stay right.
  function creditPreview(state, thread, sources) {
    const record = state.invoices[thread.client_id];
    if (!thread.draft || !record || thread.status !== "open" || !state.extraction) return null;
    const line = record.items.find((l) => l.key === thread.draft.line_key);
    if (!line) return null;
    const ledger = ledgerFor(state, sources, { ...state.resolutions, [line.key]: { decision: "credit", ref: `reply ${thread.id}`, at: "" } });
    const after = invoiceDraft(ledger, agency, thread.client_id);
    const amount = Math.round((record.total - after.total) * 100) / 100;
    const how = collect.PAID.has(record.status) ? "refund" : collect.OPEN.has(record.status) && !record.paid ? "corrected_invoice" : null;
    return { line_key: line.key, item: line.item, amount, new_total: after.total, how, moves_money: how === "refund" && Boolean(record.payments?.length) };
  }

  app.get("/api/state", (req, res) => {
    const state = store.load();
    const sources = loadSources();
    const today = paypal.today();
    res.json({
      agency: { name: agency.agency.name, owner, period: agency.period, payment_due_days: agency.payment_due_days },
      clients: agency.clients.map(({ id, name, summary, terms_text, billing_email }) => ({ id, name, summary, terms_text, billing_email })),
      modes: {
        live: hasClaudeKey(),
        recorded: Boolean(loadRecordedRun(sources.hash)),
        model: MODEL,
        paypal: paypal.mode,
        webhook: paypal.mode === "mock" ? "mock" : webhook.id ? "ready" : webhook.url ? "registering" : "none",
      },
      today,
      ledger: state.ledger,
      invoices: state.invoices,
      collections: collect.allRecords(state).map((r) => {
        const days = collect.daysOverdue(r, today);
        return { ...r, items: undefined, days_overdue: days, reminder: days > 0 ? collect.reminderFor(r, agency, today) : null };
      }),
      replies: clientReplies.map(({ id, client_id, arrives, from }) => ({ id, client_id, arrives, from })),
      threads: Object.values(state.threads).map((t) => ({ ...t, credit: creditPreview(state, t, sources) })),
      client_agents: clientAgents.map(({ client_id, client_name, name, human, human_role, cap, token, instructions, records_label, records }) => ({
        client_id, client_name, name, human, human_role, cap, token, instructions, records_label, records,
        saved_method: state.saved_methods[client_id] || null,
      })),
      mcp: { path: "/mcp", tools: Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description })), log: state.mcp_log.slice(0, 40) },
      payment_requests: Object.values(state.payment_requests),
      settlement: (() => {
        const s = store.loadSettlement();
        const recording = loadRecordedSettlement();
        return { ...s, messages: undefined, recorded: Boolean(recording), recorded_model: recording?.model || null, assumes: recording?.assumes || null };
      })(),
      activity: state.activity,
      sources: Object.fromEntries(Object.entries(sources.byRef).map(([ref, r]) => [ref, { label: r.label, raw: r.raw, kind: r.kind, fields: r.fields }])),
      raw: {
        calendar: [sources.calendar.header, ...sources.calendar.rows.map((r) => r.ref)],
        crm: [sources.crm.header, ...sources.crm.rows.map((r) => r.ref)],
        emails: sources.emails.map((e) => e.ref),
      },
    });
  });

  // Where the ledger's reading of the log comes from:
  //   "recorded" (default) — a real Claude run saved with the repo, so the demo
  //     always works, even with no live API credit; the answer key if none exists.
  //   "live" — a fresh Claude call. Any failure falls back to the recorded run.
  // A live result is reused for 10 minutes, and only one live call runs at a time.
  const LIVE_REUSE_MS = 10 * 60 * 1000;
  let liveInFlight = null;

  function offlineExtraction(sources) {
    const run = loadRecordedRun(sources.hash);
    if (run) {
      return {
        data: run.extraction,
        meta: { kind: "recorded", model: run.model, at: run.recorded_at, seconds: run.seconds, score: run.score, source_hash: sources.hash },
      };
    }
    return { data: extractFromAnswerKey(), meta: { kind: "answer_key", at: new Date().toISOString(), source_hash: sources.hash } };
  }

  async function liveExtraction(last, sources) {
    if (last && last.meta.source_hash === sources.hash && Date.now() - Date.parse(last.meta.at) < LIVE_REUSE_MS) {
      return { ...last, reused: true };
    }
    liveInFlight ||= (async () => {
      const started = Date.now();
      const out = await extract({ agency, sources });
      return {
        data: out.extraction,
        meta: {
          kind: "live",
          model: out.model,
          usage: out.usage,
          seconds: Math.round((Date.now() - started) / 1000),
          at: new Date().toISOString(),
          score: scoreExtraction(out.extraction, extractFromAnswerKey()),
          source_hash: sources.hash,
        },
      };
    })().finally(() => {
      liveInFlight = null;
    });
    return liveInFlight;
  }

  // create_invoice + send_invoice, each checked against the approval, then
  // get_invoice for the invoice number and the client's payment link.
  async function sendApproved(draft, approval) {
    const created = await paypal.createInvoice(draft, approval);
    await paypal.sendInvoice(created.id, draft, approval);
    return paypal.getInvoice(created.id);
  }

  // Last month's invoice, sent on its date and still unpaid, so collections has
  // something overdue to chase. Put in PayPal once per demo run.
  async function seedHistory(state) {
    if (state.history.some((r) => r.kind === "history")) return;
    for (const h of history) {
      const client = agency.clients.find((c) => c.id === h.client_id);
      const draft = {
        client_id: client.id,
        client_name: client.name,
        billing_email: client.billing_email,
        contact: client.contact,
        invoicer: agency.agency,
        period: h.period,
        currency: agency.currency,
        lines: h.lines,
        total: h.lines.reduce((s, l) => s + l.amount, 0),
        invoice_date: h.invoice_date,
        due_date: addDays(h.invoice_date, agency.payment_due_days),
      };
      try {
        const approval = issueApproval(draft, { approvedBy: `${owner} (on ${h.invoice_date})` });
        const invoice = await sendApproved(draft, approval);
        state.history.push(collect.newRecord({ draft, invoice, approval, mode: paypal.mode, kind: "history" }));
        store.log(state, `Demo history: ${client.name}'s ${h.period.label} invoice (${money(draft.total)}, sent ${h.invoice_date}, unpaid) is in PayPal as invoice ${invoice.number}.`, "paypal");
      } catch (err) {
        store.log(state, `Could not put last month's invoice in PayPal: ${err.message}`, "error");
      }
    }
  }

  // The client's own one-time setup, done for the demo: each client with an AI
  // agent has saved a card in PayPal Vault (one of PayPal's sandbox test cards),
  // so a payment its human approves later needs no checkout. Put in once per demo run.
  async function seedSavedMethods(state) {
    for (const agent of clientAgents) {
      if (state.saved_methods[agent.client_id]) continue;
      const card = paypal.TEST_CARDS[agent.client_id] || paypal.TEST_CARDS.default;
      try {
        const saved = await paypal.saveCard({ ...card, name: agent.human });
        state.saved_methods[agent.client_id] = { ...saved, holder: agent.human, saved_at: new Date().toISOString(), mode: paypal.mode };
        store.log(state, `Demo setup: ${agent.human} saved ${agent.client_name}'s ${saved.brand} ending ${saved.last_digits} in PayPal Vault (${paypal.mode}, test card), so a payment approved in PayTally needs no checkout.`, "paypal");
      } catch (err) {
        store.log(state, `Could not save ${agent.client_name}'s card in PayPal Vault: ${err.message}`, "error");
      }
    }
  }

  app.post("/api/build", async (req, res) => {
    const sources = loadSources();
    let extraction = null;
    let notice = "";
    if (req.body?.mode === "live") {
      if (!hasClaudeKey()) {
        notice = "No Anthropic key on this server, so this is the recorded run.";
      } else {
        try {
          extraction = await liveExtraction(store.load().live, sources);
        } catch (err) {
          notice = `The live Claude run failed (${err.message}), so this is the recorded run.`;
        }
      }
    }
    // Load state after the (slow) live call so decisions made meanwhile are kept.
    const state = store.load();
    const score = (m) => `${m.score.matching} of ${m.score.of} items match the hand-checked answer key`;
    if (extraction) {
      if (!extraction.reused) {
        state.live = { data: extraction.data, meta: extraction.meta };
        store.log(state, `Claude (${extraction.meta.model}) read ${sources.refs.length} rows and emails live in ${extraction.meta.seconds}s; ${score(extraction.meta)}.`, "agent");
      }
    } else {
      extraction = offlineExtraction(sources);
      if (notice) store.log(state, notice, "error");
      store.log(
        state,
        extraction.meta.kind === "recorded"
          ? `Loaded the recorded Claude run (${extraction.meta.model}, ${extraction.meta.at.slice(0, 10)}); ${score(extraction.meta)}.`
          : "No recorded run for this work log: built the ledger from the hand-checked answer key.",
        "agent",
      );
    }
    state.extraction = { data: extraction.data, meta: extraction.meta };
    rebuild(state, sources);
    const flags = state.ledger.lines.filter((l) => l.status === "flagged").length;
    store.log(state, `Ledger built: ${state.ledger.lines.length} lines, ${flags} need your decision.`);
    await seedHistory(state);
    await seedSavedMethods(state);
    store.save(state);
    res.json({ ok: true, kind: extraction.meta.kind, fallback: Boolean(notice), notice });
  });

  // The owner's decision on a flagged line. Prices are recomputed by the terms engine.
  app.post("/api/lines/resolve", (req, res) => {
    const { key, decision, note = "" } = req.body || {};
    const state = store.load();
    if (!state.ledger) return res.status(409).json({ error: "Build the ledger first." });
    const line = state.ledger.lines.find((l) => l.key === key);
    if (!line) return res.status(404).json({ error: "No such line." });
    if (state.invoices[line.client_id]) return res.status(409).json({ error: "This client's invoice is already sent." });
    if (decision === "reopen") {
      delete state.resolutions[key];
    } else if (decision === "bill" || decision === "no_charge") {
      if (line.status !== "flagged" && !line.resolution) return res.status(409).json({ error: "Only flagged lines need a decision." });
      state.resolutions[key] = { decision, note: String(note).slice(0, 300), at: new Date().toISOString() };
    } else {
      return res.status(400).json({ error: "decision must be bill, no_charge or reopen." });
    }
    rebuild(state);
    const after = state.ledger.lines.find((l) => l.key === key);
    store.log(state, `${line.client_name}: ${line.item} → ${decision === "bill" ? `billed ${money(after.amount)}` : decision === "no_charge" ? "not billed" : "reopened"}.`, "owner");
    store.save(state);
    res.json({ ok: true });
  });

  const failed = (res, state, err, what) => {
    store.log(state, `${what} failed: ${err.message}`, "error");
    store.save(state);
    res.status(err instanceof ApprovalError ? 403 : 502).json({ error: err.message });
  };

  // The Approve button. The only route that sends a new invoice.
  app.post("/api/clients/:id/approve", async (req, res) => {
    const state = store.load();
    if (!state.ledger) return res.status(409).json({ error: "Build the ledger first." });
    const summary = state.ledger.clients.find((c) => c.id === req.params.id);
    if (!summary) return res.status(404).json({ error: "No such client." });
    if (state.invoices[summary.id]) return res.status(409).json({ error: "Already invoiced." });
    if (summary.open_flags > 0) {
      return res.status(409).json({ error: `Decide the ${summary.open_flags} flagged line(s) first.` });
    }
    const draft = invoiceDraft(state.ledger, agency, summary.id, { invoiceDate: paypal.today() });
    if (draft.total <= 0) return res.status(409).json({ error: "Nothing to bill." });
    if (Number(req.body?.expected_total) !== draft.total) {
      return res.status(409).json({ error: "The ledger changed since you reviewed it. Review again before approving." });
    }
    try {
      const approval = issueApproval(draft, { approvedBy: owner });
      const invoice = await sendApproved(draft, approval);
      state.invoices[summary.id] = collect.newRecord({ draft, invoice, approval, mode: paypal.mode });
      store.log(state, `${owner} approved ${summary.name}: ${money(draft.total)}, ${draft.lines.length} lines.`, "owner");
      store.log(state, `PayPal (${paypal.mode}) invoice ${invoice.number} created and sent to ${draft.billing_email}; due ${draft.due_date}.`, "paypal");
      store.save(state);
      res.json({ ok: true, invoice: state.invoices[summary.id] });
    } catch (err) {
      failed(res, state, err, "Sending to PayPal");
    }
  });

  // ---------- Collections ----------
  // A PayPal payment on an invoice: kept with the record (its capture is what a
  // later refund returns money from). "awaiting" is set before the PayPal call,
  // because PayPal's webhook can arrive before the call returns.
  async function takePayment(paypalId, what, pay) {
    let state = store.load();
    const record = collect.findRecord(state, paypalId);
    const owed = Math.round((record.total - record.paid) * 100) / 100;
    record.awaiting = { what: "payment", at: new Date().toISOString() };
    store.save(state);
    try {
      const paid = await pay(record, owed);
      state = store.load();
      const fresh = collect.findRecord(state, paypalId);
      (fresh.payments ||= []).push({ capture_id: paid.capture_id, order_id: paid.order_id, amount: owed, at: new Date().toISOString(), via: what });
      return { state, record: fresh, paid, owed };
    } catch (err) {
      state = store.load();
      const fresh = collect.findRecord(state, paypalId);
      if (fresh) fresh.awaiting = null;
      store.save(state);
      throw err;
    }
  }

  // Demo only: stands in for the client paying by card on their own. PayPal
  // takes a real sandbox payment from a test card, the payment is recorded on
  // the invoice, and PayPal's own webhook is what marks the invoice paid here.
  app.post("/api/invoices/:pid/test-pay", async (req, res) => {
    const record = collect.findRecord(store.load(), req.params.pid);
    if (!record) return res.status(404).json({ error: "No such invoice." });
    if (!collect.OPEN.has(record.status)) return res.status(409).json({ error: `This invoice is ${record.status.toLowerCase()}.` });
    if (record.awaiting) return res.status(409).json({ error: "This invoice is waiting for PayPal's webhook." });
    try {
      const out = await takePayment(record.paypal_id, "test card", (r, owed) => paypal.payWithTestCard(r.paypal_id, r.number, owed, agency.currency));
      store.log(out.state, `Demo: ${out.record.client_name} pays invoice ${out.record.number} by card. PayPal captured ${money(out.owed)} (capture ${out.paid.capture_id}) and it is recorded on the invoice; waiting for PayPal's webhook to mark it paid.`, "paypal");
      store.save(out.state);
      res.json({ ok: true });
    } catch (err) {
      failed(res, store.load(), err, "The test payment");
    }
  });

  // The client's human approves (or declines) a payment their agent asked for
  // over MCP. Approval is tied to this exact payment; PayPal then charges the
  // card the client saved in PayPal Vault.
  app.post("/api/payments/:id/:decision", async (req, res) => {
    const { id, decision } = req.params;
    let state = store.load();
    const request = state.payment_requests[id];
    if (!request) return res.status(404).json({ error: "No such payment." });
    if (request.status !== "awaiting_approval") return res.status(409).json({ error: "This payment is already decided." });
    const agent = agentFor(request.client_id);
    const record = collect.findRecord(state, request.paypal_id);
    if (decision === "decline") {
      request.status = "declined";
      store.log(state, `${agent.human} declined ${agent.name}'s payment of ${money(request.amount)} on invoice ${request.invoice_number}.`, "client");
      settlementStep(request.client_id, { who: "client_human", text: `${agent.human} declined paying ${money(request.amount)}.` });
      store.save(state);
      return res.json({ ok: true });
    }
    if (decision !== "approve") return res.status(400).json({ error: "decision must be approve or decline." });
    if (Number(req.body?.expected_amount) !== request.amount) return res.status(409).json({ error: "The payment changed since you reviewed it. Review again." });
    if (!record || !collect.OPEN.has(record.status) || Math.round((record.total - record.paid) * 100) / 100 !== request.amount) {
      return res.status(409).json({ error: "The invoice changed since this payment was asked for." });
    }
    const saved = state.saved_methods[request.client_id];
    if (!saved) return res.status(409).json({ error: `${agent.client_name} has no payment method saved in PayPal.` });
    const payment = { kind: "payment", invoice_id: request.paypal_id, number: request.invoice_number, amount: request.amount, currency: request.currency, vault_id: saved.vault_id, request_id: request.id };
    const approval = issueApproval(payment, { approvedBy: `${agent.human} (${agent.client_name})` });
    request.status = "sending";
    store.save(state);
    settlementStep(request.client_id, { who: "client_human", text: `${agent.human} approved paying ${money(request.amount)} on invoice ${request.invoice_number} with the ${saved.brand} ending ${saved.last_digits} saved in PayPal.` });
    try {
      const out = await takePayment(request.paypal_id, `${saved.brand} ·${saved.last_digits} saved in PayPal Vault`, () => paypal.payInvoice(payment, approval));
      const fresh = out.state.payment_requests[id];
      fresh.status = collect.PAID.has(out.record.status) ? "paid" : "sent_to_paypal";
      fresh.approved_at = approval.approved_at;
      fresh.paypal = { order_id: out.paid.order_id, capture_id: out.paid.capture_id };
      store.log(out.state, `${agent.human} approved ${agent.name}'s payment. PayPal charged the saved ${saved.brand} ending ${saved.last_digits}: ${money(request.amount)} captured (capture ${out.paid.capture_id}), recorded on invoice ${request.invoice_number}.`, "paypal");
      store.save(out.state);
      settlementStep(request.client_id, { who: "paypal", text: `PayPal charged the saved card: ${money(request.amount)} captured (capture ${out.paid.capture_id}). Waiting for PayPal's webhook.` });
      res.json({ ok: true });
    } catch (err) {
      state = store.load();
      state.payment_requests[id].status = "failed";
      settlementStep(request.client_id, { who: "paypal", text: `PayPal did not take the payment: ${err.message}` });
      failed(res, state, err, "The payment");
    }
  });

  // Send reminder: the owner approves the exact text shown.
  app.post("/api/invoices/:pid/remind", async (req, res) => {
    const state = store.load();
    const record = collect.findRecord(state, req.params.pid);
    if (!record) return res.status(404).json({ error: "No such invoice." });
    const today = paypal.today();
    if (!collect.daysOverdue(record, today)) return res.status(409).json({ error: "This invoice is not overdue." });
    const reminder = collect.reminderFor(record, agency, today);
    if (req.body?.subject !== reminder.subject || req.body?.note !== reminder.note) {
      return res.status(409).json({ error: "The reminder changed since you reviewed it. Review again." });
    }
    try {
      await paypal.sendInvoiceReminder(reminder, issueApproval(reminder, { approvedBy: owner }));
      record.reminders.push({ at: new Date().toISOString(), by: owner });
      store.log(state, `${owner} approved a reminder for ${record.client_name} invoice ${record.number} (${collect.daysOverdue(record, today)} days overdue). PayPal sent it.`, "owner");
      store.save(state);
      res.json({ ok: true });
    } catch (err) {
      failed(res, state, err, "Sending the reminder");
    }
  });

  // "Check PayPal": list_invoices, then get_invoice for any not on that page.
  app.post("/api/collections/refresh", async (req, res) => {
    const state = store.load();
    const records = collect.allRecords(state);
    try {
      const listed = new Map((await paypal.listInvoices()).items.map((s) => [s.id, s]));
      let changed = 0;
      for (const record of records) {
        const summary = listed.get(record.paypal_id) || (await paypal.getInvoice(record.paypal_id).catch(() => null));
        const line = collect.reconcile(record, summary);
        if (line) {
          store.log(state, line, "paypal");
          changed += 1;
        }
      }
      store.save(state);
      res.json({ ok: true, checked: records.length, changed });
    } catch (err) {
      failed(res, state, err, "Checking PayPal");
    }
  });

  // ---------- Client replies and agent disputes ----------
  // A recorded draft is used only if it still fits: same paid state, rows that
  // exist, and (for an agent's dispute) the same line.
  const recordedDraft = (thread, view, sources) => {
    const rec = loadRecordedDrafts()[thread.recording_key || thread.id];
    if (!rec || rec.invoice_paid !== view.paid || draftProblem(rec.draft, view, sources)) return null;
    return !thread.line_key || rec.draft.line_key === thread.line_key ? rec : null;
  };

  // What Claude reads as the client's message: an emailed reply, or an agent's dispute.
  const replyFor = (thread) => clientReplies.find((r) => r.id === thread.id) || { id: thread.id, from: thread.from, subject: thread.subject, body: thread.body };

  function attachDraft(state, thread, draft, meta) {
    thread.draft = draft;
    thread.draft_meta = meta;
    const line = state.invoices[thread.client_id].items.find((l) => l.key === draft.line_key);
    const call = draft.recommend_credit ? "recommends a credit" : "recommends keeping the charge";
    store.log(state, `Claude (${meta.kind}) checked ${thread.client_name}'s ${thread.channel === "agent" ? "agent's dispute" : "reply"} against ${draft.cited_sources.join(", ")}: ${line.item}, ${draft.finding.replace(/_/g, " ")}; ${call}.`, "agent");
  }

  // ---------- MCP: the client's own agent ----------
  // Live rulings on agent disputes cost API credit, so a server makes a few at most.
  const LIVE_RULINGS = Number(process.env.PAYTALLY_LIVE_RULINGS ?? 12);
  let liveRulings = 0;

  // PayTally's agent checks an agent's dispute: a recorded Claude ruling when one
  // fits (the demo default), else a live one when this server can make it.
  async function ruleOn(threadId, { live }) {
    const sources = loadSources();
    const before = store.load();
    const thread = before.threads[threadId];
    const view = collect.invoiceView(before.invoices[thread.client_id]);
    let out = null;
    let notice = "";
    const rec = recordedDraft(thread, view, sources);
    if ((live || !rec) && hasClaudeKey() && liveRulings < LIVE_RULINGS) {
      liveRulings += 1;
      const started = Date.now();
      try {
        const client = agency.clients.find((c) => c.id === thread.client_id);
        out = await draftReply({ agency, client, invoice: view, sources, reply: replyFor(thread) });
        const problem = draftProblem(out.draft, view, sources) || (out.draft.line_key !== thread.line_key ? "the ruling is about a different line" : "");
        if (problem) throw new Error(problem);
        out = { ...out, seconds: Math.round((Date.now() - started) / 1000) };
      } catch (err) {
        out = null;
        notice = `The live ruling failed (${err.message})${rec ? ", so this is the recorded one" : ""}.`;
      }
    }
    const state = store.load();
    const current = state.threads[threadId];
    if (out) attachDraft(state, current, out.draft, { kind: "live", model: out.model, at: new Date().toISOString(), seconds: out.seconds, score: null });
    else if (rec) attachDraft(state, current, rec.draft, { kind: "recorded", model: rec.model, at: rec.recorded_at, score: rec.score });
    if (notice) store.log(state, notice, "error");
    store.save(state);
    return state;
  }

  const mcpHandlers = {
    get_ledger: async (agent) => settle.ledgerView(store.load(), agency, agent.client_id),
    explain_charge: async (agent, { line_key }) => settle.explainCharge(store.load(), agency, loadSources(), agent.client_id, line_key),
    dispute_line: async (agent, args) => {
      const state = store.load();
      const thread = settle.openDispute(state, agency, agent, args);
      store.log(state, `${agent.name} disputed ${state.invoices[agent.client_id]?.items.find((l) => l.key === thread.line_key)?.item || thread.line_key} over MCP (${thread.id}).`, "client");
      store.save(state);
      const after = await ruleOn(thread.id, { live: store.loadSettlement().mode === "live" });
      const t = after.threads[thread.id];
      if (t.draft) {
        settlementStep(agent.client_id, { who: "paytally", text: `PayTally's agent checked ${t.draft.cited_sources.join(", ")}: ${t.draft.finding.replace(/_/g, " ")}. It recommends ${t.draft.recommend_credit ? "a credit" : "keeping the charge"}; ${owner} decides.` });
      }
      return settle.disputeView(after, loadSources(), t, creditPreview(after, t, loadSources()), owner);
    },
    get_dispute: async (agent, { dispute_id }) => {
      const state = store.load();
      const thread = state.threads[dispute_id];
      if (!thread || thread.client_id !== agent.client_id) throw new settle.AgentError(`No dispute ${dispute_id} for this client.`);
      return settle.disputeView(state, loadSources(), thread, creditPreview(state, thread, loadSources()), owner);
    },
    approve_and_pay: async (agent, args) => {
      const state = store.load();
      if (!state.saved_methods[agent.client_id]) throw new settle.AgentError(`${agent.client_name} has no payment method saved in PayPal yet.`);
      const before = Object.keys(state.payment_requests).length;
      const request = settle.requestPayment(state, agent, args);
      if (Object.keys(state.payment_requests).length > before) {
        const saved = state.saved_methods[agent.client_id];
        store.log(state, `${agent.name} asked to pay invoice ${request.invoice_number} (${money(request.amount)}, within the ${money(agent.cap)} cap) with the ${saved.brand} ending ${saved.last_digits} saved in PayPal. Waiting for ${agent.human}.`, "client");
        settlementStep(agent.client_id, { who: "paytally", text: `Payment ${request.id} set up: ${money(request.amount)} on invoice ${request.invoice_number}, within the ${money(agent.cap)} cap. Nothing moves until ${agent.human} approves.` });
      }
      store.save(state);
      return { ...settle.paymentView(state, request), next: `${agent.human} approves this payment in PayTally with one tap. Call get_payment to follow it.` };
    },
    get_payment: async (agent, { payment_id }) => {
      const state = store.load();
      const request = state.payment_requests[payment_id];
      if (!request || request.client_id !== agent.client_id) throw new settle.AgentError(`No payment ${payment_id} for this client.`);
      return settle.paymentView(state, request);
    },
  };

  mountMcp(app, {
    agentForToken: (token) => clientAgents.find((a) => a.token === token) || null,
    handlers: mcpHandlers,
    log: (agent, tool, args, outcome) => {
      const state = store.load();
      store.logMcp(state, { client_id: agent.client_id, agent: agent.name, tool, args, ok: outcome.ok, error: outcome.error || null });
      store.save(state);
    },
  });

  // ---------- Agent settlement (the demo's two-agent run) ----------
  // Phase "audit": the client's agent reads the invoice, checks each line
  // against its own records, asks for proof and disputes. Then the owner
  // answers. Phase "settle": the agent checks the answer and asks to pay; the
  // client's human approves; PayPal charges the saved card; PayPal's webhook
  // closes it. Recorded by default (the agent's words and choices replayed,
  // every tool call real); live with Claude when the server has a key.
  const LIVE_SETTLEMENTS = Number(process.env.PAYTALLY_LIVE_SETTLEMENTS ?? 6);
  let liveSettlements = 0;

  function settlementBlocker(phase, agent) {
    const state = store.load();
    const s = store.loadSettlement();
    if (s.running) return "The client's agent is already working.";
    const record = state.invoices[agent.client_id];
    if (!record) return `Approve and send ${agent.client_name}'s invoice first.`;
    if (phase === "audit" && s.phases_done.includes("audit")) return "The agent already checked this invoice. Reset the demo to run it again.";
    if (phase === "settle") {
      if (!s.phases_done.includes("audit")) return "Run the agent's check first.";
      if (s.phases_done.includes("settle")) return "The agent already settled this invoice.";
      const open = Object.values(state.threads).filter((t) => t.channel === "agent" && t.client_id === agent.client_id && t.status === "open");
      if (open.length) return `Answer the agent's dispute first (${open.map((t) => t.id).join(", ")}).`;
    }
    return "";
  }

  // Live or recorded, decided before anything starts. A recording only fits the
  // invoice it was made on: the audit assumes the owner didn't bill Robert
  // Okafor; the settle phase assumes the owner credited the disputed line.
  function planSettlement(phase, mode) {
    const agent = clientAgents[0];
    const s = store.loadSettlement();
    const recording = loadRecordedSettlement();
    const record = store.load().invoices[agent.client_id];
    const owed = record ? Math.round((record.total - record.paid) * 100) / 100 : null;
    const want = phase === "audit" ? recording?.assumes?.invoice_total : recording?.assumes?.owed_after_answer;
    const fits = Boolean(recording?.phases?.[phase]) && owed === want;
    let notice = "";
    let live = phase === "audit" ? mode === "live" : s.mode === "live";
    if (live && !hasClaudeKey()) {
      live = false;
      notice = "No Anthropic key on this server, so this is the recorded run.";
    } else if (live && phase === "audit" && liveSettlements >= LIVE_SETTLEMENTS) {
      live = false;
      notice = "This server has used its live runs, so this is the recorded run.";
    }
    if (!live && !fits) {
      if (!recording?.phases?.[phase]) throw new settle.AgentError("There is no recorded run, and this server can't run Claude live.");
      throw new settle.AgentError(
        phase === "audit"
          ? `The recorded run starts from a ${money(want)} invoice, with Robert Okafor not billed. This one is ${money(owed || 0)}: run it live, or reset the demo and choose "Don't bill" for Robert Okafor.`
          : `The recorded run assumes you credited the disputed line, leaving ${money(want)} owed. Now ${money(owed || 0)} is owed, so the recording doesn't fit.`,
      );
    }
    return { agent, live, notice, recording };
  }

  async function runSettlementPhase(phase, { agent, live: useLive, notice, recording }, baseUrl) {
    store.updateSettlement((x) => {
      if (phase === "audit") Object.assign(x, { client_id: agent.client_id, mode: useLive ? "live" : "recorded", steps: [], messages: [], phases_done: [], usage: null });
      x.running = phase;
      x.notice = notice;
      x.steps.push({ at: new Date().toISOString(), who: "system", text: phase === "audit" ? `${agent.name} connects to PayTally's MCP server as ${agent.client_name} (${useLive ? "live Claude" : "recorded Claude run; every tool call runs for real"}).` : `${agent.name} picks the invoice back up.` });
    });
    const onStep = (step) => settlementStep(agent.client_id, { who: "client_agent", ...step });
    const url = `${baseUrl}/mcp`;
    const started = Date.now();
    try {
      if (useLive) {
        liveSettlements += 1;
        const out = await runClientPhase({ url, agent, phase, history: store.loadSettlement().messages, onStep });
        store.updateSettlement((x) => {
          x.messages = out.messages;
          x.model = out.model;
          x.usage = out.usage;
          x.phase_seconds = { ...(x.phase_seconds || {}), [phase]: Math.round((Date.now() - started) / 1000) };
        });
      } else {
        await replayClientPhase({ url, agent, recording: recording.phases[phase], onStep });
        store.updateSettlement((x) => (x.model = recording.model));
      }
      store.updateSettlement((x) => x.phases_done.push(phase));
    } catch (err) {
      settlementStep(agent.client_id, { who: "system", text: `The client's agent stopped: ${err.message}` });
      const state = store.load();
      store.log(state, `The client's agent stopped: ${err.message}`, "error");
      store.save(state);
    } finally {
      store.updateSettlement((x) => (x.running = null));
    }
  }

  app.post("/api/settlement/:phase", (req, res) => {
    const phase = req.params.phase === "start" ? "audit" : req.params.phase === "resume" ? "settle" : null;
    if (!phase) return res.status(404).json({ error: "No such step." });
    const blocker = settlementBlocker(phase, clientAgents[0]);
    if (blocker) return res.status(409).json({ error: blocker });
    let plan;
    try {
      plan = planSettlement(phase, req.body?.mode === "live" ? "live" : "recorded");
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    // The client's agent reaches this same server over HTTP, like any outside agent.
    const baseUrl = `http://127.0.0.1:${req.socket.localPort}`;
    store.updateSettlement((x) => (x.running = phase));
    runSettlementPhase(phase, plan, baseUrl).catch((err) => console.error(`Settlement failed: ${err.message}`));
    res.json({ ok: true, live: plan.live, notice: plan.notice });
  });

  // Demo only: the client's reply arrives after their invoice is sent.
  app.post("/api/replies/:id/arrive", (req, res) => {
    const reply = clientReplies.find((r) => r.id === req.params.id);
    if (!reply) return res.status(404).json({ error: "No such reply." });
    const state = store.load();
    const record = state.invoices[reply.client_id];
    if (!record) return res.status(409).json({ error: "Send this client's invoice first." });
    if (state.threads[reply.id]) return res.status(409).json({ error: "This reply already arrived." });
    if (!collect.replyCanArrive(reply, record)) {
      return res.status(409).json({ error: reply.arrives === "paid" ? "In this demo the reply comes after the client pays." : "In this demo the reply comes before the client pays." });
    }
    const client = agency.clients.find((c) => c.id === reply.client_id);
    const thread = {
      id: reply.id,
      client_id: client.id,
      client_name: client.name,
      from: reply.from,
      subject: reply.subject,
      body: reply.body,
      arrived_at: new Date().toISOString(),
      invoice_number: record.number,
      status: "open",
      draft: null,
      draft_meta: null,
      answer: null,
    };
    state.threads[reply.id] = thread;
    store.log(state, `Email from ${reply.from.replace(/ <.*/, "")} (${client.name}) about invoice ${record.number}: "${reply.subject}".`);
    const rec = recordedDraft(thread, collect.invoiceView(record), loadSources());
    if (rec) attachDraft(state, thread, rec.draft, { kind: "recorded", model: rec.model, at: rec.recorded_at, score: rec.score });
    store.save(state);
    res.json({ ok: true });
  });

  const replyInFlight = new Map();

  // "Draft live with Claude". Any failure falls back to the recorded draft.
  app.post("/api/replies/:id/draft", async (req, res) => {
    const before = store.load();
    const thread = before.threads[req.params.id];
    const reply = thread && replyFor(thread);
    if (!reply || !thread) return res.status(404).json({ error: "No such reply." });
    if (thread.status !== "open") return res.status(409).json({ error: "This reply is already answered." });
    const sources = loadSources();
    const view = collect.invoiceView(before.invoices[thread.client_id]);
    let notice = "";
    let out = null;
    if (!hasClaudeKey()) {
      notice = "No Anthropic key on this server, so this is the recorded draft.";
    } else {
      const started = Date.now();
      try {
        if (!replyInFlight.has(thread.id)) {
          const client = agency.clients.find((c) => c.id === thread.client_id);
          replyInFlight.set(thread.id, draftReply({ agency, client, invoice: view, sources, reply }).finally(() => replyInFlight.delete(thread.id)));
        }
        out = await replyInFlight.get(thread.id);
        const problem = draftProblem(out.draft, view, sources) || (thread.line_key && out.draft.line_key !== thread.line_key ? "The draft is about a different line than the dispute." : "");
        if (problem) throw new Error(problem);
        out = { ...out, seconds: Math.round((Date.now() - started) / 1000) };
      } catch (err) {
        out = null;
        notice = `The live Claude draft failed (${err.message}), so this is the recorded draft.`;
      }
    }
    // Load state after the (slow) live call so changes made meanwhile are kept.
    const state = store.load();
    const current = state.threads[thread.id];
    if (current?.status !== "open") return res.status(409).json({ error: "This reply was answered meanwhile." });
    if (out) {
      attachDraft(state, current, out.draft, { kind: "live", model: out.model, at: new Date().toISOString(), seconds: out.seconds, score: reply.expected ? scoreDraft(out.draft, reply.expected, view) : null });
    } else {
      store.log(state, notice, "error");
      const rec = recordedDraft(current, view, sources);
      if (rec) attachDraft(state, current, rec.draft, { kind: "recorded", model: rec.model, at: rec.recorded_at, score: rec.score });
    }
    store.save(state);
    res.json({ ok: true, fallback: Boolean(notice), notice });
  });

  // The owner answers: keep the charge, or credit the line. A credit reaches
  // PayPal as a corrected invoice (unpaid) or a recorded refund (paid).
  app.post("/api/replies/:id/send", async (req, res) => {
    const state = store.load();
    const sources = loadSources();
    const thread = state.threads[req.params.id];
    if (!thread) return res.status(404).json({ error: "No such reply." });
    if (thread.status !== "open" || !thread.draft) return res.status(409).json({ error: "Nothing to send." });
    const decision = req.body?.decision;
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: "Write the reply first." });
    if (decision !== "credit" && decision !== "keep") return res.status(400).json({ error: "decision must be credit or keep." });
    const record = state.invoices[thread.client_id];
    const who = thread.from.replace(/ <.*/, "");
    const at = new Date().toISOString();

    if (decision === "keep") {
      const line = record.items.find((l) => l.key === thread.draft.line_key);
      thread.status = "answered";
      thread.answer = { decision, text, at, by: owner };
      store.log(state, `${owner} replied to ${who}: the charge for ${line?.item || "the line"} stands.`, "owner");
      if (thread.channel === "agent") settlementStep(thread.client_id, { who: "owner", text: `${owner} (agency owner) kept the charge for ${line?.item || "the line"} and sent the evidence.` });
      store.save(state);
      return res.json({ ok: true });
    }

    const preview = creditPreview(state, thread, sources);
    if (!preview || !preview.how) return res.status(409).json({ error: "This invoice can't take a credit in its current state." });
    if (preview.amount <= 0) return res.status(409).json({ error: "Crediting this line changes nothing." });
    if (Number(req.body?.expected_credit) !== preview.amount) {
      return res.status(409).json({ error: "The credit changed since you reviewed it. Review again." });
    }
    const credit = { decision: "credit", ref: `reply ${thread.id}`, note: "", at };
    const answered = (s) => {
      const t = s.threads[thread.id];
      t.status = "answered";
      t.answer = { decision, text, at, by: owner, credit: preview.amount, how: preview.how };
      store.log(s, `${owner} replied to ${who}.`, "owner");
      if (t.channel === "agent") {
        settlementStep(t.client_id, { who: "owner", text: `${owner} (agency owner) credited ${preview.item}: ${money(preview.amount)} off. ${preview.how === "refund" ? "PayPal refunds it." : "PayPal cancels the invoice and sends a corrected one."}` });
      }
    };
    try {
      if (preview.how === "refund") {
        // Paid through PayPal: PayPal returns the money from the original capture.
        const capture = (record.payments || []).at(-1);
        const refund = { kind: "refund", invoice_id: record.paypal_id, amount: preview.amount, currency: agency.currency, capture_id: capture?.capture_id || null, note: `Credit for ${preview.item}, after your reply.`, request_id: `refund-${thread.id}` };
        const approval = issueApproval(refund, { approvedBy: owner });
        record.awaiting = { what: "refund", at };
        store.save(state);
        let out;
        try {
          out = await paypal.refundPayment(refund, approval);
        } catch (err) {
          const s = store.load();
          collect.findRecord(s, record.paypal_id).awaiting = null;
          store.save(s);
          throw err;
        }
        const s = store.load();
        const fresh = collect.findRecord(s, record.paypal_id);
        (fresh.refunds ||= []).push({ refund_id: out.refund_id, capture_id: refund.capture_id, amount: preview.amount, at, moved_money: out.moved_money });
        s.resolutions[preview.line_key] = credit;
        rebuild(s, sources);
        store.log(
          s,
          out.moved_money
            ? `${owner} credited ${preview.item} (${money(preview.amount)}). PayPal refunded it to ${thread.client_name} from capture ${refund.capture_id} (refund ${out.refund_id}) and the refund is noted on invoice ${record.number}.`
            : `${owner} credited ${preview.item} (${money(preview.amount)}). PayPal noted the refund on invoice ${record.number} (that payment was made outside PayPal).`,
          "owner",
        );
        answered(s);
        store.save(s);
      } else {
        const cancel = { kind: "cancel", invoice_id: record.paypal_id, note: `Replaced by a corrected invoice: ${preview.item} is credited after your reply.` };
        await paypal.cancelSentInvoice(cancel, issueApproval(cancel, { approvedBy: owner }));
        const s = store.load();
        const old = s.invoices[record.client_id];
        old.status = "CANCELLED";
        delete s.invoices[record.client_id];
        s.history.push(old);
        s.resolutions[preview.line_key] = credit;
        rebuild(s, sources);
        store.log(s, `${owner} credited ${preview.item} (${money(preview.amount)}). PayPal cancelled invoice ${record.number}.`, "owner");
        const draft = invoiceDraft(s.ledger, agency, record.client_id, { invoiceDate: paypal.today() });
        draft.replaces = { id: record.paypal_id, number: record.number, why: `${preview.item} credited after your reply.` };
        if (draft.total !== preview.new_total) throw new Error("The corrected total does not match what you approved.");
        const approval = issueApproval(draft, { approvedBy: owner });
        store.save(s);
        const invoice = await sendApproved(draft, approval);
        const s2 = store.load();
        const next = collect.newRecord({ draft, invoice, approval, mode: paypal.mode });
        collect.findRecord(s2, record.paypal_id).replaced_by = next.paypal_id;
        s2.invoices[record.client_id] = next;
        store.log(s2, `PayPal (${paypal.mode}) corrected invoice ${invoice.number} for ${money(draft.total)} sent to ${draft.billing_email}, replacing ${record.number}.`, "paypal");
        answered(s2);
        store.save(s2);
        if (thread.channel === "agent") settlementStep(record.client_id, { who: "paypal", text: `PayPal cancelled invoice ${record.number} and sent corrected invoice ${invoice.number} for ${money(draft.total)}.` });
      }
      res.json({ ok: true });
    } catch (err) {
      failed(res, store.load(), err, "Applying the credit");
    }
  });

  app.post("/api/reset", (req, res) => {
    store.reset();
    mockPaypal.reset();
    res.json({ ok: true });
  });

  // What the client would see, while PayPal is mocked.
  app.get("/mock-paypal/invoice/:id", async (req, res) => {
    const inv = await mockPaypal.rawInvoice(req.params.id);
    if (!inv) return res.status(404).send("No such mock invoice.");
    const p = inv.params;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = p.items
      .map((i) => `<tr><td><strong>${esc(i.name)}</strong><br><small>${esc(i.description)}</small></td><td class="n">$${esc(i.unit_amount.value)}</td></tr>`)
      .join("");
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock invoice ${esc(inv.number)}</title><link rel="stylesheet" href="/mock-invoice.css"></head><body><main><p class="tag">Mock PayPal invoice · nothing was really sent</p><h1>${esc(p.invoicer_business_name)}</h1><p>To ${esc(p.primary_recipients[0].billing_info.business_name)} · ${esc(p.reference)} · ${esc(inv.status)}</p><p class="id">Invoice ${esc(inv.number)} · ${esc(inv.id)}</p><table>${rows}<tr class="total"><td>Total due</td><td class="n">$${esc(inv.total.toFixed(2))}</td></tr></table><p class="note">${esc(p.note)}</p></main></body></html>`);
  });

  return app;
}
