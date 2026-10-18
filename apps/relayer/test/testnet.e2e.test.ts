import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FRIENDBOT_URL,
  HorizonGateway,
  MemoryPayerStore,
  MemoryQueueStore,
  NetworkClock,
  PayerWallet,
  PaymentQueue,
  RelayerSubmitter,
  Settler,
  fetchLatestLedgerCloseTime,
  horizonPayerSource,
  verifySignedPayment,
} from "@ghostrail/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

/** Opt-in: GHOSTRAIL_TESTNET=1 pnpm test */
describe.runIf(process.env.GHOSTRAIL_TESTNET === "1")("relayer on testnet", () => {
  it("settles a fee-bumped payment, confirmed by the customer's inner hash", { timeout: 120_000 }, async () => {
    const [customer, merchant, sponsor] = [Keypair.random(), Keypair.random(), Keypair.random()];
    for (const kp of [customer, merchant, sponsor]) {
      expect((await fetch(`${FRIENDBOT_URL}?addr=${kp.publicKey()}`)).ok).toBe(true);
    }

    const clock = new NetworkClock();
    await clock.sync(() => fetchLatestLedgerCloseTime());
    const horizon = new HorizonGateway();
    const app = buildApp({ submitter: horizon, confirmer: horizon, sponsor, clock: clock.now });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const wallet = new PayerWallet(new MemoryPayerStore(), customer);
      await wallet.sync(horizonPayerSource());
      const request = { v: 1 as const, id: "relay-e2e", destination: merchant.publicKey(), amount: "2", asset: "native", expiresAt: clock.now() + 300 };
      const signed = await wallet.pay(request);

      const queue = new PaymentQueue(new MemoryQueueStore(), { clock: clock.now });
      const { record } = await queue.enqueue(verifySignedPayment(signed.xdr, request, clock.now));
      const relayUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const report = await new Settler({
        queue,
        submitter: new RelayerSubmitter(relayUrl),
        confirmer: horizon, // settlement is always confirmed against Horizon, not the relayer
        clock: clock.now,
      }).runOnce();

      expect(report.settled).toEqual([record.hash]);
      const status = await (await fetch(`${relayUrl}/status/${record.hash}`)).json();
      expect(status).toMatchObject({ found: true, hash: record.hash, successful: true });
    } finally {
      await app.close();
    }
  });
});
