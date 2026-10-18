import { Horizon, NotFoundError, TransactionBuilder } from "@stellar/stellar-sdk";
import { toHex } from "./bytes.js";
import { HORIZON_URL, NETWORK_PASSPHRASE } from "./network.js";

/**
 * Result of looking a tx hash up on Horizon. This is the ONLY evidence that
 * may move a payment to "settled" or record its ledger.
 */
export type Confirmation =
  | { found: false; hash: string }
  | { found: true; hash: string; successful: boolean; ledger: number };

/**
 * What a submit attempt told us. None of these prove settlement — even
 * "accepted" is followed by a {@link Confirmer.confirm} lookup.
 */
export type SubmitOutcome =
  | { kind: "accepted"; hash: string }
  | { kind: "rejected"; hash: string; code: string; retryable: boolean }
  /** Timeout, network or 5xx error: the tx may or may not have reached the network. */
  | { kind: "unknown"; hash: string; error: string };

/** Sends a signed envelope to the network (directly, or via the GhostRail relayer). */
export interface Submitter {
  submit(xdr: string): Promise<SubmitOutcome>;
}

/** Looks a hash up on Horizon. Throws on transport errors; never guesses. */
export interface Confirmer {
  confirm(hash: string): Promise<Confirmation>;
}

/**
 * Stellar: these tx-level codes can succeed on a later attempt with the SAME
 * envelope (bad_seq: an earlier tx from the customer hasn't landed yet).
 * Anything else rejected at submission is permanent for this signed tx.
 */
const RETRYABLE_CODES = new Set(["tx_bad_seq", "tx_insufficient_fee", "tx_too_early"]);

/** Maps an error thrown by `submitTransaction` to a {@link SubmitOutcome}. */
export function classifySubmitError(hash: string, err: unknown): SubmitOutcome {
  type ResultCodes = { transaction?: string; inner_transaction?: string };
  const response = (err as { response?: { status?: number; data?: { extras?: { result_codes?: ResultCodes } } } })
    ?.response;
  const codes = response?.data?.extras?.result_codes;
  // Stellar: a fee-bump wrapper reports tx_fee_bump_inner_failed; the inner code is what matters for retry.
  const code = codes?.transaction === "tx_fee_bump_inner_failed" ? (codes.inner_transaction ?? codes.transaction) : codes?.transaction;
  if (response?.status === 400 && code) {
    return { kind: "rejected", hash, code, retryable: RETRYABLE_CODES.has(code) };
  }
  return { kind: "unknown", hash, error: err instanceof Error ? err.message : String(err) };
}

/** The slice of the SDK's Horizon.Server we use; narrowed so tests can fake it. */
export type HorizonServerLike = Pick<Horizon.Server, "submitTransaction" | "transactions">;

/** Submits to and confirms against Horizon testnet. */
export class HorizonGateway implements Submitter, Confirmer {
  private readonly server: HorizonServerLike;

  constructor(server?: HorizonServerLike) {
    this.server = server ?? new Horizon.Server(HORIZON_URL);
  }

  async submit(xdr: string): Promise<SubmitOutcome> {
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    const hash = toHex(tx.hash());
    try {
      // Stellar: SEP-29 memo check costs extra account lookups; our payments always carry a memo.
      await this.server.submitTransaction(tx, { skipMemoRequiredCheck: true });
      return { kind: "accepted", hash };
    } catch (err) {
      return classifySubmitError(hash, err);
    }
  }

  async confirm(hash: string): Promise<Confirmation> {
    try {
      const tx = await this.server.transactions().transaction(hash).call();
      // Stellar: Horizon also finds a fee-bump tx by its inner hash, so either may match.
      if (tx.hash !== hash && tx.inner_transaction?.hash !== hash) {
        throw new Error(`Horizon returned ${tx.hash} for ${hash}`);
      }
      // Stellar: failed txs are also included in ledgers (fee charged), hence `successful`.
      return { found: true, hash, successful: tx.successful, ledger: tx.ledger_attr };
    } catch (err) {
      if (err instanceof NotFoundError) return { found: false, hash };
      throw err;
    }
  }
}

/**
 * Close time (unix seconds) of the latest ledger: the network's notion of "now".
 * Feed it to `NetworkClock.sync`.
 */
export async function fetchLatestLedgerCloseTime(
  server: Pick<Horizon.Server, "ledgers"> = new Horizon.Server(HORIZON_URL),
): Promise<number> {
  const page = await server.ledgers().order("desc").limit(1).call();
  const closedAt = page.records[0]?.closed_at;
  if (!closedAt) throw new Error("Horizon returned no ledgers");
  return Math.floor(Date.parse(closedAt) / 1000);
}
