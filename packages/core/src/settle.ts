import { systemClock, type Clock } from "./clock.js";
import type { Confirmer, SubmitOutcome, Submitter } from "./horizon.js";
import { isPastExpiry, type PaymentQueue } from "./queue.js";
import type { PaymentRecord } from "./types.js";

export interface SettlementReport {
  settled: string[];
  failed: string[];
  expired: string[];
  /** Still queued/submitting/submitted after this pass. */
  pending: string[];
  /** Records skipped because of a transport or concurrency error; retried next pass. */
  errors: { hash: string; message: string }[];
}

export interface SettlerOptions {
  queue: PaymentQueue;
  submitter: Submitter;
  confirmer: Confirmer;
  clock?: Clock;
  /** Resubmit a "submitted" tx Horizon still doesn't know after this many seconds. */
  resubmitAfterSeconds?: number;
}

/**
 * Drives queued payments to a terminal state. Call {@link runOnce} whenever
 * connectivity returns; it is safe to call repeatedly and concurrently.
 *
 * Invariants:
 * - The queue persists "submitting" before every submit call.
 * - Settlement comes only from a Horizon lookup by hash, never from a submit response.
 * - Resubmitting the same envelope is safe: the hash is the idempotency key.
 *
 * TODO(triggers): wire runOnce() to a connectivity listener (NetInfo) and a timer in the app.
 * TODO(backoff): exponential backoff per record instead of a fixed resubmit delay.
 */
export class Settler {
  private readonly clock: Clock;
  private readonly resubmitAfter: number;
  private inFlight: Promise<SettlementReport> | null = null;

  constructor(private readonly options: SettlerOptions) {
    this.clock = options.clock ?? systemClock;
    this.resubmitAfter = options.resubmitAfterSeconds ?? 30;
  }

  /** Runs one settlement pass. Overlapping calls share the pass already in flight. */
  runOnce(): Promise<SettlementReport> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(): Promise<SettlementReport> {
    const report: SettlementReport = { settled: [], failed: [], expired: [], pending: [], errors: [] };
    const active = await this.options.queue.list(["queued", "submitting", "submitted"]);
    for (const record of sortForSubmission(active)) {
      try {
        const result = await this.process(record);
        bucket(report, result).push(result.hash);
      } catch (err) {
        report.errors.push({ hash: record.hash, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  private process(record: PaymentRecord): Promise<PaymentRecord> {
    return record.state === "queued" ? this.processQueued(record) : this.reconcile(record);
  }

  private async processQueued(record: PaymentRecord): Promise<PaymentRecord> {
    const { queue, confirmer } = this.options;
    if (!isPastExpiry(record.maxTime, this.clock())) return this.submitAndCheck(record);
    if (record.attempts === 0) return queue.markExpired(record);
    const confirmation = await confirmer.confirm(record.hash);
    return confirmation.found ? queue.applyConfirmation(record, confirmation) : queue.markExpired(record, confirmation);
  }

  /**
   * Handles "submitting" (left over from an interrupted pass, outcome unknown)
   * and "submitted" records by asking Horizon about the hash.
   */
  private async reconcile(record: PaymentRecord): Promise<PaymentRecord> {
    const { queue, confirmer } = this.options;
    const confirmation = await confirmer.confirm(record.hash);
    if (confirmation.found) return queue.applyConfirmation(record, confirmation);
    if (isPastExpiry(record.maxTime, this.clock())) return queue.markExpired(record, confirmation);
    if (record.state === "submitting") return queue.markSubmitted(record, "Recovered after an interrupted submit");
    if (this.clock() - record.updatedAt >= this.resubmitAfter) return this.submitAndCheck(record);
    return record;
  }

  private async submitAndCheck(record: PaymentRecord): Promise<PaymentRecord> {
    const { queue, submitter, confirmer } = this.options;
    const submitting = await queue.beginSubmit(record); // persisted before the network call
    const outcome = await submitter.submit(record.xdr).catch(
      (err: unknown): SubmitOutcome => ({ kind: "unknown", hash: record.hash, error: String(err) }),
    );
    // A submit response is not proof of anything: always look the hash up.
    // If this lookup throws, the record stays "submitting" and the next pass reconciles it.
    const confirmation = await confirmer.confirm(record.hash);
    if (confirmation.found) return queue.applyConfirmation(submitting, confirmation);
    if (outcome.kind === "rejected") {
      return outcome.retryable
        ? queue.requeue(submitting, outcome.code)
        : queue.markRejected(submitting, confirmation, outcome.code);
    }
    return queue.markSubmitted(submitting, outcome.kind === "unknown" ? outcome.error : null);
  }
}

/**
 * Stellar: txs from one account must land in sequence order, so each source's
 * payments are submitted lowest sequence first.
 */
export function sortForSubmission(records: readonly PaymentRecord[]): PaymentRecord[] {
  return [...records].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    const diff = BigInt(a.sequence) - BigInt(b.sequence);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });
}

function bucket(report: SettlementReport, record: PaymentRecord): string[] {
  switch (record.state) {
    case "settled":
      return report.settled;
    case "failed":
      return report.failed;
    case "expired":
      return report.expired;
    default:
      return report.pending;
  }
}
