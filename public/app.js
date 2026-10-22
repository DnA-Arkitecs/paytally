/* global agGrid */
const $ = (sel, el = document) => el.querySelector(sel);
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => currency.format(n || 0);
const shortDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const stamp = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Tiny element builder: h("div", { class: "x", onclick }, "text", child)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let S = null;
let grid = null;
const view = { client: "all", flagsOnly: false, search: "", open: new Set(), collapsed: new Set(), notes: {}, cursor: null, tab: "ledger", building: false, replyChoice: {}, replyText: {} };

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(text, kind = "") {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4200);
}

const sourceLabel = (ref) => (ref === "terms" ? "Agreement" : S.sources[ref]?.label || ref);
const lineFor = (key) => S.ledger?.lines.find((l) => l.key === key);
const clientMeta = (id) => S.clients.find((c) => c.id === id);

// ---------- Grid: the ledger, grouped by client ----------
// AG Grid Community only: each client is a full-width group row, each charge
// opens a full-width row below it with the source rows it came from (and the
// owner's decision, for a flagged line), and a pinned row totals what's on screen.
const isLine = (d) => Boolean(d) && !d.kind;
const STATUS = { bill: "Bill", no_charge: "No charge", flagged: "Needs you" };

function lineVisible(l) {
  const q = view.search.trim().toLowerCase();
  const text = () => [l.item, l.reason, l.client_name, l.evidence, l.flag, ...l.sources.map(sourceLabel), money(l.amount)].join(" ").toLowerCase();
  return (view.client === "all" || l.client_id === view.client) && (!view.flagsOnly || l.status === "flagged") && (!q || text().includes(q));
}

function statusCell(p) {
  if (p.node.rowPinned) return h("strong", {}, "On screen");
  const l = p.data;
  return h("span", { class: `pill ${l.status}` }, STATUS[l.status], l.resolution ? h("span", { class: "you" }, " · your call") : null);
}

function amountCell(p) {
  const l = p.data;
  if (p.node.rowPinned) return h("span", { class: "amt" }, money(l.amount));
  if (l.status === "flagged") return h("span", { class: "amt stake" }, `${money(l.proposed_amount)} at stake`);
  if (l.amount === 0) return h("span", { class: "amt zero" }, money(0));
  return h("span", { class: "amt" }, money(l.amount));
}

function sourceCell(p) {
  if (p.node.rowPinned) return "";
  return h("div", { class: "chips" }, p.data.sources.map((ref) => h("span", { class: "chip", title: S.sources[ref]?.raw || "" }, sourceLabel(ref))));
}

function groupRow(p) {
  const id = p.data.client_id;
  const c = S.ledger.clients.find((x) => x.id === id);
  const lines = S.ledger.lines.filter((l) => l.client_id === id);
  const flags = lines.filter((l) => l.status === "flagged");
  const inv = S.invoices[id];
  const rec = inv && recordFor(inv.paypal_id);
  const state = inv
    ? [isPaid(rec) ? "paid" : "sent", `Invoice ${inv.number} ${isPaid(rec) ? "paid" : "sent"} · ${money(inv.total)}`]
    : flags.length
      ? ["needs", `${flags.length} need${flags.length > 1 ? "" : "s"} you · ${money(flags.reduce((n, l) => n + l.proposed_amount, 0))} at stake`]
      : ["ready", c ? `Ready · ${money(c.total)} to bill` : ""];
  return h(
    "div",
    { class: `grp${view.collapsed.has(id) ? " collapsed" : ""}`, role: "button", tabindex: "0", "aria-expanded": String(!view.collapsed.has(id)), onclick: () => toggleGroup(id) },
    h("span", { class: "chev", "aria-hidden": "true" }, "▾"),
    h("span", { class: "grp-name" }, c ? c.name : "Not tied to a client"),
    c ? h("span", { class: "grp-terms" }, c.summary) : null,
    h("span", { class: "grp-count" }, `${lines.length} line${lines.length === 1 ? "" : "s"}`),
    state[1] ? h("span", { class: `grp-state ${state[0]}` }, state[1]) : null,
  );
}

// The drill-down: why the line is there, the clause it applied, and each
// source row word for word. A flagged line carries the owner's decision.
function detailRow(p) {
  const l = lineFor(p.data.line_key);
  if (!l) return h("div");
  const meta = clientMeta(l.client_id);
  const sent = Boolean(S.invoices[l.client_id]);
  const clauses = meta ? meta.terms_text.filter((t) => (l.reason || "").includes(t.split(" ")[0])) : [];
  let decision = null;
  if (l.status === "flagged" && !sent && l.client_id !== "unassigned") {
    const note = h("textarea", { placeholder: "Optional note, kept with the line (e.g. what the client said)", rows: "2" });
    note.value = view.notes[l.key] || "";
    note.addEventListener("input", () => (view.notes[l.key] = note.value));
    decision = h(
      "div",
      { class: "flagbox" },
      h("p", {}, l.flag),
      note,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", type: "button", onclick: (e) => decide(l.key, "bill", e.currentTarget) }, `Bill ${money(l.proposed_amount)}`, h("kbd", {}, "B")),
        h("button", { class: "btn", type: "button", onclick: (e) => decide(l.key, "no_charge", e.currentTarget) }, "Don't bill", h("kbd", {}, "D")),
      ),
    );
  } else if (l.resolution && !sent) {
    decision = h(
      "div",
      { class: "state ok" },
      `You decided this on ${stamp(l.resolution.at)}${l.resolution.note ? `: "${l.resolution.note}"` : ""}. `,
      h("button", { class: "linkish", type: "button", onclick: (e) => decide(l.key, "reopen", e.currentTarget) }, "Reopen"),
    );
  }
  const el = h(
    "div",
    { class: `detail ${l.status}` },
    h(
      "div",
      { class: "detail-why" },
      decision,
      l.status === "flagged" ? null : [h("h4", {}, "Why"), h("p", { class: "reason" }, l.reason)],
      l.evidence ? [h("h4", {}, "What the log shows"), h("p", {}, l.evidence)] : null,
      clauses.length ? [h("h4", {}, `${meta.name} terms applied`), h("ol", { class: "terms-list" }, clauses.map((t) => h("li", {}, t)))] : null,
    ),
    h("div", { class: "detail-src" }, h("h4", {}, `Source row${l.sources.length === 1 ? "" : "s"}`), l.sources.map(sourceBlock)),
  );
  fitRow(p, el);
  return el;
}

// Full-width rows have no auto height: measure once drawn, then resize. (A
// getRowHeight callback would switch off auto height for the normal rows.)
function fitRow(p, el) {
  requestAnimationFrame(() => {
    const height = el.offsetHeight + 2;
    if (height > 2 && Math.abs(height - (p.node.rowHeight || 0)) > 3) {
      p.node.setRowHeight(height);
      p.api.onRowHeightChanged();
    }
  });
}

function gridRows() {
  if (!S.ledger) return [];
  const ids = [...S.ledger.clients.map((c) => c.id), ...(S.ledger.lines.some((l) => l.client_id === "unassigned") ? ["unassigned"] : [])];
  return ids.flatMap((id) => [
    { kind: "group", key: `group|${id}`, client_id: id, v: S.ledger.built_at },
    ...S.ledger.lines
      .filter((l) => l.client_id === id)
      .flatMap((l) => (view.open.has(l.key) ? [l, { kind: "detail", key: `detail|${l.key}`, client_id: id, line_key: l.key, v: `${l.status}|${l.resolution?.at || ""}` }] : [l])),
  ]);
}

