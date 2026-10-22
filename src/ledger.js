// Turns an extraction (what happened, per Claude or the answer key) into the
// ledger the owner reviews. Before pricing, it checks the agent's work against
// the raw log: every row must be accounted for, every cited row must exist, and
// no row may be billed twice. Anything that fails becomes a flagged line.
import { priceClient, primarySource } from "./terms.js";

export function checkExtraction(extraction, sources, agency) {
  const issues = [];
  const clientIds = new Set(agency.clients.map((c) => c.id));
  const covered = new Set();
  const primaries = new Map();
  const items = [];

  for (const ref of extraction.ignored.map((i) => i.source)) covered.add(ref);

  for (const item of extraction.items) {
    const missing = item.sources.filter((s) => !sources.byRef[s]);
    item.sources.forEach((s) => covered.add(s));
    if (!clientIds.has(item.client_id)) {
      issues.push({ ref: primarySource(item), why: `The agent assigned ${item.person} to an unknown client "${item.client_id}".` });
      continue;
    }
    if (item.sources.length === 0 || missing.length) {
      items.push({ ...item, unclear: item.sources.length ? `The agent cited ${missing.join(", ")}, which is not in the work log.` : "The agent gave no source row for this line." });
      continue;
    }
    if (item.date < agency.period.start || item.date > agency.period.end) {
      items.push({ ...item, unclear: `Dated ${item.date}, outside ${agency.period.label}.` });
      continue;
    }
    const primary = primarySource(item);
    if (primaries.has(primary)) {
      items.push({ ...item, unclear: `${sources.byRef[primary].label} is already on another line (${primaries.get(primary)}); billing it twice needs your yes.` });
      continue;
    }
    primaries.set(primary, item.person);
    items.push(item);
  }

  for (const ref of sources.refs) {
    if (!covered.has(ref)) issues.push({ ref, why: `${sources.byRef[ref].label} was not accounted for by the agent.` });
  }
  return { items, issues };
}

export function buildLedger({ agency, extraction, sources, resolutions = {}, extractor }) {
  const { items, issues } = checkExtraction(extraction, sources, agency);
  const lines = [];
  for (const client of agency.clients) {
    lines.push(...priceClient(client, items.filter((i) => i.client_id === client.id), resolutions, agency.period));
  }
  for (const issue of issues) {
    lines.push({
      key: `unassigned|${issue.ref}`,
      client_id: "unassigned",
      client_name: "Not assigned",
      date: "",
      person: "",
      item: "Unaccounted row",
      sources: issue.ref ? [issue.ref] : [],
      evidence: "",
      outcome: "unknown",
      amount: 0,
      proposed_amount: 0,
      status: "flagged",
      reason: `Needs your decision: ${issue.why}`,
      flag: issue.why,
      resolution: null,
    });
  }

  const ignored = extraction.ignored.map((i) => ({ ...i, label: sources.byRef[i.source]?.label || i.source }));
  const clients = agency.clients.map((c) => {
    const own = lines.filter((l) => l.client_id === c.id);
    return {
      id: c.id,
      name: c.name,
      summary: c.summary,
      terms_text: c.terms_text,
      billing_email: c.billing_email,
      total: own.reduce((s, l) => s + l.amount, 0),
      billable_lines: own.filter((l) => l.status === "bill").length,
      open_flags: own.filter((l) => l.status === "flagged").length,
      pending_amount: own.filter((l) => l.status === "flagged").reduce((s, l) => s + l.proposed_amount, 0),
    };
  });

  return {
    built_at: new Date().toISOString(),
    period: agency.period,
    extractor,
    source_hash: sources.hash,
    lines,
    ignored,
    clients,
    unassigned_flags: lines.filter((l) => l.client_id === "unassigned").length,
  };
}

// What goes to PayPal: only billed lines, in a fixed shape the approval hashes.
export function invoiceDraft(ledger, agency, clientId) {
  const client = agency.clients.find((c) => c.id === clientId);
  const lines = ledger.lines
    .filter((l) => l.client_id === clientId && l.status === "bill" && l.amount > 0)
    .map((l) => ({ key: l.key, date: l.date, item: l.item, amount: l.amount, reason: l.reason, sources: l.sources }));
  return {
    client_id: client.id,
    client_name: client.name,
    billing_email: client.billing_email,
    contact: client.contact,
    invoicer: agency.agency,
    period: agency.period,
    currency: agency.currency,
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
  };
}
