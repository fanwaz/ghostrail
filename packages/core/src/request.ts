import { StrKey } from "@stellar/stellar-sdk";
import { toStroops } from "./amount.js";
import { parseAsset, type AssetRef } from "./asset.js";
import { GhostRailError } from "./errors.js";

/**
 * What a merchant shows the customer (typically as a QR code) to ask for a payment.
 * The customer's wallet turns it into a signed transaction with {@link signPayment}.
 */
export interface PaymentRequest {
  /** Payload version; bump when the shape changes. */
  v: 1;
  /** Merchant-chosen id. Becomes the tx memo, so it must fit Stellar's 28-byte text memo. */
  id: string;
  /** Merchant's Stellar account (G...). */
  destination: string;
  /** Decimal amount, up to 7 decimal places. */
  amount: string;
  asset: AssetRef;
  /** Unix seconds after which the payment must not settle. Becomes the tx maxTime. */
  expiresAt: number;
}

const REQUEST_PREFIX = "ghostrail:req:v1:";
/** Stellar: MEMO_TEXT is capped at 28 bytes. */
const MAX_MEMO_BYTES = 28;

/** Validates an untrusted object and returns it typed, or throws INVALID_REQUEST. */
export function validateRequest(input: unknown): PaymentRequest {
  const r = input as Partial<PaymentRequest> | null;
  const fail = (why: string): never => {
    throw new GhostRailError("INVALID_REQUEST", `Invalid payment request: ${why}`);
  };
  if (typeof r !== "object" || r === null) return fail("not an object");
  if (r.v !== 1) fail("unsupported version");
  if (typeof r.id !== "string" || r.id.length === 0) fail("missing id");
  if (new TextEncoder().encode(r.id!).length > MAX_MEMO_BYTES) fail(`id longer than ${MAX_MEMO_BYTES} bytes`);
  if (typeof r.destination !== "string" || !StrKey.isValidEd25519PublicKey(r.destination)) fail("bad destination");
  if (typeof r.amount !== "string") fail("missing amount");
  toStroops(r.amount!);
  if (typeof r.asset !== "string") fail("missing asset");
  parseAsset(r.asset!);
  if (!Number.isSafeInteger(r.expiresAt) || r.expiresAt! <= 0) fail("bad expiresAt");
  return { v: 1, id: r.id!, destination: r.destination!, amount: r.amount!, asset: r.asset!, expiresAt: r.expiresAt! };
}

/** Encodes a request into a compact string suitable for a QR code. */
export function encodeRequest(request: PaymentRequest): string {
  const json = JSON.stringify(validateRequest(request));
  return REQUEST_PREFIX + base64UrlEncode(new TextEncoder().encode(json));
}

export function decodeRequest(encoded: string): PaymentRequest {
  if (!encoded.startsWith(REQUEST_PREFIX)) {
    throw new GhostRailError("INVALID_REQUEST", "Not a GhostRail payment request");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded.slice(REQUEST_PREFIX.length))));
  } catch {
    throw new GhostRailError("INVALID_REQUEST", "Malformed payment request payload");
  }
  return validateRequest(parsed);
}

// btoa/atob exist in Node >= 16 and Hermes, so core stays free of Buffer.
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
