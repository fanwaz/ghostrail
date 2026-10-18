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
 */
export class NetworkClock {
  private offset: number;

  constructor(
    offsetSeconds = 0,
    private readonly base: Clock = systemClock,
  ) {
    this.offset = offsetSeconds;
  }

  /** The corrected clock. Pass this wherever a `Clock` is expected. */
  readonly now: Clock = () => this.base() + this.offset;

  get offsetSeconds(): number {
    return this.offset;
  }

  /** Re-measures the offset. Rejects (keeping the old offset) if the source fails. */
  async sync(source: NetworkTimeSource): Promise<number> {
    const networkTime = await source();
    if (!Number.isSafeInteger(networkTime) || networkTime <= 0) {
      throw new Error(`Invalid network time ${networkTime}`);
    }
    this.offset = networkTime - this.base();
    return this.offset;
  }
}
