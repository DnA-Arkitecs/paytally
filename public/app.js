/* global agGrid */
const $ = (sel, el = document) => el.querySelector(sel);
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => currency.format(n || 0);
const shortDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const stamp = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
const view = { client: "all", flagsOnly: false, openKey: null, tab: "ledger", building: false };

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

// ---------- Grid ----------
function statusCell(p) {
  const l = p.data;
  const label = { bill: "Bill", no_charge: "No charge", flagged: "Needs you" }[l.status];
  return h("span", { class: `pill ${l.status}` }, label, l.resolution ? h("span", { class: "you" }, " · your call") : null);
}

function amountCell(p) {
  const l = p.data;
  if (l.status === "flagged") return h("span", { class: "amt stake" }, `${money(l.proposed_amount)} at stake`);
  if (l.amount === 0) return h("span", { class: "amt zero" }, money(0));
  return h("span", { class: "amt" }, money(l.amount));
}

function sourceCell(p) {
  return h("div", { class: "chips" }, p.data.sources.map((ref) => h("span", { class: "chip", title: S.sources[ref]?.raw || "" }, sourceLabel(ref))));
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
  grid = agGrid.createGrid($("#grid"), {
    theme,
    rowData: [],
    getRowId: (p) => p.data.key,
    defaultColDef: { sortable: true, resizable: true, suppressMovable: true },
    columnDefs: [
      { headerName: "Status", field: "status", width: 150, cellRenderer: statusCell },
      { headerName: "Client", field: "client_name", width: 170, wrapText: true, autoHeight: true },
      { headerName: "Date", field: "date", width: 84, valueFormatter: (p) => shortDate(p.value) },
      { headerName: "Line", field: "item", flex: 1.1, minWidth: 190, wrapText: true, autoHeight: true },
      {
        headerName: "Amount",
        field: "amount",
        width: 140,
        type: "rightAligned",
        cellRenderer: amountCell,
        comparator: (a, b, na, nb) => na.data.proposed_amount - nb.data.proposed_amount,
      },
      { headerName: "Reason", field: "reason", flex: 2.3, minWidth: 300, wrapText: true, autoHeight: true, cellClass: "cell-reason" },
      {
        headerName: "Source",
        field: "sources",
        width: 200,
        wrapText: true,
        autoHeight: true,
        cellRenderer: sourceCell,
        cellDataType: false,
        getQuickFilterText: (p) => p.data.sources.map(sourceLabel).join(" "),
        sortable: false,
      },
    ],
    rowClassRules: {
      "row-flagged": (p) => p.data.status === "flagged",
      "row-free": (p) => p.data.status === "no_charge",
    },
    isExternalFilterPresent: () => view.client !== "all" || view.flagsOnly,
    doesExternalFilterPass: (node) =>
      (view.client === "all" || node.data.client_id === view.client) && (!view.flagsOnly || node.data.status === "flagged"),
    onRowClicked: (e) => openDrawer(e.data.key),
    overlayNoRowsTemplate: '<span class="muted">No lines yet. Read the work log to build the ledger.</span>',
  });
}

// ---------- Render ----------
function render() {
  $("#agency-name").textContent = S.agency.name;
  $("#period").textContent = S.agency.period.label;

  const ext = S.ledger?.extractor;
  const agent = $("#badge-agent");
  if (S.modes.extractor === "claude") {
    agent.textContent = "Agent: Claude Opus 5.5";
    agent.className = "badge live";
  } else {
    agent.textContent = "Agent: offline answer key";
    agent.className = "badge offline";
    agent.title = "No Anthropic key is set, so the ledger is built from the hand-checked answer key.";
  }
  const pp = $("#badge-paypal");
  pp.textContent = S.modes.paypal === "sandbox" ? "PayPal: sandbox" : "PayPal: mock";
  pp.className = `badge ${S.modes.paypal === "sandbox" ? "live" : "offline"}`;

  renderIntro(ext);
  renderCards();
  renderFilters();
  grid.setGridOption("rowData", S.ledger?.lines || []);
  grid.onFilterChanged();

  const open = S.ledger ? S.ledger.lines.filter((l) => l.status === "flagged").length : 0;
  $('.tab[data-tab="ledger"]').replaceChildren("Ledger", open ? h("span", { class: "count" }, open) : "");
  $("#ignored-note").textContent = S.ledger
    ? `${S.ledger.ignored.length} rows left out on purpose (internal meetings, a test event, a sync duplicate, rows outside ${S.agency.period.label}). See them in Work log.`
    : "";

  renderWorklog();
  renderActivity();
  if (view.openKey) renderDrawer();
}

