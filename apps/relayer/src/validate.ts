import { FeeBumpTransaction, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { GhostRailError, NETWORK_PASSPHRASE, isPastExpiry, toHex, type Clock } from "@ghostrail/core";

/**
 * Cheap checks before spending a Horizon call. The relayer does not know the
 * merchant's payment request, so it checks shape, network, and expiry only;
 * the merchant has already verified amount/destination/memo with verifySignedPayment.
 *
 * Returns the parsed tx and its hash (the idempotency key).
 * TODO(policy): allow-list destinations or assets per merchant API key.
 */
export function validateForRelay(xdr: string, clock: Clock): { hash: string; tx: Transaction } {
  let tx;
  try {
    // Stellar: parsing with the testnet passphrase pins the hash to testnet.
    tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  } catch {
    throw new GhostRailError("INVALID_TRANSACTION", "Not a valid transaction envelope");
  }
  if (tx instanceof FeeBumpTransaction) {
    throw new GhostRailError("INVALID_TRANSACTION", "Fee-bump envelopes are not relayed");
  }
  if (tx.signatures.length === 0) throw new GhostRailError("BAD_SIGNATURE", "Transaction is unsigned");
  if (tx.operations.length === 0 || tx.operations.some((op) => op.type !== "payment")) {
    throw new GhostRailError("INVALID_TRANSACTION", "Only payment operations are relayed");
  }
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime === 0) throw new GhostRailError("MISSING_TIME_BOUNDS", "Transaction must have a maxTime");
  if (isPastExpiry(maxTime, clock())) throw new GhostRailError("EXPIRED", "Transaction has expired");
  return { hash: toHex(tx.hash()), tx };
}
