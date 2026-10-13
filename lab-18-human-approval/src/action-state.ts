/**
 * The proposal lifecycle as data. The SQL in `action-service.ts` performs each transition as a
 * conditional UPDATE guarded by the same "from" set, and a database trigger refuses to move a
 * terminal state; this table is what the tests and the README read as the specification.
 *
 *   pending  --approve-->  approved --execute--> executed
 *      |  \                   |  \
 *      |   reject             |   revoke
 *      |     v                |     v
 *      |  rejected            |   revoked
 *      +--expire--> expired <-+   (approved actions expire too, at the approval deadline)
 *      +--invalidate--> invalidated <--+  (digest or resource version no longer matches)
 */
export const ACTION_STATES = ["pending", "approved", "rejected", "expired", "revoked", "invalidated", "executed"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export type ActionEvent = "approve" | "reject" | "expire" | "revoke" | "invalidate" | "execute";

const TRANSITIONS: Record<ActionEvent, { from: readonly ActionState[]; to: ActionState }> = {
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  expire: { from: ["pending", "approved"], to: "expired" },
  revoke: { from: ["approved"], to: "revoked" },
  invalidate: { from: ["pending", "approved"], to: "invalidated" },
  execute: { from: ["approved"], to: "executed" },
};

export const TERMINAL_STATES: readonly ActionState[] = ["rejected", "expired", "revoked", "invalidated", "executed"];

export function nextState(state: ActionState, event: ActionEvent): ActionState | undefined {
  const rule = TRANSITIONS[event];
  return rule.from.includes(state) ? rule.to : undefined;
}

/** States an event may start from — the guard the SQL UPDATEs reuse so code and table cannot drift. */
export function fromStates(event: ActionEvent): readonly ActionState[] {
  return TRANSITIONS[event].from;
}
