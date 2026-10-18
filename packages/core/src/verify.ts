import { FeeBumpTransaction, Keypair, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { toStroops } from "./amount.js";
import { assetToRef, parseAsset } from "./asset.js";
import { bytesEqual, toHex } from "./bytes.js";
import { systemClock, type Clock } from "./clock.js";
import { GhostRailError } from "./errors.js";
import { NETWORK_PASSPHRASE } from "./network.js";
import type { PaymentRequest } from "./request.js";

/** A signed payment that passed every offline check and may be queued. */
export interface VerifiedPayment {
  hash: string;
  xdr: string;
  requestId: string;
  source: string;
  destination: string;
  amount: string;
  asset: string;
  sequence: string;
  maxTime: number;
}

/**
 * Offline verification a merchant runs before accepting a signed payment.
 *
 * What this proves: the tx is well-formed for testnet, pays exactly what was
 * requested, expires no later than the request, and carries a valid signature
 * from the source account's master key.
 *
 * What it cannot prove offline: that the customer has the funds, that the
 * cached sequence is current, or that the master key still has signing weight.
 * Those are only known once Horizon confirms the hash.
 *
 * TODO(risk): plug an optional online pre-check (balance/sequence) here when
 * connectivity is available at acceptance time.
 */
export function verifySignedPayment(xdr: string, request: PaymentRequest, clock: Clock = systemClock): VerifiedPayment {
  const tx = parseTransaction(xdr);
  const fail = (code: "MISMATCH" | "INVALID_TRANSACTION", why: string): never => {
    throw new GhostRailError(code, why);
  };

  if (!StrKey.isValidEd25519PublicKey(tx.source)) fail("INVALID_TRANSACTION", "Muxed or invalid source account");
  if (tx.operations.length !== 1) fail("INVALID_TRANSACTION", "Expected exactly one operation");
  const op = tx.operations[0]!;
  if (op.type !== "payment") return fail("INVALID_TRANSACTION", `Unsupported operation ${op.type}`);
  if (op.source !== undefined && op.source !== tx.source) fail("INVALID_TRANSACTION", "Operation source differs from tx source");

  if (op.destination !== request.destination) fail("MISMATCH", "Destination does not match request");
  if (assetToRef(op.asset) !== assetToRef(parseAsset(request.asset))) fail("MISMATCH", "Asset does not match request");
  if (toStroops(op.amount) !== toStroops(request.amount)) fail("MISMATCH", "Amount does not match request");
  if (tx.memo.type !== "text" || memoText(tx.memo.value) !== request.id) fail("MISMATCH", "Memo does not match request id");

  const maxTime = checkTimeBounds(tx, request, clock);
  checkSignature(tx);

  return {
    hash: toHex(tx.hash()),
    xdr,
    requestId: request.id,
    source: tx.source,
    destination: op.destination,
    amount: op.amount,
    asset: assetToRef(op.asset),
    sequence: tx.sequence,
    maxTime,
  };
}

function parseTransaction(xdr: string): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    // Stellar: parsing with the testnet passphrase means hash() and signature checks are testnet-bound.
    parsed = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  } catch {
    throw new GhostRailError("INVALID_TRANSACTION", "Not a valid transaction envelope");
  }
  if (parsed instanceof FeeBumpTransaction) {
    // TODO(fee-bump): a relayer may wrap payments; merchants accept only the inner tx today.
    throw new GhostRailError("INVALID_TRANSACTION", "Fee-bump envelopes are not accepted from customers");
  }
  return parsed;
}

function checkTimeBounds(tx: Transaction, request: PaymentRequest, clock: Clock): number {
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  // Stellar: maxTime 0 means "never expires", which would defeat expiry entirely.
  if (maxTime === 0) throw new GhostRailError("MISSING_TIME_BOUNDS", "Transaction must have a maxTime");
  if (maxTime > request.expiresAt) throw new GhostRailError("MISMATCH", "Transaction outlives the request");
  if (maxTime <= clock()) throw new GhostRailError("EXPIRED", "Transaction has already expired");
  return maxTime;
}

function checkSignature(tx: Transaction): void {
  const key = Keypair.fromPublicKey(tx.source);
  const hash = tx.hash();
  const signed = tx.signatures.some(
    (sig) => bytesEqual(sig.hint.toBytes(), key.signatureHint()) && key.verify(hash, sig.signature),
  );
  if (!signed) throw new GhostRailError("BAD_SIGNATURE", "Missing a valid signature from the source account");
}

function memoText(value: unknown): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array);
}
