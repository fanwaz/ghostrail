import { systemClock, type Clock } from "./clock.js";
import { GhostRailError } from "./errors.js";
import type { Confirmation } from "./horizon.js";
import { assertTransition, type PaymentState } from "./state.js";
import type { QueueStore } from "./store.js";
import type { PaymentRecord } from "./types.js";
import type { VerifiedPayment } from "./verify.js";

/**
 * Stellar: validators check maxTime against ledger close time, which trails
 * wall-clock by a few seconds; the margin also absorbs device clock skew.
 */
export const EXPIRY_GRACE_SECONDS = 60;

/** True once a tx with this maxTime can no longer be included in any ledger. */
export function isPastExpiry(maxTime: number, now: number): boolean {
  return now > maxTime + EXPIRY_GRACE_SECONDS;
}

export interface TransitionEvent {
  record: PaymentRecord;
  /** null when the record was first enqueued. */
  from: PaymentState | null;
}

/**
 * Called after a change has been persisted.
 * TODO(hooks): audit log, UI notifications, sync to a merchant backend.
 */
export type TransitionListener = (event: TransitionEvent) => void;

/**
 * The merchant's payment queue. Every method persists its change through the
 * store before resolving, and every state change is checked against the state
 * machine in `state.ts`.
 *
 * "settled" is reachable only through {@link applyConfirmation}, which demands
 * a Horizon {@link Confirmation} for the record's own hash.
 */
export class PaymentQueue {
  private readonly clock: Clock;
  private readonly onTransition: TransitionListener | undefined;

  constructor(
    private readonly store: QueueStore,
    options: { clock?: Clock; onTransition?: TransitionListener } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.onTransition = options.onTransition;
  }

  /**
   * Adds a verified payment. Idempotent on the tx hash: enqueuing the same
   * signed tx again returns the existing record with `duplicate: true`.
   */
  async enqueue(payment: VerifiedPayment): Promise<{ record: PaymentRecord; duplicate: boolean }> {
    const now = this.clock();
    const record: PaymentRecord = {
      ...payment,
      state: "queued",
      attempts: 0,
      lastError: null,
      ledger: null,
      createdAt: now,
      updatedAt: now,
    };
    if (await this.store.insert(record)) {
      this.onTransition?.({ record, from: null });
      return { record, duplicate: false };
    }
    const existing = await this.store.get(payment.hash);
    if (!existing) throw new GhostRailError("NOT_FOUND", `Payment ${payment.hash} vanished during enqueue`);
    return { record: existing, duplicate: true };
  }

  get(hash: string): Promise<PaymentRecord | undefined> {
    return this.store.get(hash);
  }

  list(states?: readonly PaymentState[]): Promise<PaymentRecord[]> {
    return this.store.list(states);
  }

  /** Marks the record as about to be submitted. Must resolve before any submit call. */
  beginSubmit(record: PaymentRecord): Promise<PaymentRecord> {
    return this.write(record, "submitting", { attempts: record.attempts + 1, lastError: null });
  }

  /** A submit was attempted and its outcome is not yet confirmed. */
  markSubmitted(record: PaymentRecord, note: string | null = null): Promise<PaymentRecord> {
    return this.write(record, "submitted", { lastError: note });
  }

  /** Puts a record back in the queue after a retryable rejection. */
  requeue(record: PaymentRecord, reason: string): Promise<PaymentRecord> {
    return this.write(record, "queued", { lastError: reason });
  }

  /**
   * Records what Horizon says about this hash: settled if successful, failed
   * otherwise. Accepted from any non-terminal state of a record that was
   * submitted at least once (a requeued tx may still have landed).
   */
  async applyConfirmation(record: PaymentRecord, confirmation: Confirmation & { found: true }): Promise<PaymentRecord> {
    this.assertSameHash(record, confirmation);
    if (record.attempts === 0) {
      throw new GhostRailError("INVALID_TRANSITION", `Payment ${record.hash} was never submitted`);
    }
    return this.write(record, confirmation.successful ? "settled" : "failed", {
      ledger: confirmation.ledger,
      lastError: confirmation.successful ? null : "Transaction failed on-ledger",
    });
  }

  /**
   * Permanent rejection at submission. Requires proof that Horizon has no
   * record of the hash, so a tx that actually landed is never marked failed.
   */
  async markRejected(record: PaymentRecord, notFound: Confirmation & { found: false }, code: string): Promise<PaymentRecord> {
    this.assertSameHash(record, notFound);
    return this.write(record, "failed", { lastError: code });
  }

  /**
   * Expires a record whose maxTime has passed. A record that was ever submitted
   * also needs proof that Horizon has no record of its hash.
   */
  async markExpired(record: PaymentRecord, notFound?: Confirmation & { found: false }): Promise<PaymentRecord> {
    if (!isPastExpiry(record.maxTime, this.clock())) {
      throw new GhostRailError("INVALID_TRANSITION", `Payment ${record.hash} has not expired yet`);
    }
    if (record.attempts > 0) {
      if (!notFound) throw new GhostRailError("INVALID_TRANSITION", "A submitted payment needs a Horizon lookup before expiring");
      this.assertSameHash(record, notFound);
    }
    return this.write(record, "expired", { lastError: "Expired before settlement" });
  }

  private async write(
    record: PaymentRecord,
    to: PaymentState,
    patch: Partial<Pick<PaymentRecord, "attempts" | "lastError" | "ledger">>,
  ): Promise<PaymentRecord> {
    assertTransition(record.state, to);
    const next: PaymentRecord = { ...record, ...patch, state: to, updatedAt: this.clock() };
    if (!(await this.store.compareAndSet(next, record.state))) {
      throw new GhostRailError("STALE_STATE", `Payment ${record.hash} changed concurrently; reload and retry`);
    }
    this.onTransition?.({ record: next, from: record.state });
    return next;
  }

  private assertSameHash(record: PaymentRecord, confirmation: Confirmation): void {
    if (confirmation.hash !== record.hash) {
      throw new GhostRailError("MISMATCH", `Confirmation for ${confirmation.hash} applied to ${record.hash}`);
    }
  }
}
