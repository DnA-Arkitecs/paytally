import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as store from "./store.js";
import * as paypal from "./paypal/index.js";
import * as mockPaypal from "./paypal/mock.js";
import { loadAgency, loadSources } from "./sources.js";
import { MODEL, extractFromAnswerKey, extractWithClaude } from "./extract.js";
import { buildLedger, invoiceDraft } from "./ledger.js";
import { issueApproval, ApprovalError } from "./approvals.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function createApp({ extract = extractWithClaude, hasClaudeKey = () => Boolean(process.env.ANTHROPIC_API_KEY) } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, "public")));
  app.use("/vendor/ag-grid", express.static(path.join(ROOT, "node_modules", "ag-grid-community", "dist")));

  const agency = loadAgency();

  function rebuild(state, sources) {
    state.ledger = buildLedger({
      agency,
      extraction: state.extraction.data,
      sources,
      resolutions: state.resolutions,
      extractor: state.extraction.meta,
    });
  }

  app.get("/api/state", (req, res) => {
    const state = store.load();
    const sources = loadSources();
    res.json({
      agency: { name: agency.agency.name, owner: agency.agency.owner, period: agency.period },
      clients: agency.clients.map(({ id, name, summary, terms_text, billing_email }) => ({ id, name, summary, terms_text, billing_email })),
      modes: { extractor: hasClaudeKey() ? "claude" : "answer_key", model: MODEL, paypal: paypal.mode },
      ledger: state.ledger,
      invoices: state.invoices,
      activity: state.activity,
      sources: Object.fromEntries(Object.entries(sources.byRef).map(([ref, r]) => [ref, { label: r.label, raw: r.raw, kind: r.kind, fields: r.fields }])),
      raw: {
        calendar: [sources.calendar.header, ...sources.calendar.rows.map((r) => r.ref)],
        crm: [sources.crm.header, ...sources.crm.rows.map((r) => r.ref)],
        emails: sources.emails.map((e) => e.ref),
      },
    });
  });

  // Read the work log and build the ledger. Claude is called only when the log
  // changed or the owner asks for a fresh read; otherwise the last read is reused.
  app.post("/api/build", async (req, res) => {
    const state = store.load();
    const sources = loadSources();
    const fresh = Boolean(req.body?.fresh);
    try {
      if (hasClaudeKey()) {
        const cached = state.extraction?.meta?.kind === "claude" && state.extraction.meta.source_hash === sources.hash;
        if (!cached || fresh) {
          const started = Date.now();
          const out = await extract({ agency, sources });
          state.extraction = {
            data: out.extraction,
            meta: { kind: "claude", model: out.model, usage: out.usage, seconds: Math.round((Date.now() - started) / 1000), at: new Date().toISOString(), source_hash: sources.hash },
          };
          store.log(state, `Claude (${out.model}) read ${sources.refs.length} rows and emails in ${state.extraction.meta.seconds}s.`, "agent");
        }
      } else {
        state.extraction = {
          data: extractFromAnswerKey(),
          meta: { kind: "answer_key", at: new Date().toISOString(), source_hash: sources.hash },
        };
        store.log(state, "No Anthropic key set: built the ledger from the hand-checked answer key.", "agent");
      }
      rebuild(state, sources);
      const flags = state.ledger.lines.filter((l) => l.status === "flagged").length;
      store.log(state, `Ledger built: ${state.ledger.lines.length} lines, ${flags} need your decision.`);
      store.save(state);
      res.json({ ok: true });
    } catch (err) {
      store.log(state, `Ledger build failed: ${err.message}`, "error");
      store.save(state);
      res.status(502).json({ error: err.message });
    }
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
    rebuild(state, loadSources());
    const after = state.ledger.lines.find((l) => l.key === key);
    store.log(state, `${line.client_name}: ${line.item} → ${decision === "bill" ? `billed ${money(after.amount)}` : decision === "no_charge" ? "not billed" : "reopened"}.`, "owner");
    store.save(state);
    res.json({ ok: true });
  });

  // The Approve button. The only route that reaches PayPal.
  app.post("/api/clients/:id/approve", async (req, res) => {
    const state = store.load();
    if (!state.ledger) return res.status(409).json({ error: "Build the ledger first." });
    const summary = state.ledger.clients.find((c) => c.id === req.params.id);
    if (!summary) return res.status(404).json({ error: "No such client." });
    if (state.invoices[summary.id]) return res.status(409).json({ error: "Already invoiced." });
    if (summary.open_flags > 0) {
      return res.status(409).json({ error: `Decide the ${summary.open_flags} flagged line(s) first.` });
    }
    const draft = invoiceDraft(state.ledger, agency, summary.id);
    if (draft.total <= 0) return res.status(409).json({ error: "Nothing to bill." });
    if (Number(req.body?.expected_total) !== draft.total) {
      return res.status(409).json({ error: "The ledger changed since you reviewed it. Review again before approving." });
    }
    try {
      const approval = issueApproval(draft, { approvedBy: agency.agency.owner });
      const created = await paypal.createInvoice(draft, approval);
      const sent = await paypal.sendInvoice(created.id, draft, approval);
      state.invoices[summary.id] = {
        paypal_id: created.id,
        status: sent.status,
        href: sent.href,
        total: draft.total,
        lines: draft.lines.length,
        to: draft.billing_email,
        approved_by: approval.approved_by,
        approved_at: approval.approved_at,
        approval_hash: approval.hash,
        mode: paypal.mode,
      };
      store.log(state, `${agency.agency.owner} approved ${summary.name}: ${money(draft.total)}, ${draft.lines.length} lines.`, "owner");
      store.log(state, `PayPal (${paypal.mode}) invoice ${created.id} created and sent to ${draft.billing_email}.`, "paypal");
      store.save(state);
      res.json({ ok: true, invoice: state.invoices[summary.id] });
    } catch (err) {
      const status = err instanceof ApprovalError ? 403 : 502;
      store.log(state, `Sending to PayPal failed: ${err.message}`, "error");
      store.save(state);
      res.status(status).json({ error: err.message });
    }
  });

  app.post("/api/reset", (req, res) => {
    store.reset();
    mockPaypal.reset();
    res.json({ ok: true });
  });

  // What the client would see, while PayPal is mocked.
  app.get("/mock-paypal/invoice/:id", async (req, res) => {
    const inv = await mockPaypal.getInvoice(req.params.id);
    if (!inv) return res.status(404).send("No such mock invoice.");
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const rows = inv.items
      .map((i) => `<tr><td><strong>${esc(i.name)}</strong><br><small>${esc(i.description)}</small></td><td class="n">$${esc(i.unit_amount.value)}</td></tr>`)
      .join("");
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock invoice ${esc(inv.id)}</title><link rel="stylesheet" href="/mock-invoice.css"></head><body><main><p class="tag">Mock PayPal invoice · nothing was really sent</p><h1>${esc(inv.invoicer.business_name)}</h1><p>To ${esc(inv.primary_recipients[0].billing_info.business_name)} · ${esc(inv.detail.reference)} · ${esc(inv.status)}</p><p class="id">${esc(inv.id)}</p><table>${rows}<tr class="total"><td>Total due (${esc(inv.detail.payment_term.term_type)})</td><td class="n">$${esc(inv.amount.value)}</td></tr></table><p class="note">${esc(inv.detail.note)}</p></main></body></html>`);
  });

  return app;
}