function refreshGrid() {
  grid.setGridOption("rowData", gridRows());
  grid.redrawRows({ rowNodes: ["group", "detail"].flatMap((k) => [...view.open, ...S.clients.map((c) => c.id), "unassigned"].map((id) => grid.getRowNode(`${k}|${id}`)).filter(Boolean)) });
  grid.onFilterChanged();
}

// Totals for exactly what the filters leave on screen.
let lastTotals = "";
function updateTotals(api) {
  let lines = 0;
  let billed = 0;
  let flagged = 0;
  let stake = 0;
  api.forEachNodeAfterFilter((node) => {
    const l = node.data;
    if (!isLine(l)) return;
    lines += 1;
    if (l.status === "flagged") {
      flagged += 1;
      stake += l.proposed_amount;
    } else billed += l.amount;
  });
  const row = lines
    ? [{ kind: "total", key: "total", item: `${lines} line${lines === 1 ? "" : "s"}${flagged ? ` · ${flagged} need you, ${money(stake)} at stake` : ", every one decided"}`, amount: billed, reason: "", sources: [] }]
    : [];
  const sig = JSON.stringify(row);
  if (sig !== lastTotals) {
    lastTotals = sig;
    api.setGridOption("pinnedBottomRowData", row);
  }
}

function toggleGroup(id) {
  if (view.collapsed.has(id)) view.collapsed.delete(id);
  else view.collapsed.add(id);
  grid.redrawRows({ rowNodes: [grid.getRowNode(`group|${id}`)].filter(Boolean) });
  grid.onFilterChanged();
}

function toggleLine(key) {
  if (view.open.has(key)) view.open.delete(key);
  else view.open.add(key);
  view.cursor = key;
  refreshGrid();
}

// The decision workflow: N jumps to the next line that needs the owner,
// opens its source rows, and B / D decide it. Deciding moves on to the next.
function displayedLines() {
  const out = [];
  grid.forEachNodeAfterFilterAndSort((n) => isLine(n.data) && out.push(n.data));
  return out;
}

function nextFlag() {
  if (!S.ledger) return;
  const flagged = S.ledger.lines.filter((l) => l.status === "flagged" && !S.invoices[l.client_id] && l.client_id !== "unassigned");
  if (!flagged.length) return toast("Nothing needs you. Every line is decided.");
  for (const l of flagged) view.collapsed.delete(l.client_id);
  if (!flagged.some(lineVisible)) Object.assign(view, { client: "all", search: "" });
  $("#search").value = view.search;
  renderFilters();
  grid.onFilterChanged();
  const order = displayedLines().filter((l) => l.status === "flagged" && flagged.includes(l));
  const at = order.findIndex((l) => l.key === view.cursor);
  const next = order[(at + 1) % order.length] || order[0];
  view.open = new Set([next.key]);
  view.cursor = next.key;
  refreshGrid();
  const node = grid.getRowNode(next.key);
  grid.ensureNodeVisible(node, "top");
  grid.flashCells({ rowNodes: [node] });
}

async function decide(key, decision, btn) {
  btn?.classList.add("busy");
  try {
    await api("/api/lines/resolve", { key, decision, note: decision === "reopen" ? "" : view.notes[key] || "" });
    delete view.notes[key];
    await refresh();
    const left = S.ledger.lines.filter((l) => l.status === "flagged" && !S.invoices[l.client_id] && l.client_id !== "unassigned").length;
    if (decision === "reopen") return toast("Reopened: the line needs your decision again.");
    toast(`${decision === "bill" ? "Line will be billed." : "Line credited; the rest re-priced."}${left ? ` ${left} left: next one open.` : " Every line is decided."}`);
    if (left) nextFlag();
    else view.open.delete(key), refreshGrid();
  } catch (e) {
    toast(e.message, "error");
    btn?.classList.remove("busy");
  }
}

function exportCsv() {
  grid.exportDataAsCsv({
    fileName: `paytally-ledger-${S.agency.period.label.replace(/\s+/g, "-").toLowerCase()}.csv`,
    skipPinnedBottom: true,
    allColumns: true,
    shouldRowBeSkipped: (p) => !isLine(p.node.data),
    processCellCallback: (p) => {
      const l = p.node.data;
      switch (p.column.getColId()) {
        case "status": return STATUS[l.status];
        case "amount": return (l.status === "flagged" ? l.proposed_amount : l.amount).toFixed(2);
        case "sources": return l.sources.map((ref) => `${ref} (${sourceLabel(ref)})`).join("; ");
        default: return p.value;
      }
    },
  });
}

function initGrid() {
  const theme = agGrid.themeQuartz.withParams({
    accentColor: "#1f6f5c",
    fontFamily: "inherit",
    fontSize: 13,
    headerFontSize: 12,
    headerFontWeight: 650,
    headerBackgroundColor: "#f3f1ea",
    headerTextColor: "#4b5563",
    foregroundColor: "#14213d",
    borderColor: "#e5e1d6",
    rowBorder: { color: "#efece3" },
    rowHoverColor: "#f7f5ef",
    selectedRowBackgroundColor: "#eef6f2",
    wrapperBorderRadius: 12,
    spacing: 6,
  });
  const rank = (id) => {
    const i = S.ledger.clients.findIndex((c) => c.id === id);
    return i < 0 ? 99 : i;
  };
  grid = agGrid.createGrid($("#grid"), {
    theme,
    rowData: [],
    getRowId: (p) => p.data.key,
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    columnDefs: [
      { headerName: "Status", field: "status", width: 172, cellRenderer: statusCell },
      { headerName: "Client", field: "client_name", width: 170, wrapText: true, autoHeight: true, hide: true },
      { headerName: "Date", field: "date", width: 84, valueFormatter: (p) => shortDate(p.value) },
      { headerName: "Line", field: "item", flex: 1.1, minWidth: 190, wrapText: true, autoHeight: true },
      {
        headerName: "Amount",
        field: "amount",
        width: 140,
        type: "rightAligned",
        cellRenderer: amountCell,
        comparator: (a, b, na, nb) => (na.data.proposed_amount ?? 0) - (nb.data.proposed_amount ?? 0),
      },
      { headerName: "Reason", field: "reason", flex: 2.3, minWidth: 300, wrapText: true, autoHeight: true, cellClass: "cell-reason" },
      { headerName: "Source", field: "sources", width: 200, wrapText: true, autoHeight: true, cellRenderer: sourceCell, cellDataType: false, sortable: false },
    ],
    isFullWidthRow: ({ rowNode }) => ["group", "detail"].includes(rowNode.data?.kind),
    fullWidthCellRenderer: (p) => (p.data.kind === "group" ? groupRow(p) : detailRow(p)),
    // Sorting reorders lines within each client; groups keep their order and
    // each drill-down stays under its line.
    postSortRows: ({ nodes }) => {
      if (!S?.ledger) return;
      const groups = nodes.filter((n) => n.data.kind === "group").sort((a, b) => rank(a.data.client_id) - rank(b.data.client_id));
      const details = new Map(nodes.filter((n) => n.data.kind === "detail").map((n) => [n.data.line_key, n]));
      const lines = nodes.filter((n) => isLine(n.data));
      const out = groups.flatMap((g) => lines.filter((n) => n.data.client_id === g.data.client_id).flatMap((n) => (details.has(n.data.key) ? [n, details.get(n.data.key)] : [n])).reduce((acc, n) => [...acc, n], [g]));
      nodes.splice(0, nodes.length, ...out);
    },
    rowClassRules: {
      "row-flagged": (p) => p.data?.status === "flagged" && !p.node.rowPinned,
      "row-free": (p) => p.data?.status === "no_charge",
      "row-open": (p) => isLine(p.data) && view.open.has(p.data.key),
      "row-total": (p) => Boolean(p.node.rowPinned),
    },
    isExternalFilterPresent: () => true,
    doesExternalFilterPass: (node) => {
      const d = node.data;
      if (d.kind === "group") return S.ledger.lines.some((l) => l.client_id === d.client_id && lineVisible(l));
      const l = d.kind === "detail" ? lineFor(d.line_key) : d;
      return Boolean(l) && lineVisible(l) && !view.collapsed.has(l.client_id);
    },
    onRowClicked: (e) => isLine(e.data) && !e.node.rowPinned && toggleLine(e.data.key),
    onModelUpdated: (e) => updateTotals(e.api),
    overlayNoRowsTemplate: '<span class="muted">No lines yet. Read the work log to build the ledger.</span>',
  });
}

