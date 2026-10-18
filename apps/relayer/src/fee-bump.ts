import { TransactionBuilder, type Keypair, type Transaction } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, toHex } from "@ghostrail/core";

/** Per-operation fee the sponsor offers, in stroops: 2× the customer's offline fee. */
export const DEFAULT_FEE_BUMP_BASE_FEE = 2_000;

/**
 * Wraps a customer's signed tx in a fee-bump paid by the relayer's sponsor.
 *
 * Stellar: a fee bump replaces who pays the fee without touching the inner
 * signature, and validators accept it only if its per-op fee is at least the
 * inner one. The inner hash stays the idempotency key: Horizon finds the
 * wrapper by it, and the wrapper is deterministic (same inputs, same hash).
 */
export function wrapInFeeBump(
  inner: Transaction,
  sponsor: Keypair,
  baseFee = DEFAULT_FEE_BUMP_BASE_FEE,
): { xdr: string; hash: string } {
  const innerPerOp = Math.ceil(Number(inner.fee) / inner.operations.length);
  const fee = String(Math.max(baseFee, innerPerOp));
  const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, fee, inner, NETWORK_PASSPHRASE);
  bump.sign(sponsor);
  return { xdr: bump.toEnvelope().toXDR("base64"), hash: toHex(bump.hash()) };
}
