/* global agStudio */
// PayTally's collections dashboard in AG Studio: the same ledger, invoices and
// PayPal money as the main app, laid out for the owner's month-end look, with
// Studio's assistant running on Claude.
(async () => {
  const { createStudio, createStudioWithAi, createAiHarness, createWidgets, studioTheme, AgStudioLicenseManager } = agStudio;
  const note = document.getElementById("note");
  const host = document.getElementById("studio");

  const [cfg, d] = await Promise.all([fetch("/api/studio/config").then((r) => r.json()), fetch("/api/studio/data").then((r) => r.json())]);
  if (cfg.license_key) AgStudioLicenseManager.setLicenseKey(cfg.license_key);
  note.textContent = `${d.agency} · ${d.period}${d.built ? "" : " · recorded run, nothing sent yet"}${cfg.ai ? ` · assistant: Claude (${cfg.model})` : " · assistant off on this server"}`;

  const money = { format: "currencyFormat", formatOptions: { format: "$#,##0.00" } };
  const text = (id, name) => ({ id, name, format: "textFormat" });
  const data = {
    description: `${d.agency}, a lead-generation agency, bills each client for results under that client's terms. PayTally reads the agency's work log, bills each result with its reason and source rows, and collects through PayPal. Amounts are USD. Period: ${d.period}.`,
    sources: [
      {
        id: "lines",
        name: "Ledger lines",
        description: "One row per result in the work log. status is Billed, Not billed (free under the terms, with the reason) or Needs a decision (the owner decides; at_stake is what it would bill). sources names the work-log rows behind the line.",
        data: d.lines,
        fields: [text("client", "Client"), { id: "date", name: "Date", format: "dateFormat" }, text("item", "Line"), text("status", "Status"), { id: "amount", name: "Billed", ...money }, { id: "at_stake", name: "At stake", ...money }, text("reason", "Reason"), text("sources", "Source rows")],
      },
      {
        id: "invoices",
        name: "Invoices",
        description: "Every invoice sent through PayPal, with PayPal's status. owed is what is still open; days_overdue counts from the due date the agency's terms set. Before anything is sent, each client has one row with status 'draft, not sent': what its invoice would be.",
        data: d.invoices,
        fields: [text("invoice", "Invoice"), text("client", "Client"), text("period", "Period"), text("status", "PayPal status"), { id: "total", name: "Total", ...money }, { id: "paid", name: "Paid", ...money }, { id: "refunded", name: "Refunded", ...money }, { id: "owed", name: "Owed", ...money }, { id: "sent", name: "Sent", format: "dateFormat" }, { id: "due", name: "Due", format: "dateFormat" }, { id: "days_overdue", name: "Days overdue", format: "integerFormat" }],
      },
      {
        id: "money",
        name: "Money moved",
        description: "Every payment PayPal captured and every refund PayPal sent back (negative), with PayPal's id.",
        data: d.money,
        fields: [{ id: "date", name: "Date", format: "dateFormat" }, text("client", "Client"), text("invoice", "Invoice"), text("kind", "Kind"), { id: "amount", name: "Amount", ...money }, text("via", "Via"), text("paypal_id", "PayPal id")],
      },
    ],
  };

  const kpi = (title, field) => ({ type: "value", dataMapping: { value: [{ id: field, aggregation: "sum" }] }, format: { title: { enabled: true, text: title } } });
  const initialState = {
    pages: [
      {
        id: "collections",
        name: d.period,
        widgets: {
          billed: kpi("Billed", "lines.amount"),
          stake: kpi("Waiting on your decision", "lines.at_stake"),
          owed: kpi("Still owed", "invoices.owed"),
          moved: kpi("Moved through PayPal", "money.amount"),
          owes: {
            type: "owesScoreboard",
            dataMapping: { who: [{ id: "invoices.client" }], amount: [{ id: "invoices.owed", aggregation: "sum" }], late: [{ id: "invoices.days_overdue", aggregation: "max" }] },
            format: { title: { enabled: true, text: "Who owes what" } },
          },
          byClient: {
            type: "column-chart-grouped",
            dataMapping: { categoryKey: [{ id: "lines.client" }], valueKey: [{ id: "lines.amount", aggregation: "sum" }, { id: "lines.at_stake", aggregation: "sum" }], tooltipKey: [] },
            format: { title: { enabled: true, text: "Billed and at stake, by client" } },
          },
          lines: {
            type: "grid",
            dataMapping: { cols: ["client", "date", "item", "status", "amount", "at_stake", "reason", "sources"].map((f) => ({ id: `lines.${f}` })) },
            format: { title: { enabled: true, text: "Every line, with its reason and source rows" } },
          },
          invoices: {
            type: "grid",
            dataMapping: { cols: ["invoice", "client", "period", "status", "total", "paid", "refunded", "owed", "due", "days_overdue"].map((f) => ({ id: `invoices.${f}` })) },
            format: { title: { enabled: true, text: "Invoices in PayPal" } },
          },
        },
        widgetLayout: {
          billed: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
          stake: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 6 },
          owed: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 6 },
          moved: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 6 },
          owes: { xTrack: 0, yTrack: 6, xSpan: 10, ySpan: 14 },
          byClient: { xTrack: 10, yTrack: 6, xSpan: 14, ySpan: 14 },
          lines: { xTrack: 0, yTrack: 20, xSpan: 24, ySpan: 16 },
          invoices: { xTrack: 0, yTrack: 36, xSpan: 24, ySpan: 12 },
        },
      },
    ],
    selectedPageId: "collections",
    panels: { filters: { collapsed: true } },
  };

  const theme = studioTheme.withParams({
    fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    backgroundColor: "#ffffff",
    foregroundColor: "#14213d",
    accentColor: "#1f6f5c",
    borderColor: "#e5e1d6",
    studioCanvasBackgroundColor: "#f6f4ee",
    studioWidgetBackgroundColor: "#ffffff",
    studioWidgetBorder: { width: 1, color: "#e5e1d6" },
    studioWidgetBorderRadius: 12,
    studioWidgetTitleFontSize: 14,
    studioWidgetTitleFontWeight: 650,
    gridHeaderBackgroundColor: "#f3f1ea",
    gridHeaderFontWeight: 650,
    chartPaletteFills1Color: "#1f6f5c",
    chartPaletteStrokes1Color: "#1f6f5c",
    chartPaletteFills2Color: "#f2c14e",
    chartPaletteStrokes2Color: "#d9a632",
    chartPaletteFills3Color: "#22325a",
    chartPaletteStrokes3Color: "#22325a",
  });

  const widgets = (defaults) =>
    createWidgets({
      additionalTypes: [window.owesScoreboardDefinition],
      menu: [{ label: "PayTally", widgetIds: ["owesScoreboard"] }, ...(defaults?.menu || [])],
    });

  const properties = { data, initialState, theme, widgets, mode: "view", layout: { widgetBorderEnabled: true } };
  host.replaceChildren();
  let api;
  if (cfg.ai) {
    const adapter = window.claudeAdapter({ endpoint: "/api/studio/claude" });
    api = createStudioWithAi(host, {
      ...properties,
      ai: ({ api: studio }) =>
        createAiHarness(studio, {
          adapter,
          promptStarters: [
            { label: "Who to chase first", prompt: "Which client should the owner chase first for money, and why?" },
            { label: "What needs a decision", prompt: "Which lines still need the owner's decision, and how much is at stake on each?" },
            { label: "Add a refunds chart", prompt: "Add a chart of the money PayPal moved, payments against refunds, by client." },
          ],
        }),
    });
  } else {
    api = createStudio(host, properties);
  }
  window.studioApi = api;

  const edit = document.getElementById("edit");
  edit.addEventListener("click", () => {
    const next = edit.dataset.mode === "edit" ? "view" : "edit";
    edit.dataset.mode = next;
    edit.textContent = next === "edit" ? "Done editing" : "Edit layout";
    (api.setProperty?.bind(api) || ((k, v) => api.updateProperties?.({ [k]: v })))("mode", next);
  });
})().catch((err) => {
  document.getElementById("studio").innerHTML = "";
  const p = document.createElement("p");
  p.className = "msg";
  p.textContent = `The dashboard could not load: ${err.message}`;
  document.getElementById("studio").append(p);
  console.error(err);
});
