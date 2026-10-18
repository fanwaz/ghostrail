import * as SecureStore from "expo-secure-store";
import { NetworkClock, fetchLatestLedgerCloseTime, type NetworkTimeSource } from "@ghostrail/core";

const CLOCK_KEY = "ghostrail.clock";

interface StoredClock {
  offsetSeconds: number;
  syncedAt: number;
}

/**
 * A NetworkClock restored from the last successful sync, so it is correct
 * while offline. With nothing stored, the clock is unsynced and
 * `clock.assertSynced()` blocks request creation until the first sync.
 */
export async function loadClock(): Promise<NetworkClock> {
  const stored = parse(await SecureStore.getItemAsync(CLOCK_KEY));
  return stored ? new NetworkClock(stored.offsetSeconds, undefined, stored.syncedAt) : new NetworkClock();
}

/** Re-measures the offset from Horizon's latest ledger and persists it. Best effort: false when offline. */
export async function syncClock(
  clock: NetworkClock,
  source: NetworkTimeSource = () => fetchLatestLedgerCloseTime(),
): Promise<boolean> {
  try {
    await clock.sync(source);
    const stored: StoredClock = { offsetSeconds: clock.offsetSeconds, syncedAt: clock.syncedAt! };
    await SecureStore.setItemAsync(CLOCK_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

function parse(raw: string | null): StoredClock | null {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<StoredClock> | null;
    return Number.isSafeInteger(value?.offsetSeconds) && Number.isSafeInteger(value?.syncedAt) ? (value as StoredClock) : null;
  } catch {
    return null;
  }
}