// ---------- Render ----------
function render() {
  $("#agency-name").textContent = S.agency.name;
  $("#period").textContent = S.agency.period.label;

  const ext = S.ledger?.extractor;
  const kind = ext?.kind || (S.modes.recorded ? "recorded" : "answer_key");
  const agent = $("#badge-agent");
  agent.textContent = { live: "Agent: Claude Opus 5.5 · live", recorded: "Agent: Claude Opus 5.5 · recorded run", answer_key: "Agent: offline answer key" }[kind];
  agent.className = `badge ${kind === "answer_key" ? "offline" : "live"}`;
  agent.title = {
    live: "This ledger comes from a Claude call made just now.",
    recorded: "This ledger comes from a real Claude run saved with the demo, so it works without live API credit.",
    answer_key: "No recorded Claude run matches this work log, so the ledger comes from the hand-checked answer key.",
  }[kind];
  const pp = $("#badge-paypal");
  pp.textContent = S.modes.paypal === "sandbox" ? "PayPal: sandbox" : "PayPal: mock";
  pp.className = `badge ${S.modes.paypal === "sandbox" ? "live" : "offline"}`;
  pp.title = {
    ready: "Invoices go through the PayPal Agent Toolkit to the PayPal sandbox; PayPal's webhooks reach this server.",
    registering: "Invoices go to the PayPal sandbox; the webhook is being registered.",
    none: "Invoices go to the PayPal sandbox. No public URL, so no webhooks: use Check PayPal on the Collections tab.",
    mock: "PayPal is mocked: nothing real is sent.",
  }[S.modes.webhook];

  renderIntro(ext);
  renderCards();
  renderFilters();
  refreshGrid();

  const open = S.ledger ? S.ledger.lines.filter((l) => l.status === "flagged").length : 0;
  $('.tab[data-tab="ledger"]').replaceChildren("Ledger", open ? h("span", { class: "count" }, open) : "");
  $("#ignored-note").textContent = S.ledger
    ? `${S.ledger.ignored.length} rows and emails left out on purpose, each with a reason. See them in Work log.`
    : "";

  const overdue = S.collections.filter((r) => r.days_overdue > 0).length;
  $('.tab[data-tab="collections"]').replaceChildren("Collections", overdue ? h("span", { class: "count" }, overdue) : "");
  const openThreads = S.threads.filter((t) => t.status === "open").length;
  $('.tab[data-tab="replies"]').replaceChildren("Client replies", openThreads ? h("span", { class: "count" }, openThreads) : "");

  renderWorklog();
  renderCollections();
  renderReplies();
  renderSettlement();
  renderActivity();
}

function renderIntro(ext) {
  $("#intro").classList.toggle("compact", Boolean(S.ledger));
  if (view.building) return;
  const btn = $("#build");
  const live = $("#build-live");
  const note = $("#build-note");
  btn.disabled = live.disabled = false;
  live.hidden = !S.modes.live;
  live.textContent = ext?.kind === "live" ? "Run live again" : "Run live with Claude";
  if (!S.ledger) {
    btn.textContent = "Read the work log";
    btn.className = "btn primary";
    live.className = "btn";
    note.textContent = S.modes.recorded
      ? `Shows a recorded Claude run instantly${S.modes.live ? "; or run Claude live, about a minute." : "."}`
      : "Uses the hand-checked answer key.";
    return;
  }
  btn.textContent = ext?.kind === "live" ? "Back to recorded run" : "Read it again";
  btn.className = live.className = "btn";
  const score = ext?.score ? ` · ${ext.score.matching} of ${ext.score.of} items match the hand-checked answer key` : "";
  note.textContent = {
    live: `Live Claude run, ${ext.seconds}s, ${stamp(ext.at)}${score}`,
    recorded: `Recorded Claude run (${ext.model}, ${shortDate(ext.at?.slice(0, 10))})${score}`,
    answer_key: `Built from the hand-checked answer key · ${stamp(S.ledger.built_at)}`,
  }[ext?.kind] || "";
}

// ---------- After sending: invoice status, test payment, client replies ----------
const PAID = ["PAID", "MARKED_AS_PAID", "PARTIALLY_REFUNDED", "REFUNDED"];
const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID"];
const isPaid = (r) => PAID.includes(r.status);
const isOpen = (r) => OPEN.includes(r.status);
const recordFor = (pid) => S.collections.find((r) => r.paypal_id === pid);
const invoiceLink = (r) => (r.href ? h("a", { href: r.href, target: "_blank", rel: "noopener", title: "The client's view of this invoice in PayPal" }, r.number) : r.number);

function invoiceStatus(r) {
  const parts = [h("div", {}, `PayPal (${r.mode}) invoice `, invoiceLink(r), r.replaces ? " (corrected)" : "", ` · sent ${shortDate(r.invoice_date)} · due ${shortDate(r.due_date)}`)];
  if (r.awaiting) parts.push(h("div", { class: "waiting" }, `Waiting for PayPal's ${r.awaiting.what === "payment" ? "paid" : "refund"} webhook`));
  else if (isPaid(r)) {
    parts.push(h("div", { class: "paid" }, `Paid ${r.paid_at ? stamp(r.paid_at) : ""} · ${r.paid_via}`));
    if (r.refunded) parts.push(h("div", {}, `${money(r.refunded)} refunded as a credit`));
  } else if (r.days_overdue) parts.push(h("div", { class: "late" }, `${r.days_overdue} days overdue`));
  else parts.push(h("div", {}, `Awaiting payment · approved by ${r.approved_by}, ${stamp(r.approved_at)}`));
  return h("div", { class: "state sent" }, parts);
}

async function act(btn, fn) {
  btn.classList.add("busy");
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    await refresh();
  }
}

function testPay(r, btn) {
  return act(btn, async () => {
    await api(`/api/invoices/${r.paypal_id}/test-pay`, {});
    toast(`PayPal recorded the test payment on invoice ${r.number}. Waiting for PayPal's webhook.`);
    startPolling();
  });
}

