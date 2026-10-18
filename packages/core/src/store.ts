import type { PaymentState } from "./state.js";
import type { PaymentRecord } from "./types.js";

/**
 * Persistence contract for the payment queue. Every write must be durable by
 * the time its promise resolves: the settler relies on that to guarantee each
 * state change is persisted before the network call that follows it.
 *
 * Implementations: {@link MemoryQueueStore} (tests), {@link SqlQueueStore}
 * (op-sqlite + SQLCipher on device, node:sqlite in tests).
 */
export interface QueueStore {
  /** Inserts a new record. Resolves false (and changes nothing) if the hash already exists. */
  insert(record: PaymentRecord): Promise<boolean>;
  get(hash: string): Promise<PaymentRecord | undefined>;
  /**
   * Replaces the stored record only if its current state equals `expected`.
   * Resolves false when another writer changed it first (optimistic locking).
   */
  compareAndSet(record: PaymentRecord, expected: PaymentState): Promise<boolean>;
  /** Lists records, optionally filtered by state, oldest first. */
  list(states?: readonly PaymentState[]): Promise<PaymentRecord[]>;
}

/** Non-durable store for tests and prototypes. */
export class MemoryQueueStore implements QueueStore {
  private readonly records = new Map<string, PaymentRecord>();

  async insert(record: PaymentRecord): Promise<boolean> {
    if (this.records.has(record.hash)) return false;
    this.records.set(record.hash, { ...record });
    return true;
  }

  async get(hash: string): Promise<PaymentRecord | undefined> {
    const found = this.records.get(hash);
    return found && { ...found };
  }

  async compareAndSet(record: PaymentRecord, expected: PaymentState): Promise<boolean> {
    if (this.records.get(record.hash)?.state !== expected) return false;
    this.records.set(record.hash, { ...record });
    return true;
  }

  async list(states?: readonly PaymentState[]): Promise<PaymentRecord[]> {
    return [...this.records.values()]
      .filter((r) => !states || states.includes(r.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }
}
