import { GhostRailError } from "./errors.js";

/**
 * Lifecycle of a queued payment.
 *
 *   queued ──► submitting ──► submitted ──► settled
 *     │            │  ▲           │  │
 *     │            │  └───────────┘  ├──► failed
 *     │            ├──► queued       └──► expired
 *     │            └──► settled | failed | expired
 *     └──► expired | settled | failed   (settled/failed only if previously submitted)
 *
 * - queued:     verified offline and stored, never sent (or bounced back for retry).
 *               A requeued tx may still be confirmed later, hence queued → settled | failed;
 *               PaymentQueue refuses that for records with zero submit attempts.
 * - submitting: persisted immediately BEFORE a submit call; after a crash it means "outcome unknown".
 * - submitted:  a submit was attempted; we wait for Horizon to show the hash.
 * - settled:    Horizon returned the tx by hash with successful=true. Terminal.
 * - failed:     Horizon shows the tx failed in a ledger, or it was permanently rejected. Terminal.
 * - expired:    past maxTime and Horizon has no record of the hash. Terminal.
 */
export const PAYMENT_STATES = ["queued", "submitting", "submitted", "settled", "failed", "expired"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const TERMINAL_STATES: readonly PaymentState[] = ["settled", "failed", "expired"];

const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  queued: ["submitting", "expired", "settled", "failed"],
  submitting: ["submitted", "queued", "settled", "failed", "expired"],
  submitted: ["submitting", "settled", "failed", "expired"],
  settled: [],
  failed: [],
  expired: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to)) {
    throw new GhostRailError("INVALID_TRANSITION", `Cannot move payment from ${from} to ${to}`);
  }
}

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_STATES.includes(state);
}
