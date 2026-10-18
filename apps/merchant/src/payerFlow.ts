import { GhostRailError, decodeRequest, type PaymentRequest } from "@ghostrail/core";

export interface RequestReview {
  request: PaymentRequest;
  /** Seconds left before the request (and the tx's maxTime) expires, in network time. */
  expiresInSeconds: number;
}

/**
 * Checks a scanned payment request before the payer is asked to sign it:
 * well-formed (decodeRequest), not expired by the payer's network clock, and
 * not addressed to the payer. Balance and sequence are checked by PayerWallet.pay.
 */
export function reviewRequest(scanned: string, now: number, payerPublicKey: string): RequestReview {
  const request = decodeRequest(scanned.trim());
  if (request.expiresAt <= now) throw new GhostRailError("EXPIRED", "This payment request has expired");
  if (request.destination === payerPublicKey) {
    throw new GhostRailError("INVALID_REQUEST", "This request pays your own account");
  }
  return { request, expiresInSeconds: request.expiresAt - now };
}