function arrive(replyId, btn) {
  return act(btn, async () => {
    await api(`/api/replies/${replyId}/arrive`, {});
    switchTab("replies");
    toast("A client replied. Claude checked it against the work log.");
  });
}

function sentActions(c, r) {
  const reply = S.replies.find((x) => x.client_id === c.id);
  const thread = reply && S.threads.find((t) => t.id === reply.id);
  const buttons = [];
  if (isOpen(r) && !r.awaiting) {
    buttons.push(h("button", { class: "btn", type: "button", title: "Demo: records a test payment in the PayPal sandbox. PayPal's webhook then marks the invoice paid.", onclick: (e) => testPay(r, e.currentTarget) }, "Client pays (test)"));
  }
  if (reply && !thread && !r.awaiting && (reply.arrives === "paid" ? isPaid(r) : isOpen(r))) {
    buttons.push(h("button", { class: "btn", type: "button", title: `Demo: ${reply.from.replace(/ <.*/, "")} replies to this invoice and questions a line.`, onclick: (e) => arrive(reply.id, e.currentTarget) }, "Client replies"));
  }
  if (thread) {
    buttons.push(h("button", { class: `btn${thread.status === "open" ? " warn" : ""}`, type: "button", onclick: () => switchTab("replies") }, thread.status === "open" ? "Answer the reply" : "See the reply"));
  }
  const agent = S.client_agents.find((a) => a.client_id === c.id);
  if (agent) {
    const waiting = agentThreads(agent).some((t) => t.status === "open") || pendingPayment(agent);
    buttons.unshift(h("button", { class: `btn${waiting ? " warn" : ""}`, type: "button", title: `${agent.name} checks and pays this invoice over PayTally's MCP server.`, onclick: () => switchTab("agent") }, waiting ? "Agent needs you" : "Its AI agent"));
  }
  if (!buttons.length) buttons.push(h("button", { class: "btn", type: "button", disabled: true }, isPaid(r) ? "Paid" : "Invoice sent"));
  return h("div", { class: "card-actions" }, buttons);
}

function renderCards() {
  const wrap = $("#cards");
  if (!S.ledger) return wrap.replaceChildren();
  wrap.replaceChildren(
    ...S.ledger.clients.map((c) => {
      const inv = S.invoices[c.id];
      const rec = inv && recordFor(inv.paypal_id);
      const state = inv ? (isPaid(rec) ? "paid" : "sent") : c.open_flags ? "needs" : "ready";
      let status;
      if (inv) {
        status = invoiceStatus(rec);
      } else if (c.open_flags) {
        status = h(
          "div",
          { class: "state flags", role: "button", tabindex: "0", onclick: () => focusFlags(c.id) },
          `${c.open_flags} line${c.open_flags > 1 ? "s" : ""} need${c.open_flags > 1 ? "" : "s"} your decision · ${money(c.pending_amount)} at stake`,
        );
      } else {
        status = h("div", { class: "state ok" }, "Every line checked against the terms.");
      }
      const blocked = c.open_flags > 0 || c.total <= 0;
      return h(
        "article",
        { class: `card ${state}` },
        h("div", {}, h("h3", {}, c.name), h("p", { class: "terms" }, c.summary)),
        h("div", { class: "figure" }, h("span", { class: "big" }, money(inv ? inv.total : c.total)), h("span", { class: "sub" }, `${inv ? inv.lines : c.billable_lines} lines ${inv ? "billed" : "to bill"}`)),
        status,
        inv
          ? sentActions(c, rec)
          : h(
              "button",
              { class: "btn primary", type: "button", disabled: blocked, onclick: () => openApprove(c.id) },
              c.open_flags ? "Approve after deciding flags" : `Approve & send ${money(c.total)}`,
            ),
      );
    }),
  );
}

function renderFilters() {
  const seg = $("#client-filter");
  const opts = [["all", "All clients"], ...S.clients.map((c) => [c.id, c.name])];
  if (S.ledger?.unassigned_flags) opts.push(["unassigned", "Not assigned"]);
  seg.replaceChildren(
    ...opts.map(([id, label]) =>
      h("button", { type: "button", class: view.client === id ? "on" : "", onclick: () => { view.client = id; renderFilters(); grid.onFilterChanged(); } }, label),
    ),
  );
  $("#flags-only").checked = view.flagsOnly;
  const open = S.ledger ? S.ledger.lines.filter((l) => l.status === "flagged" && !S.invoices[l.client_id] && l.client_id !== "unassigned").length : 0;
  const next = $("#next-flag");
  next.hidden = !open;
  next.replaceChildren(`Next decision (${open}) `, h("kbd", {}, "N"));
}

// From a client's card: open that client's first line that needs the owner.
function focusFlags(clientId) {
  switchTab("ledger");
  view.client = clientId;
  view.cursor = null;
  renderFilters();
  nextFlag();
  $("#grid").scrollIntoView({ behavior: "smooth", block: "start" });
}

function sourceBlock(ref) {
  const src = S.sources[ref];
  if (!src) return h("div", { class: "src" }, h("div", { class: "src-label" }, sourceLabel(ref)), h("pre", {}, ref === "terms" ? "From the client agreement." : "Not found in the work log."));
  const body = [];
  if (src.fields && src.kind !== "email") {
    const rows = Object.entries(src.fields).filter(([, v]) => v);
    body.push(h("table", {}, rows.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, v)))));
  }
  body.push(h("pre", {}, src.raw));
  return h("div", { class: "src" }, h("div", { class: "src-label" }, src.label), ...body);
}

// ---------- Approve ----------
function openApprove(clientId) {
  const c = S.ledger.clients.find((x) => x.id === clientId);
  const lines = S.ledger.lines.filter((l) => l.client_id === clientId && l.status === "bill" && l.amount > 0);
  const form = $("#approve-form");
  const confirm = h("button", { class: "btn primary", type: "button" }, `Approve & send ${money(c.total)}`);
  confirm.addEventListener("click", async () => {
    confirm.classList.add("busy");
    confirm.disabled = true;
    try {
      const out = await api(`/api/clients/${clientId}/approve`, { expected_total: c.total });
      $("#approve-dialog").close();
      await refresh();
      toast(`Invoice ${out.invoice.paypal_id} sent to ${c.name}.`);
    } catch (e) {
      $("#approve-dialog").close();
      toast(e.message, "error");
      await refresh();
    }
  });
  form.replaceChildren(
    h("h2", {}, `Send ${c.name} its ${S.agency.period.label} invoice?`),
    h("p", { class: "muted" }, "PayPal will email ", h("strong", {}, c.billing_email), " an invoice for ", h("strong", {}, money(c.total)), `, due in ${S.agency.payment_due_days} days (${shortDate(addDays(S.today, S.agency.payment_due_days))}).`),
    h(
      "div",
      { class: "mini-wrap" },
      h(
        "table",
        { class: "mini" },
        lines.map((l) => h("tr", {}, h("td", {}, l.item), h("td", { class: "muted" }, shortDate(l.date)), h("td", { class: "n" }, money(l.amount)))),
        h("tr", { class: "total" }, h("td", {}, `${lines.length} lines`), h("td", {}), h("td", { class: "n" }, money(c.total))),
      ),
    ),
    h(
      "p",
      { class: "guard" },
      "Your approval is tied to exactly these lines and this total. If anything changes, it no longer matches and PayPal refuses the invoice.",
      S.modes.paypal === "mock" ? " PayPal is in mock mode: nothing real is sent." : "",
    ),
    h("div", { class: "actions" }, h("button", { class: "btn", value: "cancel" }, "Cancel"), confirm),
  );
  $("#approve-dialog").showModal();
}

