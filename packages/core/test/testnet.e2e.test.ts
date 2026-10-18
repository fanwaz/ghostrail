import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  FRIENDBOT_URL,
  HORIZON_URL,
  HorizonGateway,
  PaymentQueue,
  Settler,
  SqlQueueStore,
  signPayment,
  systemClock,
  verifyPayment,
} from "../src/index.js";
import { nodeSqliteDriver } from "./helpers.js";

/**
 * Full offline → queue → settle round trip against the real Stellar testnet.
 * Opt-in because it needs the internet: GHOSTRAIL_TESTNET=1 pnpm test
 */
describe.runIf(process.env.GHOSTRAIL_TESTNET === "1")("testnet end-to-end", () => {
  it("settles an offline-signed payment only after Horizon confirms it", { timeout: 120_000 }, async () => {
    const customer = Keypair.random();
    const merchant = Keypair.random();
    for (const kp of [customer, merchant]) {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${kp.publicKey()}`);
      expect(res.ok).toBe(true);
    }

    // Online moment: the wallet caches its sequence number, and we sync to network
    // time because validators judge maxTime by ledger close time, not this machine's clock.
    const horizon = new Horizon.Server(HORIZON_URL);
    const sequence = (await horizon.loadAccount(customer.publicKey())).sequenceNumber();
    const serverDate = (await fetch(HORIZON_URL, { method: "HEAD" })).headers.get("date");
    const offset = Math.floor(Date.parse(serverDate!) / 1000) - systemClock();
    const clock = () => systemClock() + offset;

    // Offline: merchant asks, customer signs, merchant verifies and queues.
    const request = { v: 1 as const, id: "e2e-1", destination: merchant.publicKey(), amount: "1.5", asset: "native", expiresAt: clock() + 300 };
    const signed = signPayment({ request, signer: customer, account: { publicKey: customer.publicKey(), sequence }, clock });
    const queue = new PaymentQueue(await SqlQueueStore.open(nodeSqliteDriver()), { clock });
    const { record } = await queue.enqueue(verifyPayment(signed.xdr, request, clock));

    // Back online: settle.
    const gateway = new HorizonGateway();
    const report = await new Settler({ queue, submitter: gateway, confirmer: gateway, clock }).runOnce();

    expect(report.settled).toEqual([record.hash]);
    const settled = await queue.get(record.hash);
    expect(settled?.state).toBe("settled");
    expect(settled?.ledger).toBeGreaterThan(0);

    // Replaying the same envelope is harmless: Horizon already has the hash.
    expect(await gateway.confirm(record.hash)).toMatchObject({ found: true, successful: true });
  });
});
