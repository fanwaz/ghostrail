import * as SecureStore from "expo-secure-store";
import { NetworkClock, fetchLatestLedgerCloseTime, type NetworkTimeSource } from "@ghostrail/core";

const OFFSET_KEY = "ghostrail.clock-offset";

/** A NetworkClock restored from the last persisted offset, so it is correct while offline. */
export async function loadClock(): Promise<NetworkClock> {
  const stored = Number(await SecureStore.getItemAsync(OFFSET_KEY));
  return new NetworkClock(Number.isFinite(stored) ? stored : 0);
}

/** Re-measures the offset from Horizon's latest ledger and persists it. Best effort: false when offline. */
export async function syncClock(
  clock: NetworkClock,
  source: NetworkTimeSource = () => fetchLatestLedgerCloseTime(),
): Promise<boolean> {
  try {
    await clock.sync(source);
    await SecureStore.setItemAsync(OFFSET_KEY, String(clock.offsetSeconds));
    return true;
  } catch {
    return false;
  }
}
