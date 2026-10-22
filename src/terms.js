// The terms engine. Claude reads the messy log and says what happened; this
// file decides what it costs. Money math stays in plain, testable code.
//
// Input: one client's items (what happened, with sources) and the owner's
// decisions on flagged lines. Output: ledger lines, each with an amount, a
// plain-English reason naming the clause it applied, and its source rows.

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// "2026-10-10" + "11:00" or "2026-10-11T09:05" -> minutes since epoch, read as
// local wall-clock time on both sides so time zones cancel out.
function wallClock(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(time ? `${date}T${time}` : date);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000;
}

const hoursBetween = (fromMin, toMin) => Math.round(((toMin - fromMin) / 60) * 10) / 10;

// The row a line is "about": its calendar or CRM row, not the email that mentions it.
export const primarySource = (item) => item.sources.find((s) => !s.startsWith("email:")) || item.sources[0] || "";

export function lineKey(clientId, item) {
  return `${clientId}|${primarySource(item) || item.person}`;
}

function baseLine(client, item) {
  return {
    key: lineKey(client.id, item),
    client_id: client.id,
    client_name: client.name,
    date: item.date,
    person: item.person,
    item: `${client.terms.item_label} — ${item.person}`,
    sources: item.sources,
    evidence: item.evidence,
    outcome: item.outcome,
    amount: 0,
    proposed_amount: 0,
    status: "no_charge",
    reason: "",
    flag: "",
    resolution: null,
  };
}

// A decision the terms can't make goes to the owner. The line keeps the amount
// it would bill so the owner sees what is at stake.
function flag(line, proposed, why) {
  line.status = "flagged";
  line.proposed_amount = proposed;
  line.amount = 0;
  line.flag = why;
  line.reason = `Needs your decision: ${why}`;
  return line;
}

function bill(line, amount, reason) {
  line.status = "bill";
  line.amount = amount;
  line.proposed_amount = amount;
  line.reason = reason;
  return line;
}

function free(line, reason, proposed = 0) {
  line.status = "no_charge";
  line.amount = 0;
  line.proposed_amount = proposed;
  line.reason = reason;
  return line;
}

// Checks every client type shares: Claude's own doubts, disputes, duplicates.
function commonFlags(line, item, proposed) {
  if (item.unclear) return flag(line, proposed, item.unclear);
  if (item.dispute_email) {
    return flag(line, proposed, `Client disputes this line (email ${item.dispute_email}): ${item.dispute_claim}`);
  }
  return null;
}

// The owner's click on a flagged line overrides the flag, and says so.
function applyResolution(line, resolution) {
  if (!resolution || line.status !== "flagged") return line;
  const note = resolution.note ? ` Note: ${resolution.note}` : "";
  line.resolution = resolution;
  line.flag = "";
  if (resolution.decision === "bill") {
    line.status = "bill";
    line.amount = line.proposed_amount;
    line.reason = `You approved billing ${money(line.proposed_amount)} after review.${note}`;
  } else {
    line.status = "no_charge";
    line.amount = 0;
    line.reason = `You chose not to bill this line (${money(line.proposed_amount)} credited).${note}`;
  }
  return line;
}

const byWhen = (a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);

function perHeldCall(client, items, resolutions) {
  const t = client.terms;
  return items.sort(byWhen).map((item) => {
    const line = baseLine(client, item);
    const resolve = (l) => applyResolution(l, resolutions[l.key]);
    if (commonFlags(line, item, t.rate)) return resolve(line);
    if (item.duplicate_of) return free(line, `Duplicate of ${item.duplicate_of}: each call is billed once (§1).`);
    switch (item.outcome) {
      case "held":
        return bill(line, t.rate, `Call took place: ${money(t.rate)} per booked call (§1).`);
      case "no_show":
        return free(line, "No-show: free (§2).", t.rate);
      case "rescheduled":
        return free(line, "Rescheduled: billed once, when the new call takes place (§3).", t.rate);
      case "cancelled_by_prospect":
        return free(line, "Homeowner cancelled: free (§4).", t.rate);
      case "cancelled_by_client": {
        const at = item.cancelled_at && wallClock(item.cancelled_at);
        const start = wallClock(item.date, item.time);
        if (at == null || start == null) return resolve(flag(line, t.rate, `${client.name} cancelled, but when is not recorded; §4 depends on it.`));
        const ahead = hoursBetween(at, start);
        return ahead < t.late_cancel_hours
          ? bill(line, t.rate, `${client.name} cancelled ${ahead} hours ahead, under ${t.late_cancel_hours} hours: billed (§4).`)
          : free(line, `${client.name} cancelled ${ahead} hours ahead: free (§4).`, t.rate);
      }
      default:
        return resolve(flag(line, t.rate, `Outcome "${item.outcome}" doesn't fit per-call terms.`));
    }
  });
}

