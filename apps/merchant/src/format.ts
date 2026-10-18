import { fromStroops, type PayerSnapshot } from "@ghostrail/core";

/** "45s", "12 min", "3 h", "2 d". Negative spans (clock moved backwards) read as "0s". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** Stroops → "99.9999" (Stellar's 7 decimals, trailing zeros dropped). */
export function formatAmount(stroops: string): string {
  return fromStroops(BigInt(stroops)).replace(/\.?0+$/, "");
}

/**
 * "Last known balance 99.9999 XLM, synced 12 min ago". The wording is deliberate:
 * it's a cached figure, and other spending since the sync is invisible offline.
 */
export function formatLastKnownBalance(snapshot: PayerSnapshot, now: number, asset = "native"): string {
  const stroops = snapshot.balances[asset] ?? "0";
  const label = asset === "native" ? "XLM" : asset.split(":")[0];
  return `Last known balance ${formatAmount(stroops)} ${label}, synced ${formatAgo(now - snapshot.syncedAt)} ago`;
}
