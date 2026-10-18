import { DatabaseSync } from "node:sqlite";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { toHex } from "../src/bytes.js";
import type { Confirmation, Confirmer, PaymentRequest, SqlDriver, SubmitOutcome, Submitter } from "../src/index.js";
import { NETWORK_PASSPHRASE, buildOfflinePayment, verifySignedPayment } from "../src/index.js";

export const NOW = 1_800_000_000;

export const merchant = Keypair.random();
export const customer = Keypair.random();

/** A mutable clock tests can advance. */
export function fakeClock(start = NOW) {
  let now = start;
  const clock = () => now;
  clock.advance = (seconds: number) => {
    now += seconds;
  };
  return clock;
}

export function makeRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    v: 1,
    id: "order-42",
    destination: merchant.publicKey(),
    amount: "12.5",
    asset: "native",
    expiresAt: NOW + 600,
    ...overrides,
  };
}

let nextSequence = 100n;

/** Signs a fresh payment from `customer` and verifies it, like a merchant would. */
export function makeVerified(overrides: Partial<PaymentRequest> = {}, sequence = nextSequence++) {
  const request = makeRequest(overrides);
  const signed = buildOfflinePayment({
    request,
    signer: customer,
    account: { publicKey: customer.publicKey(), sequence: String(sequence) },
    clock: () => NOW,
  });
  return verifySignedPayment(signed.xdr, request, () => NOW);
}

type NetworkEvent = { type: "submit" | "confirm"; hash: string };

/**
 * Scriptable stand-in for Horizon. `onSubmit` decides what a submit returns;
 * `ledger` holds the txs Horizon "knows" (what confirm() reports).
 */
export class FakeNetwork implements Submitter, Confirmer {
  readonly events: NetworkEvent[] = [];
  readonly ledger = new Map<string, { successful: boolean; ledger: number }>();
  onSubmit: (hash: string) => SubmitOutcome | Promise<SubmitOutcome> = (hash) => {
    this.ledger.set(hash, { successful: true, ledger: 4242 });
    return { kind: "accepted", hash };
  };
  confirmError: Error | null = null;
  /** Lets tests observe state at the moment of a network call. */
  beforeCall: ((event: NetworkEvent) => void | Promise<void>) | null = null;

  async submit(xdr: string): Promise<SubmitOutcome> {
    const hash = toHex(TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE).hash());
    await this.record({ type: "submit", hash });
    return this.onSubmit(hash);
  }

  async confirm(hash: string): Promise<Confirmation> {
    await this.record({ type: "confirm", hash });
    if (this.confirmError) throw this.confirmError;
    const entry = this.ledger.get(hash);
    return entry ? { found: true, hash, ...entry } : { found: false, hash };
  }

  private async record(event: NetworkEvent) {
    await this.beforeCall?.(event);
    this.events.push(event);
  }
}

/** SqlDriver over Node's built-in SQLite, mirroring the op-sqlite adapter used on device. */
export function nodeSqliteDriver(db = new DatabaseSync(":memory:")): SqlDriver {
  return {
    async execute(sql, params = []) {
      const statement = db.prepare(sql);
      if (statement.columns().length > 0) {
        return { rows: statement.all(...params) as Record<string, unknown>[], rowsAffected: 0 };
      }
      const result = statement.run(...params);
      return { rows: [], rowsAffected: Number(result.changes) };
    },
  };
}