// ---------- Collections ----------
function statusPill(r) {
  if (r.awaiting) return h("span", { class: "pill flagged" }, "Waiting for webhook");
  if (r.days_overdue) return h("span", { class: "pill late" }, `${r.days_overdue} days overdue`);
  if (r.status === "CANCELLED") return h("span", { class: "pill no_charge" }, r.replaced_by ? `Replaced by ${recordFor(r.replaced_by)?.number || "a corrected invoice"}` : "Cancelled");
  if (r.status === "PARTIALLY_REFUNDED" || r.status === "REFUNDED") return h("span", { class: "pill bill" }, `Paid · ${money(r.refunded)} refunded`);
  if (isPaid(r)) return h("span", { class: "pill bill" }, "Paid");
  return h("span", { class: "pill open" }, `Open · due ${shortDate(r.due_date)}`);
}

function renderCollections() {
  $("#collections-note").textContent = `Every invoice sent through PayPal (${S.modes.paypal}), with its PayPal status. Due dates follow the agency's terms: ${S.agency.payment_due_days} days after the invoice date. Paid and refunded arrive by PayPal's webhook.`;
  const wrap = $("#collections");
  if (!S.collections.length) return wrap.replaceChildren(h("p", { class: "muted" }, "Nothing sent yet. Read the work log, then approve an invoice."));
  const rows = [...S.collections].sort((a, b) => b.invoice_date.localeCompare(a.invoice_date) || String(b.number).localeCompare(String(a.number)));
  const actions = (r) => {
    const out = [];
    if (r.reminder) out.push(h("button", { class: "btn primary small", type: "button", onclick: () => openReminder(r) }, "Send reminder"));
    if (isOpen(r) && !r.awaiting) out.push(h("button", { class: "btn small", type: "button", onclick: (e) => testPay(r, e.currentTarget) }, "Client pays (test)"));
    if (r.reminders.length) out.push(h("span", { class: "muted small" }, `Reminded ${shortDate(r.reminders.at(-1).at.slice(0, 10))}`));
    return h("div", { class: "row-actions" }, out);
  };
  wrap.replaceChildren(
    h(
      "table",
      { class: "coll" },
      h("thead", {}, h("tr", {}, ["Invoice", "Client", "For", "Total", "Sent", "Due", "Status", ""].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            { class: r.days_overdue ? "overdue" : "" },
            h("td", { "data-label": "Invoice" }, invoiceLink(r), r.kind === "history" ? h("span", { class: "muted small" }, " · last month") : ""),
            h("td", { "data-label": "Client" }, r.client_name),
            h("td", { "data-label": "For" }, r.period),
            h("td", { "data-label": "Total", class: "n" }, money(r.total)),
            h("td", { "data-label": "Sent" }, shortDate(r.invoice_date)),
            h("td", { "data-label": "Due" }, shortDate(r.due_date)),
            h("td", { "data-label": "Status" }, statusPill(r)),
            h("td", {}, actions(r)),
          ),
        ),
      ),
    ),
  );
}

function openReminder(r) {
  const rem = r.reminder;
  const form = $("#approve-form");
  const send = h("button", { class: "btn primary", type: "button" }, "Send reminder");
  send.addEventListener("click", async () => {
    send.classList.add("busy");
    send.disabled = true;
    try {
      await api(`/api/invoices/${r.paypal_id}/remind`, { subject: rem.subject, note: rem.note });
      toast(`PayPal sent the reminder for invoice ${r.number}.`);
    } catch (e) {
      toast(e.message, "error");
    }
    $("#approve-dialog").close();
    await refresh();
  });
  form.replaceChildren(
    h("h2", {}, `Remind ${r.client_name}?`),
    h("p", { class: "muted" }, `Invoice ${r.number} (${money(r.total - r.paid)}) is ${r.days_overdue} days overdue. PayPal will email this to `, h("strong", {}, r.to), ", with the payment link:"),
    h("div", { class: "letter" }, h("p", { class: "subj" }, rem.subject), h("p", {}, rem.note)),
    h("p", { class: "guard" }, "Your approval is tied to exactly this text. Built from the invoice, so the dates and amount are exact."),
    h("div", { class: "actions" }, h("button", { class: "btn", value: "cancel" }, "Cancel"), send),
  );
  $("#approve-dialog").showModal();
}

// ---------- Client replies ----------
const FINDING = {
  log_supports_charge: "The log supports the charge",
  log_supports_client: "The log supports the client",
  log_cannot_settle: "The log can't settle it",
};

function termsBlock(clientId) {
  const c = clientMeta(clientId);
  return h("div", { class: "src" }, h("div", { class: "src-label" }, `${c.name} terms`), h("ol", { class: "terms-list pad" }, c.terms_text.map((t) => h("li", {}, t))));
}

