import { GhostRailError } from "./errors.js";

/** Shown wherever signing or request creation is blocked on a first sync. */
export const CLOCK_NOT_SYNCED_MESSAGE = "Connect once to sync the clock with the Stellar network";

/** Injected time source, in unix seconds, so expiry logic is deterministic in tests. */
export type Clock = () => number;

export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

/** Resolves to the network's current time in unix seconds (see `fetchLatestLedgerCloseTime`). */
export type NetworkTimeSource = () => Promise<number>;

/**
 * Device time corrected by an offset measured against the Stellar network.
 *
 * Stellar: validators judge time bounds by ledger close time, not by the
 * device clock, which is often wrong. Sync whenever online, persist
 * `offsetSeconds`, and pass it back in on the next launch so expiry and time
 * bounds stay correct while offline.
 *
 * Limitation: the offset is relative to the device's wall clock, so if the
 * user changes that clock (or it jumps) while offline, `now()` moves with it.
 * TODO(clock-monotonic): at sync, also record a monotonic uptime reading
 * (e.g. Android SystemClock.elapsedRealtime / iOS mach_continuous_time, via a
 * native module). Later, compare elapsed wall time with elapsed uptime; a
 * mismatch beyond a few seconds means the wall clock changed, so require a
 * re-sync (or correct by the uptime delta). A reboot resets uptime, which by
 * itself should also force a re-sync.
 */
export class NetworkClock {
  private offset: number;
  private lastSync: number | null;

  /**
   * @param offsetSeconds persisted offset from an earlier sync
   * @param syncedAt network time of that sync; null means this device has never synced
   */
  constructor(
    offsetSeconds = 0,
    private readonly base: Clock = systemClock,
    syncedAt: number | null = null,
  ) {
    this.offset = offsetSeconds;
    this.lastSync = syncedAt;
  }

  /** The corrected clock. Pass this wherever a `Clock` is expected. */
  readonly now: Clock = () => this.base() + this.offset;

  get offsetSeconds(): number {
    return this.offset;
  }

  /** Network time (unix seconds) of the last successful sync, or null if never synced. */
  get syncedAt(): number | null {
    return this.lastSync;
  }

  get isSynced(): boolean {
    return this.lastSync !== null;
  }

  /** Throws CLOCK_NOT_SYNCED until the first successful sync. Call before signing or creating requests. */
  assertSynced(): void {
    if (!this.isSynced) throw new GhostRailError("CLOCK_NOT_SYNCED", CLOCK_NOT_SYNCED_MESSAGE);
  }

  /** Re-measures the offset. Rejects (keeping the old offset) if the source fails. */
  async sync(source: NetworkTimeSource): Promise<number> {
    const networkTime = await source();
    if (!Number.isSafeInteger(networkTime) || networkTime <= 0) {
      throw new Error(`Invalid network time ${networkTime}`);
    }
    this.offset = networkTime - this.base();
    this.lastSync = networkTime;
    return this.offset;
  }
}
