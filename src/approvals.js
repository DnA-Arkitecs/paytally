// The human checkpoint. An approval can only be made here, only lives in memory
// for the request that made it, and is tied to the exact invoice the owner saw:
// if one line or cent changes, the approval no longer matches and PayPal refuses.
import crypto from "node:crypto";

const issued = new WeakSet();

export class ApprovalError extends Error {}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

export function draftHash(draft) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(draft))).digest("hex");
}

export function issueApproval(draft, { approvedBy }) {
  const approval = Object.freeze({
    client_id: draft.client_id,
    total: draft.total,
    hash: draftHash(draft),
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  });
  issued.add(approval);
  return approval;
}

export function assertApproved(draft, approval) {
  if (!approval || !issued.has(approval)) {
    throw new ApprovalError("Nothing goes to PayPal without the owner's approval.");
  }
  if (approval.hash !== draftHash(draft)) {
    throw new ApprovalError("This invoice changed after it was approved; it needs a fresh approval.");
  }
}
