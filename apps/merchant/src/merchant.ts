import {
  HorizonGateway,
  PaymentQueue,
  RelayerSubmitter,
  Settler,
  type NetworkClock,
  type SettlementReport,
  type TransitionListener,
} from "@ghostrail/core";
import { loadClock, syncClock } from "./clock";
import { RELAYER_URL } from "./config";
import { openQueueStore } from "./db";

export interface Merchant {
  queue: PaymentQueue;
  settler: Settler;
  /** Network-corrected clock; use `clock.now` for request expiry and verification. */
  clock: NetworkClock;
  /** Syncs the clock with Horizon and persists it. Resolves false when offline. */
  syncClock(): Promise<boolean>;
  /** Re-syncs the clock (best effort), then runs a settlement pass. */
  settle(): Promise<SettlementReport>;
}

/**
 * Wires core services for the app. Settlement is always confirmed against
 * Horizon directly, even when submitting through the relayer.
 *
 * TODO(triggers): call settle() from a NetInfo connectivity listener.
 */
export async function createMerchant(onTransition: TransitionListener): Promise<Merchant> {
  const clock = await loadClock();
  const queue = new PaymentQueue(await openQueueStore(), { onTransition, clock: clock.now });
  const horizon = new HorizonGateway();
  const submitter = RELAYER_URL ? new RelayerSubmitter(RELAYER_URL) : horizon;
  const settler = new Settler({ queue, submitter, confirmer: horizon, clock: clock.now });
  return {
    queue,
    settler,
    clock,
    syncClock: () => syncClock(clock),
    async settle() {
      await syncClock(clock);
      return settler.runOnce();
    },
  };
}