function retainerPlusPerLead(client, items, resolutions, period) {
  const t = client.terms;
  const retainer = {
    key: `${client.id}|retainer`,
    client_id: client.id,
    client_name: client.name,
    date: period.start,
    person: "",
    item: `Monthly retainer — ${period.label}`,
    sources: ["terms"],
    evidence: "Fixed monthly fee in the agreement.",
    outcome: "retainer",
    amount: t.retainer,
    proposed_amount: t.retainer,
    status: "bill",
    reason: `Monthly retainer: ${money(t.retainer)} (§1).`,
    flag: "",
    resolution: null,
  };
  const lines = items.sort(byWhen).map((item) => {
    const line = baseLine(client, item);
    const resolve = (l) => applyResolution(l, resolutions[l.key]);
    if (commonFlags(line, item, t.rate)) return resolve(line);
    if (item.duplicate_of) return free(line, `Same person as ${item.duplicate_of}: counts once a month (§3).`, t.rate);
    switch (item.outcome) {
      case "qualified":
        return bill(line, t.rate, `Qualified, with insurance or budget confirmed: ${money(t.rate)} (§2).`);
      case "unqualified":
        return free(line, "Marked Unqualified: not billed (§4).", t.rate);
      case "not_reviewed":
        return free(line, "Not reviewed by the studio yet: not billed (§4).", t.rate);
      default:
        return resolve(flag(line, t.rate, `Outcome "${item.outcome}" doesn't fit per-lead terms.`));
    }
  });
  return [retainer, ...lines];
}

function tieredPerHeldWithReportWindow(client, items, resolutions) {
  const t = client.terms;
  let billable = 0;
  // Each billable line takes the next place in the month's count, which sets
  // its price. Open flags hold their place so the owner sees the price at stake.
  const nextPrice = () => {
    const n = billable + 1;
    const price = n >= t.tier_from ? t.tier_rate : t.rate;
    const tier = n >= t.tier_from ? `${money(t.tier_rate)} tier` : money(t.rate);
    return { n, price, label: `${ordinal(n)} billable this month, ${tier}` };
  };
  return items.sort(byWhen).map((item) => {
    const line = baseLine(client, item);
    const p = nextPrice();
    const take = (l) => {
      if (l.status === "bill" || l.status === "flagged") billable += 1;
      return l;
    };
    const resolve = (l) => take(applyResolution(l, resolutions[l.key]));
    if (commonFlags(line, item, p.price)) return resolve(line);
    if (item.duplicate_of) return free(line, `Duplicate of ${item.duplicate_of}: each consultation is billed once (§1).`);
    switch (item.outcome) {
      case "held":
        return take(bill(line, p.price, `Consultation took place, ${p.label} (§1).`));
      case "no_show": {
        const start = wallClock(item.date, item.time);
        const reported = item.no_show_reported_at && wallClock(item.no_show_reported_at);
        if (reported == null || start == null) {
          return resolve(flag(line, p.price, `No-show, but ${client.name} never reported it; §2 bills unreported no-shows.`));
        }
        const after = hoursBetween(start, reported);
        return after <= t.report_window_hours
          ? free(line, `No-show reported ${after} hours after the appointment, within ${t.report_window_hours} hours: free (§2).`, p.price)
          : take(bill(line, p.price, `No-show reported ${after} hours after the appointment, past the ${t.report_window_hours}-hour window: billed as the ${p.label} (§2).`));
      }
      case "cancelled_by_client":
      case "cancelled_by_prospect":
      case "rescheduled":
        return free(line, "Did not take place: only consultations that take place are billed (§1).", p.price);
      default:
        return resolve(flag(line, p.price, `Outcome "${item.outcome}" doesn't fit per-consultation terms.`));
    }
  });
}

const ENGINES = {
  per_held_call: perHeldCall,
  retainer_plus_per_lead: retainerPlusPerLead,
  tiered_per_held_with_report_window: tieredPerHeldWithReportWindow,
};

export function priceClient(client, items, resolutions, period) {
  const engine = ENGINES[client.terms.type];
  if (!engine) throw new Error(`No terms engine for type ${client.terms.type}`);
  return engine(client, items.map((i) => ({ ...i })), resolutions, period);
}
