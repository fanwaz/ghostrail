/** Machine-readable reason codes so UIs and contributors can branch on them. */
export type GhostRailErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_TRANSACTION"
  | "WRONG_NETWORK"
  | "BAD_SIGNATURE"
  | "MISMATCH"
  | "EXPIRED"
  | "MISSING_TIME_BOUNDS"
  | "DUPLICATE"
  | "INVALID_TRANSITION"
  | "STALE_STATE"
  | "NOT_FOUND"
  | "NOT_SYNCED"
  | "INSUFFICIENT_BALANCE";

export class GhostRailError extends Error {
  constructor(
    readonly code: GhostRailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GhostRailError";
  }
}
