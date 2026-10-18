import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  FRIENDBOT_URL,
  HorizonGateway,
  MemoryPayerStore,
  NetworkClock,
  PayerWallet,
  PaymentQueue,
  Settler,
  SqlQueueStore,
  fetchLatestLedgerCloseTime,
  horizonPayerSource,
  verifySignedPayment,
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

    // Online moment: both sides sync to network time; the payer also caches sequence and balance.
    const merchantClock = new NetworkClock();
    await merchantClock.sync(() => fetchLatestLedgerCloseTime());
    const wallet = new PayerWallet(new MemoryPayerStore(), customer);
    const synced = await wallet.sync(horizonPayerSource());
    expect(BigInt(synced.balances.native!)).toBeGreaterThan(0n);

    // Offline: merchant asks, customer signs, merchant verifies and queues.
    const clock = merchantClock.now;
    const request = { v: 1 as const, id: "e2e-1", destination: merchant.publicKey(), amount: "1.5", asset: "native", expiresAt: clock() + 300 };
    const signed = await wallet.pay(request);
    const queue = new PaymentQueue(await SqlQueueStore.open(nodeSqliteDriver()), { clock });
    const { record } = await queue.enqueue(verifySignedPayment(signed.xdr, request, clock));

    // Back online: settle.
    const gateway = new HorizonGateway();
    const report = await new Settler({ queue, submitter: gateway, confirmer: gateway, clock }).runOnce();

    expect(report.settled).toEqual([record.hash]);
    const settled = await queue.get(record.hash);
    expect(settled?.state).toBe("settled");
    expect(settled?.ledger).toBeGreaterThan(0);

    // Re-syncing clears the pending debit and keeps the sequence in step with the network.
    const after = await wallet.sync(horizonPayerSource());
    expect(after.pending).toEqual([]);
    expect(after.sequence).toBe(signed.nextSequence);
  });
});
