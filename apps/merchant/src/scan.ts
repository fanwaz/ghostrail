const REQUEST_PREFIX = "ghostrail:req:";
/** Base64 alphabet; a payment TransactionEnvelope XDR is a few hundred of these. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ScanResult =
  | { kind: "payment"; xdr: string }
  /** The merchant scanned a payment request (likely their own QR) instead of a signed payment. */
  | { kind: "request" }
  | { kind: "unknown" };

/**
 * Classifies a scanned QR payload. Deliberately shallow: full validation is
 * verifySignedPayment's job, so this only routes the data.
 */
export function classifyScan(data: string): ScanResult {
  const text = data.trim();
  if (text.startsWith(REQUEST_PREFIX)) return { kind: "request" };
  if (text.length > 0 && text.length % 4 === 0 && BASE64_RE.test(text)) return { kind: "payment", xdr: text };
  return { kind: "unknown" };
}
