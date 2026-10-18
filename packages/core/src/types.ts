import type { PaymentState } from "./state.js";

/** A payment as persisted in the merchant's local queue. */
export interface PaymentRecord {
  /** Hex tx hash. Primary key and idempotency key: the same signed tx can never be queued twice. */
  hash: string;
  /** Signed TransactionEnvelope XDR (base64), resubmitted verbatim. */
  xdr: string;
  requestId: string;
  source: string;
  destination: string;
  amount: string;
  asset: string;
  /** Source account sequence number used by this tx, as a decimal string. */
  sequence: string;
  /** Unix seconds from the tx time bounds. */
  maxTime: number;
  state: PaymentState;
  /** Number of submit calls attempted. */
  attempts: number;
  /** Last submit/confirm problem, for display and debugging. */
  lastError: string | null;
  /** Ledger that included the tx. Set only from a Horizon confirmation. */
  ledger: number | null;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds of the last state change. */
  updatedAt: number;
}
