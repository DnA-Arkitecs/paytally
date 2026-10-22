// A custom AG Studio widget: who owes what, largest balance first, each with a
// bar and how overdue it is. It reads through Studio's data engine, so page
// filters and cross-filters apply to it like any built-in widget.
class OwesScoreboard {
  init(params) {
    this.eGui = document.createElement("div");
    this.eGui.className = "pt-owes";
    return this.draw(params);
  }

  refresh(params) {
    return this.draw(params);
  }

  getGui() {
    return this.eGui;
  }

  async draw({ widgetApi, dataMapping }) {
    const who = dataMapping.who?.at(0);
    const amount = dataMapping.amount?.at(0);
    const late = dataMapping.late?.at(0);
    if (!who || !amount) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    widgetApi.setDisplayState("loading", { prominent: !this.loaded });
    const res = await widgetApi.getData({ fields: [who, amount, ...(late ? [late] : [])] });
    const list = res.results.rows
      .map((r) => ({ name: String(r[who.key] ?? ""), total: Number(r[amount.key]) || 0, late: late ? Number(r[late.key]) || 0 : 0 }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
    this.loaded = list.length > 0;
    const max = Math.max(...list.map((x) => x.total), 1);
    const sum = list.reduce((n, x) => n + x.total, 0);
    const row = ({ name, total, late: days }, i) => {
      const el = document.createElement("div");
      el.className = "pt-owes-row";
      const rank = document.createElement("span");
      rank.className = "pt-rank";
      rank.textContent = String(i + 1);
      const mid = document.createElement("div");
      const label = document.createElement("div");
      label.className = "pt-name";
      label.textContent = name;
      if (days > 0) {
        const tag = document.createElement("span");
        tag.className = "pt-late";
        tag.textContent = `${days} days overdue`;
        label.append(" ", tag);
      }
      const bar = document.createElement("div");
      bar.className = `pt-bar${days > 0 ? " late" : ""}`;
      bar.style.width = `${Math.round((total / max) * 100)}%`;
      mid.append(label, bar);
      const amt = document.createElement("b");
      amt.textContent = widgetApi.formatFieldValue(amount, total);
      el.append(rank, mid, amt);
      return el;
    };
    const head = document.createElement("div");
    head.className = "pt-owes-head";
    head.textContent = list.length ? `${widgetApi.formatFieldValue(amount, sum)} open across ${list.length} client${list.length === 1 ? "" : "s"}` : "Nobody owes anything right now.";
    this.eGui.replaceChildren(head, ...list.map(row));
    widgetApi.setDisplayState("displayed");
  }
}

window.owesScoreboardDefinition = {
  id: "owesScoreboard",
  label: "Who owes what",
  icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 18h4V8H4zm6 0h4V4h-4zm6 0h4v-7h-4z" fill="currentColor"/></svg>',
  dataMapping: {
    who: { type: "field", supportedRoles: ["category"], requires: { cardinality: "one" }, required: true, aiDescription: "The client who owes the money." },
    amount: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.who", cardinality: "one" }, required: true, aiDescription: "The amount still owed, summed per client." },
    late: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.who", cardinality: "one" }, aiDescription: "Days overdue, the largest per client." },
  },
  form: (params) =>
    params.createDefaults({
      dataMappingItems: [
        { key: "who", label: "Client" },
        { key: "amount", label: "Amount owed" },
        { key: "late", label: "Days overdue" },
      ],
    }),
  comp: OwesScoreboard,
  defaultSize: { width: 420, height: 320 },
  minSize: { width: 240, height: 160 },
  ai: { description: "Ranked list of who owes what, largest open balance first, with a bar per client and how many days overdue." },
};