function threadCard(t) {
  const d = t.draft;
  const head = h(
    "div",
    { class: "thread-head" },
    h("div", {}, h("p", { class: "eyebrow" }, `${t.client_name} · about invoice ${t.invoice_number} · ${stamp(t.arrived_at)}`), h("h3", {}, t.subject), h("p", { class: "muted small" }, `From ${t.from}`)),
  );
  const email = h("pre", { class: "email" }, t.body);
  if (t.answer) {
    const what = t.answer.decision === "credit"
      ? `You credited ${money(t.answer.credit)}: ${t.answer.how === "refund" ? "PayPal recorded the refund" : "PayPal cancelled the invoice and sent a corrected one"}. Your reply:`
      : "You kept the charge. Your reply:";
    return h("article", { class: "thread done" }, head, email, h("div", { class: "answer" }, h("p", { class: "eyebrow" }, `${what} (${stamp(t.answer.at)})`), h("pre", { class: "email" }, t.answer.text)));
  }
  const liveBtn = S.modes.live
    ? h("button", { class: "btn", type: "button", onclick: (e) => act(e.currentTarget, async () => {
        e.currentTarget.textContent = "Claude is checking the log";
        const out = await api(`/api/replies/${t.id}/draft`, { mode: "live" });
        delete view.replyText[t.id];
        toast(out.fallback ? out.notice : "Claude drafted a new reply.", out.fallback ? "error" : "");
      }) }, "Draft live with Claude")
    : null;
  if (!d) return h("article", { class: "thread" }, head, email, h("p", { class: "muted" }, "No draft yet."), liveBtn);

  const credit = t.credit;
  const choice = view.replyChoice[t.id] || (d.recommend_credit && credit?.how ? "credit" : "keep");
  const text = view.replyText[t.id] ?? (choice === "credit" ? d.reply_if_credit : d.reply_if_no_credit);
  const choose = (c) => {
    view.replyChoice[t.id] = c;
    delete view.replyText[t.id];
    renderReplies();
  };
  const box = h("textarea", { class: "reply-text", rows: "9" });
  box.value = text;
  box.addEventListener("input", () => (view.replyText[t.id] = box.value));
  const meta = t.draft_meta;
  const scoreNote = meta.score ? ` · ${meta.score.ok ? "matches" : "differs from"} the hand-checked answer` : "";
  const send = h("button", { class: "btn primary", type: "button" }, choice === "credit" ? `Credit ${money(credit?.amount)} & send reply` : "Send reply");
  send.addEventListener("click", () =>
    act(send, async () => {
      await api(`/api/replies/${t.id}/send`, { decision: choice, text: box.value, expected_credit: credit?.amount });
      delete view.replyText[t.id];
      delete view.replyChoice[t.id];
      toast(choice === "credit" ? "Credit sent through PayPal; reply recorded." : "Reply recorded; the charge stands.");
    }),
  );
  const consequence = choice === "credit"
    ? credit?.how === "refund"
      ? `PayPal records a ${money(credit.amount)} refund on invoice ${t.invoice_number}.`
      : credit?.how === "corrected_invoice"
        ? `PayPal cancels invoice ${t.invoice_number} and sends a corrected one for ${money(credit.new_total)}. The terms engine re-prices the client without this line.`
        : "This invoice can't take a credit in its current state."
    : "Nothing changes in PayPal.";
  return h(
    "article",
    { class: "thread" },
    head,
    email,
    h(
      "div",
      { class: "agent" },
      h("div", { class: "agent-head" }, h("span", { class: "who" }, `Claude · ${meta.kind === "live" ? `live, ${meta.seconds}s` : `recorded draft (${meta.model})`}${scoreNote}`), h("span", { class: `finding ${d.finding}` }, FINDING[d.finding])),
      h("p", { class: "summary" }, d.owner_summary),
      h("h4", {}, "Rows it checked"),
      d.cited_sources.map((ref) => (ref === "terms" ? termsBlock(t.client_id) : sourceBlock(ref))),
      h("h4", {}, "Your call"),
      h(
        "div",
        { class: "seg", role: "group" },
        h("button", { type: "button", class: choice === "credit" ? "on" : "", disabled: !credit?.how, onclick: () => choose("credit") }, `Credit ${money(credit?.amount)}${d.recommend_credit ? " · Claude's call" : ""}`),
        h("button", { type: "button", class: choice === "keep" ? "on" : "", onclick: () => choose("keep") }, `Keep the charge${d.recommend_credit ? "" : " · Claude's call"}`),
      ),
      box,
      h("p", { class: "guard" }, `${consequence} ${t.channel === "agent" ? "Your reply goes back to the client's agent over MCP." : "This demo sends no email: the reply is kept with the thread."}`),
      h("div", { class: "actions" }, liveBtn, send),
    ),
  );
}

function renderReplies() {
  const wrap = $("#threads");
  if (!S.threads.length) {
    const who = S.replies.map((r) => clientMeta(r.client_id).name).join(" and ");
    return wrap.replaceChildren(h("p", { class: "muted" }, `No client replies yet. In this demo, ${who} each question a line after their invoice is sent: approve one, then press Client replies on its card.`));
  }
  wrap.replaceChildren(...[...S.threads].sort((a, b) => b.arrived_at.localeCompare(a.arrived_at)).map(threadCard));
}

// While PayPal's webhook is on its way, check every 2 seconds for up to 90.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  const started = Date.now();
  pollTimer = setInterval(async () => {
    const waiting = () => S.collections.filter((r) => r.awaiting).map((r) => r.paypal_id);
    const before = waiting();
    await refresh();
    for (const pid of before) {
      const r = recordFor(pid);
      if (r && !r.awaiting) toast(`PayPal's webhook arrived: invoice ${r.number} is ${isPaid(r) ? "paid" : r.status.toLowerCase()}.`);
    }
    if (!waiting().length || Date.now() - started > 90000) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (waiting().length) toast("No webhook from PayPal yet. Use Check PayPal on the Collections tab.", "error");
    }
  }, 2000);
}

// ---------- Client's AI agent: the two-agent settlement ----------
const agentMeta = () => S.client_agents[0];
const agentThreads = (a) => S.threads.filter((t) => t.channel === "agent" && t.client_id === a.client_id);
const pendingPayment = (a) => S.payment_requests.find((p) => p.client_id === a.client_id && p.status === "awaiting_approval");
const settlementBusy = () => Boolean(S.settlement.running) || S.payment_requests.some((p) => ["sending", "sent_to_paypal"].includes(p.status));

const WHO = {
  client_agent: (a) => ({ side: "left", label: a.name, cls: "client" }),
  client_human: (a) => ({ side: "left", label: `${a.human} · ${a.client_name}`, cls: "human" }),
  paytally: () => ({ side: "right", label: "PayTally", cls: "paytally" }),
  owner: () => ({ side: "right", label: `${S.agency.owner} · agency owner`, cls: "human" }),
  paypal: () => ({ side: "mid", label: "PayPal", cls: "paypal" }),
  system: () => ({ side: "mid", label: "", cls: "system" }),
};

// Short arguments inline; long ones (a dispute's reason and evidence) open below.
const callArgs = (input) => Object.values(input || {}).filter((v) => typeof v !== "object" && String(v).length <= 60).join(", ");
const dollars = (n) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : money(n));

