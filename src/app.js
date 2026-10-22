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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function createApp({
  extract = extractWithClaude,
  draftReply = draftReplyWithClaude,
  hasClaudeKey = () => Boolean(process.env.ANTHROPIC_API_KEY),
  registerWebhook = true,
} = {}) {
  const app = express();
  const agency = loadAgency();
  const owner = agency.agency.owner;
  const clientReplies = loadClientReplies();
  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "history.json"), "utf8")).invoices;

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
    store.save(state);
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
    return { line_key: line.key, item: line.item, amount, new_total: after.total, how };
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
  // Demo only: stands in for the client paying. PayPal records a test payment,
  // then PayPal's own webhook is what marks the invoice paid here.
  app.post("/api/invoices/:pid/test-pay", async (req, res) => {
    const state = store.load();
    const record = collect.findRecord(state, req.params.pid);
    if (!record) return res.status(404).json({ error: "No such invoice." });
    if (!collect.OPEN.has(record.status)) return res.status(409).json({ error: `This invoice is ${record.status.toLowerCase()}.` });
    const owed = record.total - record.paid;
    try {
      await paypal.recordTestPayment(record.paypal_id, owed, agency.currency);
      record.awaiting = { what: "payment", at: new Date().toISOString() };
      store.log(state, `Demo: ${record.client_name} pays invoice ${record.number}. PayPal recorded a test payment of ${money(owed)}; waiting for PayPal's webhook to mark it paid.`, "paypal");
      store.save(state);
      res.json({ ok: true });
    } catch (err) {
      failed(res, state, err, "Recording the test payment");
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

  // ---------- Client replies ----------
  const recordedDraft = (id, view, sources) => {
    const rec = loadRecordedDrafts()[id];
    return rec && rec.invoice_paid === view.paid && !draftProblem(rec.draft, view, sources) ? rec : null;
  };

  function attachDraft(state, thread, draft, meta) {
    thread.draft = draft;
    thread.draft_meta = meta;
    const line = state.invoices[thread.client_id].items.find((l) => l.key === draft.line_key);
    const call = draft.recommend_credit ? "recommends a credit" : "recommends keeping the charge";
    store.log(state, `Claude (${meta.kind}) checked ${thread.client_name}'s reply against ${draft.cited_sources.join(", ")}: ${line.item}, ${draft.finding.replace(/_/g, " ")}; ${call}.`, "agent");
  }

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
    const rec = recordedDraft(reply.id, collect.invoiceView(record), loadSources());
    if (rec) attachDraft(state, thread, rec.draft, { kind: "recorded", model: rec.model, at: rec.recorded_at, score: rec.score });
    store.save(state);
    res.json({ ok: true });
  });

  const replyInFlight = new Map();

  // "Draft live with Claude". Any failure falls back to the recorded draft.
  app.post("/api/replies/:id/draft", async (req, res) => {
    const reply = clientReplies.find((r) => r.id === req.params.id);
    const before = store.load();
    const thread = before.threads[req.params.id];
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
        const problem = draftProblem(out.draft, view, sources);
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
      attachDraft(state, current, out.draft, { kind: "live", model: out.model, at: new Date().toISOString(), seconds: out.seconds, score: scoreDraft(out.draft, reply.expected, view) });
    } else {
      store.log(state, notice, "error");
      const rec = recordedDraft(thread.id, view, sources);
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
    try {
      if (preview.how === "refund") {
        const refund = { kind: "refund", invoice_id: record.paypal_id, amount: preview.amount, currency: agency.currency };
        await paypal.recordRefund(refund, issueApproval(refund, { approvedBy: owner }));
        record.awaiting = { what: "refund", at };
        state.resolutions[preview.line_key] = credit;
        rebuild(state, sources);
        store.log(state, `${owner} credited ${preview.item} (${money(preview.amount)}). PayPal recorded the refund on invoice ${record.number}.`, "owner");
      } else {
        const cancel = { kind: "cancel", invoice_id: record.paypal_id, note: `Replaced by a corrected invoice: ${preview.item} is credited after your reply.` };
        await paypal.cancelSentInvoice(cancel, issueApproval(cancel, { approvedBy: owner }));
        record.status = "CANCELLED";
        delete state.invoices[record.client_id];
        state.history.push(record);
        state.resolutions[preview.line_key] = credit;
        rebuild(state, sources);
        store.log(state, `${owner} credited ${preview.item} (${money(preview.amount)}). PayPal cancelled invoice ${record.number}.`, "owner");
        const draft = invoiceDraft(state.ledger, agency, record.client_id, { invoiceDate: paypal.today() });
        draft.replaces = { id: record.paypal_id, number: record.number, why: `${preview.item} credited after your reply.` };
        if (draft.total !== preview.new_total) throw new Error("The corrected total does not match what you approved.");
        const approval = issueApproval(draft, { approvedBy: owner });
        const invoice = await sendApproved(draft, approval);
        const next = collect.newRecord({ draft, invoice, approval, mode: paypal.mode });
        record.replaced_by = next.paypal_id;
        state.invoices[record.client_id] = next;
        store.log(state, `PayPal (${paypal.mode}) corrected invoice ${invoice.number} for ${money(draft.total)} sent to ${draft.billing_email}, replacing ${record.number}.`, "paypal");
      }
      thread.status = "answered";
      thread.answer = { decision, text, at, by: owner, credit: preview.amount, how: preview.how };
      store.log(state, `${owner} replied to ${who}.`, "owner");
      store.save(state);
      res.json({ ok: true });
    } catch (err) {
      failed(res, state, err, "Applying the credit");
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