function renderIntro(ext) {
  const intro = $("#intro");
  const btn = $("#build");
  const note = $("#build-note");
  intro.classList.toggle("compact", Boolean(S.ledger));
  if (view.building) return;
  btn.classList.remove("busy");
  btn.disabled = false;
  if (!S.ledger) {
    btn.textContent = "Read the work log";
    btn.className = "btn primary";
    note.textContent = S.modes.extractor === "claude" ? "Claude reads 55 rows and emails, about a minute." : "Uses the hand-checked answer key until an Anthropic key is set.";
    return;
  }
  btn.textContent = "Read it again";
  btn.className = "btn";
  if (ext?.kind === "claude") {
    const tokens = ext.usage ? `${Math.round((ext.usage.input_tokens + ext.usage.output_tokens) / 100) / 10}k tokens` : "";
    note.textContent = `Read by ${ext.model} in ${ext.seconds}s · ${tokens} · ${stamp(ext.at)}`;
  } else {
    note.textContent = `Built from the answer key · ${stamp(S.ledger.built_at)}`;
  }
}

function renderCards() {
  const wrap = $("#cards");
  if (!S.ledger) return wrap.replaceChildren();
  wrap.replaceChildren(
    ...S.ledger.clients.map((c) => {
      const inv = S.invoices[c.id];
      const state = inv ? "sent" : c.open_flags ? "needs" : "ready";
      let status;
      if (inv) {
        status = h(
          "div",
          { class: "state sent" },
          `Sent through PayPal (${inv.mode}) · `,
          h("a", { href: inv.href, target: "_blank", rel: "noopener" }, inv.paypal_id),
          h("br"),
          `Approved by ${inv.approved_by}, ${stamp(inv.approved_at)}`,
        );
      } else if (c.open_flags) {
        status = h(
          "div",
          { class: "state flags", role: "button", tabindex: "0", onclick: () => focusFlags(c.id) },
          `${c.open_flags} line${c.open_flags > 1 ? "s" : ""} need${c.open_flags > 1 ? "" : "s"} your decision · ${money(c.pending_amount)} at stake`,
        );
      } else {
        status = h("div", { class: "state ok" }, "Every line checked against the terms.");
      }
      const blocked = Boolean(inv) || c.open_flags > 0 || c.total <= 0;
      return h(
        "article",
        { class: `card ${state}` },
        h("div", {}, h("h3", {}, c.name), h("p", { class: "terms" }, c.summary)),
        h("div", { class: "figure" }, h("span", { class: "big" }, money(inv ? inv.total : c.total)), h("span", { class: "sub" }, `${inv ? inv.lines : c.billable_lines} lines to bill`)),
        status,
        h(
          "button",
          { class: "btn primary", type: "button", disabled: blocked, onclick: () => openApprove(c.id) },
          inv ? "Invoice sent" : c.open_flags ? "Approve after deciding flags" : `Approve & send ${money(c.total)}`,
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
}

function focusFlags(clientId) {
  view.client = clientId;
  view.flagsOnly = true;
  switchTab("ledger");
  renderFilters();
  grid.onFilterChanged();
  $("#grid").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Drawer ----------
function openDrawer(key) {
  view.openKey = key;
  renderDrawer();
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
}

function closeDrawer() {
  view.openKey = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
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

function renderDrawer() {
  const l = lineFor(view.openKey);
  const d = $("#drawer");
  if (!l) return closeDrawer();
  const meta = clientMeta(l.client_id);
  const sent = Boolean(S.invoices[l.client_id]);
  const amountText = l.status === "flagged" ? `${money(l.proposed_amount)} at stake` : money(l.amount);

  let decision = null;
  if (l.status === "flagged" && !sent && l.client_id !== "unassigned") {
    const note = h("textarea", { placeholder: "Optional note, kept with the line (e.g. what the client said)" });
    const decide = async (choice, btn) => {
      btn.classList.add("busy");
      try {
        await api("/api/lines/resolve", { key: l.key, decision: choice, note: note.value });
        await refresh();
        toast(choice === "bill" ? "Line will be billed." : "Line credited; the rest re-priced.");
      } catch (e) {
        toast(e.message, "error");
        btn.classList.remove("busy");
      }
    };
    decision = h(
      "div",
      { class: "flagbox" },
      h("p", {}, l.flag),
      note,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", type: "button", onclick: (e) => decide("bill", e.currentTarget) }, `Bill ${money(l.proposed_amount)}`),
        h("button", { class: "btn", type: "button", onclick: (e) => decide("no_charge", e.currentTarget) }, "Don't bill"),
      ),
    );
  } else if (l.resolution && !sent) {
    decision = h(
      "div",
      { class: "state ok", style: "margin-top:14px" },
      `You decided this on ${stamp(l.resolution.at)}. `,
      h("button", { class: "linkish", type: "button", onclick: async () => { await api("/api/lines/resolve", { key: l.key, decision: "reopen" }); await refresh(); } }, "Reopen"),
    );
  }

  const parts = [
    h(
      "div",
      { class: "drawer-head" },
      h("div", {}, h("p", { class: "eyebrow" }, `${l.client_name}${l.date ? ` · ${shortDate(l.date)}` : ""}`), h("h2", {}, l.item)),
      h("button", { class: "close", type: "button", "aria-label": "Close", onclick: closeDrawer }, "×"),
    ),
    h("div", { class: "money-row" }, statusCell({ data: l }), h("strong", {}, amountText)),
    decision,
    l.status === "flagged" ? null : [h("h3", {}, "Why"), h("p", { class: "reason" }, l.reason)],
    l.evidence ? [h("h3", {}, "What the log shows"), h("p", {}, l.evidence)] : null,
    h("h3", {}, "Source rows"),
    l.sources.map(sourceBlock),
    meta ? [h("h3", {}, `${meta.name} terms`), h("ol", { class: "terms-list" }, meta.terms_text.map((t) => h("li", {}, t)))] : null,
  ];
  d.replaceChildren(...parts.flat(2).filter(Boolean));
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
    h("p", { class: "muted" }, "PayPal will email ", h("strong", {}, c.billing_email), " an invoice for ", h("strong", {}, money(c.total)), ", due in 15 days."),
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

async function build() {
  const btn = $("#build");
  view.building = true;
  btn.disabled = true;
  btn.classList.add("busy");
  btn.textContent = S.modes.extractor === "claude" ? "Claude is reading the log" : "Reading the log";
  try {
    await api("/api/build", { fresh: Boolean(S.ledger) });
    view.building = false;
    await refresh();
    const flags = S.ledger.lines.filter((l) => l.status === "flagged").length;
    toast(`Ledger ready: ${S.ledger.lines.length} lines, ${flags} need your decision.`);
  } catch (e) {
    view.building = false;
    toast(e.message, "error");
    await refresh();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initGrid();
  $("#build").addEventListener("click", build);
  $("#flags-only").addEventListener("change", (e) => { view.flagsOnly = e.target.checked; grid.onFilterChanged(); });
  $("#search").addEventListener("input", (e) => grid.setGridOption("quickFilterText", e.target.value));
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => switchTab(b.dataset.tab));
  $("#reset").addEventListener("click", async () => {
    await api("/api/reset", {});
    closeDrawer();
    view.client = "all";
    view.flagsOnly = false;
    await refresh();
    toast("Demo reset.");
  });
  await refresh();
});