// The agent writes light Markdown: **bold** and "- " bullets. Built as nodes, never as HTML.
function richText(text) {
  const inline = (line) => line.split(/(\*\*[^*]+\*\*)/).map((part) => (part.startsWith("**") && part.endsWith("**") ? h("strong", {}, part.slice(2, -2)) : part));
  const out = [];
  let list = null;
  for (const line of String(text).split("\n")) {
    const bullet = line.match(/^\s*[-*] (.*)$/);
    if (bullet) {
      if (!list) out.push((list = h("ul", {})));
      list.append(h("li", {}, inline(bullet[1])));
      continue;
    }
    list = null;
    if (line.trim()) out.push(h("p", {}, inline(line.replace(/^#+\s*/, ""))));
  }
  return out;
}

function stepItem(step, a) {
  const who = (WHO[step.who] || WHO.system)(a);
  if (step.kind === "call") {
    const body = step.pending
      ? h("span", { class: "muted small" }, " · waiting for PayTally")
      : h(
          "details",
          { class: "call-result" },
          h("summary", {}, step.is_error ? `PayTally refused: ${step.result?.error || "error"}` : "What PayTally returned"),
          h("pre", {}, JSON.stringify(step.result, null, 2)),
        );
    const long = Object.values(step.input || {}).filter((v) => typeof v === "string" && v.length > 60);
    return h(
      "li",
      { class: `step call ${who.side}${step.is_error ? " err" : ""}` },
      h("div", { class: "call-line" }, h("span", { class: "tool" }, step.tool), h("span", { class: "args" }, `(${callArgs(step.input)})`), body),
      long.length ? h("details", { class: "call-input" }, h("summary", {}, "What the agent sent"), h("pre", {}, long.join("\n\n"))) : null,
    );
  }
  return h(
    "li",
    { class: `step say ${who.side} ${who.cls}` },
    who.label ? h("p", { class: "who" }, who.label) : null,
    h("div", { class: "text" }, step.who === "client_agent" ? richText(step.text) : step.text),
  );
}

function settleAction(label, mode, primary = false) {
  return h("button", {
    class: `btn${primary ? " primary" : ""}`,
    type: "button",
    onclick: (e) => act(e.currentTarget, async () => {
      const out = await api(`/api/settlement/${mode === "resume" ? "resume" : "start"}`, { mode });
      if (out.notice) toast(out.notice, "error");
      startSettlementPolling();
    }),
  }, label);
}

function paymentCard(a, p) {
  const saved = S.client_agents.find((x) => x.client_id === a.client_id).saved_method;
  const approve = h("button", { class: "btn primary", type: "button" }, `Approve ${money(p.amount)}`);
  approve.addEventListener("click", () => act(approve, async () => {
    await api(`/api/payments/${p.id}/approve`, { expected_amount: p.amount });
    toast(`PayPal charged the saved card: ${money(p.amount)}. Waiting for PayPal's webhook.`);
    startSettlementPolling();
  }));
  const decline = h("button", { class: "btn", type: "button", onclick: (e) => act(e.currentTarget, () => api(`/api/payments/${p.id}/decline`, {})) }, "Decline");
  return h(
    "div",
    { class: "paycard" },
    h("p", { class: "eyebrow" }, `${a.human} approves · ${a.client_name}`),
    h("p", { class: "pay-amount" }, money(p.amount)),
    h("p", {}, `to ${S.agency.name} · invoice ${p.invoice_number}`, saved ? ` · ${saved.brand} ending ${saved.last_digits}, saved in PayPal` : ""),
    h("p", { class: "guard" }, `${a.name} asked for this after its dispute was answered. It is within the ${dollars(p.cap)} cap ${a.human} set. This approval is tied to this exact amount; PayPal charges the saved card only after the tap.`),
    h("div", { class: "actions" }, decline, approve),
  );
}

function renderSettlement() {
  const a = agentMeta();
  if (!a) return;
  const s = S.settlement;
  const inv = S.invoices[a.client_id];
  const rec = inv && recordFor(inv.paypal_id);
  const disputes = agentThreads(a);
  const openDisputes = disputes.filter((t) => t.status === "open");
  const pay = pendingPayment(a);
  const paid = S.payment_requests.find((p) => p.client_id === a.client_id && p.status === "paid");
  const done = s.phases_done || [];

  // What the owner does next, in one place.
  let next = null;
  const flags = S.ledger?.lines.filter((l) => l.client_id === a.client_id && l.status === "flagged") || [];
  if (!S.ledger) next = h("p", { class: "muted" }, "Read the work log first (top of the page).");
  else if (!inv) {
    next = h(
      "div",
      { class: "next" },
      h("p", {}, flags.length
        ? `First decide ${a.client_name}'s flagged line${flags.length > 1 ? "s" : ""}, then approve and send its invoice. (The recorded run starts with Robert Okafor not billed: ${a.human} showed he was their customer first.)`
        : `Approve and send ${a.client_name}'s invoice; then its agent can check it.`),
      flags.length
        ? h("button", { class: "btn primary", type: "button", onclick: () => focusFlags(a.client_id) }, "Show the flagged line")
        : h("button", { class: "btn primary", type: "button", onclick: () => openApprove(a.client_id) }, "Approve & send"),
    );
  } else if (s.running) {
    next = h("p", { class: "working" }, s.running === "audit" ? `${a.name} is checking invoice ${rec?.number} against its records…` : `${a.name} is picking the invoice back up…`);
  } else if (!done.includes("audit")) {
    const recordedFits = s.recorded && s.assumes && Math.round((rec.total - rec.paid) * 100) / 100 === s.assumes.invoice_total;
    next = h(
      "div",
      { class: "next" },
      h("p", {}, `Invoice ${rec.number} (${money(rec.total)}) is with ${a.client_name}. Their agent checks it now, over MCP.`),
      h("div", { class: "btn-row" },
        S.modes.live ? settleAction("Run live with Claude", "live", !recordedFits) : null,
        recordedFits ? settleAction(`${a.name} checks the invoice`, "recorded", true) : null,
      ),
      !recordedFits && !S.modes.live ? h("p", { class: "muted small" }, `The recorded run starts from a ${money(s.assumes?.invoice_total || 0)} invoice. Reset the demo and choose "Don't bill" for Robert Okafor.`) : null,
    );
  } else if (openDisputes.length) {
    next = h("div", { class: "checkpoint" }, h("p", { class: "eyebrow" }, `Your call, ${S.agency.owner.split(" ")[0]}: the client's agent disputed a line`), ...openDisputes.map(threadCard));
  } else if (!done.includes("settle")) {
    next = h("div", { class: "next" }, h("p", {}, "Your answer went back to the agent over MCP."), settleAction(`${a.name} picks it back up`, "resume", true));
  } else if (pay) {
    next = paymentCard(a, pay);
  } else if (paid) {
    const credited = disputes.filter((t) => t.answer?.decision === "credit");
    next = h(
      "div",
      { class: "settled" },
      h("p", { class: "eyebrow" }, "Settled"),
      h("p", { class: "big" }, `${money(paid.amount)} paid through PayPal`),
      h("p", {}, `${disputes.length} dispute${disputes.length === 1 ? "" : "s"}, ${credited.length ? `${money(credited.reduce((n, t) => n + (t.answer.credit || 0), 0))} credited` : "no credit"}; capture ${paid.paypal?.capture_id || ""}. Two agents did the checking; two people approved the money.`),
    );
  } else if (S.payment_requests.some((p) => p.client_id === a.client_id && ["sending", "sent_to_paypal"].includes(p.status))) {
    next = h("p", { class: "working" }, "PayPal is taking the payment; waiting for its webhook…");
  }

  $("#settle-head").replaceChildren(...[
    h("h2", {}, `${a.client_name}'s own AI agent settles its invoice`),
    h("p", { class: "lede" }, `${a.client_name} runs its own agent (Claude), with its own instructions, its own field log and a ${dollars(a.cap)} cap. Over PayTally's MCP server it reads the invoice, asks for the proof behind any line, disputes what its records contradict, and asks to pay through PayPal. It can't change a price or move money: a credit waits for ${S.agency.owner}, a payment for ${a.human}.`),
    s.notice ? h("p", { class: "guard" }, s.notice) : null,
    s.steps.length ? h("p", { class: "muted small" }, s.mode === "live" ? `Live Claude run${s.model ? ` (${s.model})` : ""}.` : `Recorded Claude run (${s.recorded_model || s.model}): the agent's words and choices are replayed; every tool call, the owner's answer and the PayPal payment happen for real.`) : null,
  ].filter(Boolean));
  $("#settle-steps").replaceChildren(...s.steps.map((x) => stepItem(x, a)));
  $("#settle-checkpoint").replaceChildren(next || "");

  const url = `${location.origin}${S.mcp.path}`;
  const cmd = `claude mcp add --transport http paytally ${url} --header "Authorization: Bearer ${a.token}"`;
  const saved = a.saved_method;
  $("#settle-side").replaceChildren(...[
    h(
      "div",
      { class: "side-card" },
      h("p", { class: "eyebrow" }, `${a.client_name}'s side`),
      h("h3", {}, a.name),
      h("p", { class: "muted small" }, `Answers to ${a.human}, ${a.human_role}. Cap: ${dollars(a.cap)} per invoice.`),
      h("ol", { class: "terms-list" }, a.instructions.map((t) => h("li", {}, t))),
      saved ? h("p", { class: "saved" }, `${saved.brand} ending ${saved.last_digits} saved in PayPal Vault (${saved.mode}, PayPal test card)`) : null,
      h("details", { class: "records" }, h("summary", {}, `${a.records_label}. PayTally never sees it.`), h("ul", {}, a.records.map((r) => h("li", {}, r)))),
    ),
    h(
      "div",
      { class: "side-card" },
      h("p", { class: "eyebrow" }, "Connect your own agent"),
      h("p", { class: "small" }, "Any MCP client can do what this agent does. In Claude Code:"),
      h("pre", { class: "cmd" }, cmd),
      h("button", { class: "btn small", type: "button", onclick: () => navigator.clipboard.writeText(cmd).then(() => toast("Copied.")) }, "Copy"),
      h("ul", { class: "tools" }, S.mcp.tools.map((t) => h("li", {}, h("code", {}, t.name), ` ${t.title}`))),
    ),
    S.mcp.log.length
      ? h(
          "div",
          { class: "side-card" },
          h("p", { class: "eyebrow" }, "MCP calls PayTally received"),
          h("ol", { class: "mcp-log" }, S.mcp.log.slice(0, 14).map((m) => h("li", { class: m.ok ? "" : "err" }, h("span", { class: "when" }, stamp(m.at)), h("code", {}, m.tool), m.ok ? "" : h("span", { class: "small" }, ` refused: ${m.error}`)))),
        )
      : null,
  ].filter(Boolean));
  const waiting = openDisputes.length + (pay ? 1 : 0);
  $('.tab[data-tab="agent"]').replaceChildren("Client's AI agent", waiting ? h("span", { class: "count" }, waiting) : "");
}

// While the client's agent works or PayPal's webhook is on its way.
let settleTimer = null;
function startSettlementPolling() {
  if (settleTimer) return;
  const started = Date.now();
  settleTimer = setInterval(async () => {
    await refresh();
    if (!settlementBusy() || Date.now() - started > 300000) {
      clearInterval(settleTimer);
      settleTimer = null;
    }
  }, 1200);
}

// ---------- Work log and activity ----------
function renderWorklog() {
  const wrap = $("#worklog");
  if (!S.ledger) return wrap.replaceChildren(h("p", { class: "muted" }, "Read the work log first."));
  const uses = {};
  for (const l of S.ledger.lines) for (const ref of l.sources) (uses[ref] ||= []).push(l);
  const ignored = Object.fromEntries(S.ledger.ignored.map((i) => [i.source, i.why]));
  const useCell = (ref) => {
    const ls = uses[ref];
    if (ls?.length) {
      return ls.map((l) =>
        h("div", { class: `use ${l.status === "bill" ? "billed" : l.status === "flagged" ? "flagged" : "free"}` },
          `${l.item}: ${l.status === "flagged" ? "needs you" : money(l.amount)}`),
      );
    }
    if (ignored[ref]) return h("div", { class: "use ignored" }, `Left out: ${ignored[ref]}`);
    return h("div", { class: "use flagged" }, "Not accounted for");
  };
  const row = (ref) => h("div", { class: "wl-row" }, h("span", { class: "ref" }, ref), h("span", { class: "raw" }, S.sources[ref].raw), h("div", {}, useCell(ref)));
  const header = (text) => h("div", { class: "wl-row header" }, h("span", { class: "ref" }, "header"), h("span", { class: "raw" }, text), h("span"));
  wrap.replaceChildren(
    h("div", { class: "wl-section" }, h("h3", {}, "Calendar export (calendar_export.csv)"), header(S.raw.calendar[0]), S.raw.calendar.slice(1).map(row)),
    h("div", { class: "wl-section" }, h("h3", {}, "CRM export, Cobalt Dental (crm_leads.csv)"), header(S.raw.crm[0]), S.raw.crm.slice(1).map(row)),
    h("div", { class: "wl-section" }, h("h3", {}, "Client emails (client_emails.txt)"), S.raw.emails.map(row)),
  );
}

function renderActivity() {
  const ol = $("#activity");
  if (!S.activity.length) return ol.replaceChildren(h("li", {}, h("span", { class: "muted" }, "Nothing yet.")));
  ol.replaceChildren(...S.activity.map((a) => h("li", {}, h("span", { class: "when" }, stamp(a.at)), h("span", { class: `kind ${a.kind}` }, a.kind), h("span", {}, a.text))));
}

function switchTab(tab) {
  view.tab = tab;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".tabpanel")) p.hidden = p.id !== `tab-${tab}`;
}

// ---------- Wiring ----------
async function refresh() {
  S = await api("/api/state");
  render();
}

async function build(mode) {
  const btn = mode === "live" ? $("#build-live") : $("#build");
  view.building = true;
  $("#build").disabled = $("#build-live").disabled = true;
  btn.classList.add("busy");
  btn.textContent = mode === "live" ? "Claude is reading the log" : "Reading the log";
  try {
    const out = await api("/api/build", { mode });
    view.building = false;
    await refresh();
    const flags = S.ledger.lines.filter((l) => l.status === "flagged").length;
    if (out.fallback) toast(out.notice, "error");
    else toast(`Ledger ready: ${S.ledger.lines.length} lines, ${flags} need your decision.`);
  } catch (e) {
    view.building = false;
    toast(e.message, "error");
    await refresh();
  } finally {
    btn.classList.remove("busy");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initGrid();
  $("#build").addEventListener("click", () => build("recorded"));
  $("#build-live").addEventListener("click", () => build("live"));
  $("#flags-only").addEventListener("change", (e) => { view.flagsOnly = e.target.checked; grid.onFilterChanged(); });
  $("#search").addEventListener("input", (e) => { view.search = e.target.value; grid.onFilterChanged(); });
  $("#next-flag").addEventListener("click", nextFlag);
  $("#export-csv").addEventListener("click", exportCsv);
  // Keys for the decision workflow, on the Ledger tab and outside text fields.
  document.addEventListener("keydown", (e) => {
    if (view.tab !== "ledger" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select, dialog")) return;
    const key = e.key.toLowerCase();
    const l = view.cursor && view.open.has(view.cursor) && lineFor(view.cursor);
    if (key === "n") nextFlag();
    else if (key === "escape" && view.open.size) { view.open.clear(); refreshGrid(); }
    else if (l?.status === "flagged" && !S.invoices[l.client_id] && (key === "b" || key === "d")) decide(l.key, key === "b" ? "bill" : "no_charge");
    else return;
    e.preventDefault();
  });
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => switchTab(b.dataset.tab));
  $("#check-paypal").addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const out = await api("/api/collections/refresh", {});
      toast(`Checked ${out.checked} invoice${out.checked === 1 ? "" : "s"} in PayPal; ${out.changed} changed.`);
    }),
  );
  $("#reset").addEventListener("click", async () => {
    await api("/api/reset", {});
    Object.assign(view, { client: "all", flagsOnly: false, search: "", open: new Set(), collapsed: new Set(), notes: {}, cursor: null, replyChoice: {}, replyText: {} });
    $("#search").value = "";
    await refresh();
    toast("Demo reset.");
  });
  await refresh();
  if (S.collections.some((r) => r.awaiting)) startPolling();
  if (settlementBusy()) startSettlementPolling();
});
