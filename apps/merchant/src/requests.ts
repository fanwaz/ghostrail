import { encodeRequest, type NetworkClock, type PaymentRequest } from "@ghostrail/core";
import { MERCHANT_ADDRESS, REQUEST_TTL_SECONDS } from "./config";

/**
 * Builds a payment request whose expiry is in network time. Throws
 * CLOCK_NOT_SYNCED ("Connect once to sync…") until the clock has synced once,
 * because an unsynced device could hand out requests that are already expired
 * on-network, or valid for far longer than intended.
 */
export function createPaymentRequest(
  clock: NetworkClock,
  amount: string,
  destination: string = MERCHANT_ADDRESS,
): PaymentRequest {
  clock.assertSynced();
  const now = clock.now();
  const request: PaymentRequest = {
    v: 1,
    id: `r-${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`,
    destination,
    amount,
    asset: "native",
    expiresAt: now + REQUEST_TTL_SECONDS,
  };
  encodeRequest(request); // validates amount, destination and id length
  return request;
}
