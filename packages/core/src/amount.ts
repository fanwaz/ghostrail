import { GhostRailError } from "./errors.js";

/** Stellar: amounts are int64 stroops (1 XLM = 10^7 stroops); we compare in stroops, never floats. */
const STROOPS_PER_UNIT = 10_000_000n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

/** Parses a positive decimal amount string ("12.5") into stroops. Throws on anything else. */
export function toStroops(amount: string): bigint {
  const match = AMOUNT_RE.exec(amount);
  if (!match) throw new GhostRailError("INVALID_REQUEST", `Invalid amount "${amount}"`);
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? "").padEnd(7, "0"));
  const stroops = whole * STROOPS_PER_UNIT + frac;
  if (stroops <= 0n || stroops > INT64_MAX) {
    throw new GhostRailError("INVALID_REQUEST", `Amount out of range "${amount}"`);
  }
  return stroops;
}

/** Formats stroops back into Stellar's canonical 7-decimal string. */
export function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}
