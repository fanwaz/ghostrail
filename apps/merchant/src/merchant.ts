import {
  HorizonGateway,
  PaymentQueue,
  RelayerSubmitter,
  Settler,
  type TransitionListener,
} from "@ghostrail/core";
import { RELAYER_URL } from "./config";
import { openQueueStore } from "./db";

export interface Merchant {
  queue: PaymentQueue;
  settler: Settler;
}

/**
 * Wires core services for the app. Settlement is always confirmed against
 * Horizon directly, even when submitting through the relayer.
 *
 * TODO(triggers): call settler.runOnce() from a NetInfo connectivity listener.
 */
export async function createMerchant(onTransition: TransitionListener): Promise<Merchant> {
  const queue = new PaymentQueue(await openQueueStore(), { onTransition });
  const horizon = new HorizonGateway();
  const submitter = RELAYER_URL ? new RelayerSubmitter(RELAYER_URL) : horizon;
  return { queue, settler: new Settler({ queue, submitter, confirmer: horizon }) };
}
