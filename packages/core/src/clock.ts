/**
 * Injected time source, in unix seconds, so expiry logic is deterministic in tests.
 *
 * Device clocks drift and are often misconfigured, while Stellar validators
 * judge time bounds by ledger close time. TODO(clock-sync): when online, record
 * the offset from Horizon's `Date` header (like the cached sequence number) and
 * build the app's Clock from it.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
