import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  MemoryPayerStore,
  PayerWallet,
  SqlPayerStore,
  spendableBalances,
  verifySignedPayment,
  type HorizonAccountLike,
  type PayerStore,
  type PayerSyncSource,
} from "../src/index.js";
import { NOW, makeRequest, nodeSqliteDriver } from "./helpers.js";

const issuer = Keypair.random().publicKey();

function account(overrides: Partial<HorizonAccountLike> = {}): HorizonAccountLike {
  return {
    sequence: "100",
    subentry_count: 0,
    balances: [{ asset_type: "native", balance: "101.0000000", selling_liabilities: "0.0000000" }],
    ...overrides,
  };
}

function source(state: { account: HorizonAccountLike; networkTime: number }): PayerSyncSource {
  return { loadAccount: async () => state.account, networkTime: async () => state.networkTime };
}

function setup(store: PayerStore = new MemoryPayerStore(), deviceNow = NOW) {
  const signer = Keypair.random();
  const device = { now: deviceNow };
  const wallet = new PayerWallet(store, signer, () => device.now);
  return { signer, wallet, store, device };
}

describe("spendableBalances", () => {
  it("subtracts the base reserve and selling liabilities", () => {
    const balances = spendableBalances(
      account({
        subentry_count: 1,
        num_sponsoring: 1,
        num_sponsored: 1,
        balances: [
          { asset_type: "native", balance: "10.0000000", selling_liabilities: "1.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "5.0000000", selling_liabilities: "0.5000000" },
          { asset_type: "liquidity_pool_shares", balance: "3.0000000" },
        ],
      }),
    );
    // 10 − 1 liabilities − (2 + 1 + 1 − 1) × 0.5 reserve = 7.5
    expect(balances).toEqual({ native: 75_000_000n, [`USDC:${issuer}`]: 45_000_000n });
  });

  it("never reports a negative balance", () => {
    expect(spendableBalances(account({ balances: [{ asset_type: "native", balance: "0.5000000" }] })).native).toBe(0n);
  });
});

describe("PayerWallet", () => {
  it("caches sequence, balance, timestamp and clock offset on sync", async () => {
    const { wallet } = setup(undefined, NOW - 4 * 3600); // device clock 4 h behind
    const snap = await wallet.sync(source({ account: account(), networkTime: NOW }));
    expect(snap).toMatchObject({
      sequence: "100",
      balances: { native: "1000000000" }, // 101 − 1 reserve
      syncedAt: NOW,
      clockOffsetSeconds: 4 * 3600,
      pending: [],
    });
  });

  it("refuses to sign before the first sync", async () => {
    const { wallet } = setup();
    await expect(wallet.pay(makeRequest())).rejects.toMatchObject({ code: "NOT_SYNCED", message: expect.stringMatching(/^Connect once to sync/) });
  });

  it("increments the cached sequence and debits amount + fee after each signing", async () => {
    const { wallet } = setup();
    await wallet.sync(source({ account: account(), networkTime: NOW }));

    const first = await wallet.pay(makeRequest({ id: "a", amount: "10" }));
    const second = await wallet.pay(makeRequest({ id: "b", amount: "20" }));

    expect(first.nextSequence).toBe("101");
    expect(second.nextSequence).toBe("102");
    const snap = await wallet.snapshot();
    expect(snap?.sequence).toBe("102");
    // 100 − 10 − 20 − 2 × 0.0001 fee
    expect(snap?.balances.native).toBe(String(700_000_000n - 2000n));
    expect(snap?.pending.map((p) => p.sequence)).toEqual(["101", "102"]);
  });

  it("persists the new sequence before returning the signed tx", async () => {
    const saved: string[] = [];
    const inner = new MemoryPayerStore();
    const store: PayerStore = {
      load: () => inner.load(),
      save: async (s) => {
        saved.push(s.sequence);
        await inner.save(s);
      },
    };
    const { wallet } = setup(store);
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    saved.length = 0;

    const signed = await wallet.pay(makeRequest());
    expect(saved).toEqual([signed.nextSequence]);
  });

  it("never signs two payments with the same sequence, even concurrently", async () => {
    const { wallet } = setup();
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    const results = await Promise.all([1, 2, 3].map((i) => wallet.pay(makeRequest({ id: `c${i}`, amount: "1" }))));
    expect(new Set(results.map((r) => r.nextSequence)).size).toBe(3);
  });

  it("does not consume a sequence when signing fails", async () => {
    const { wallet } = setup();
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    await expect(wallet.pay(makeRequest({ expiresAt: NOW - 1 }))).rejects.toMatchObject({ code: "EXPIRED" });
    expect((await wallet.snapshot())?.sequence).toBe("100");
  });

  it("rejects payments above the cached balance", async () => {
    const { wallet } = setup();
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    await expect(wallet.pay(makeRequest({ amount: "100" }))).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await expect(wallet.pay(makeRequest({ asset: `USDC:${issuer}` }))).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });

  it("keeps pending debits and the higher sequence across a sync until Horizon catches up", async () => {
    const { wallet } = setup();
    const state = { account: account(), networkTime: NOW };
    await wallet.sync(source(state));
    await wallet.pay(makeRequest({ id: "a", amount: "10" })); // seq 101
    await wallet.pay(makeRequest({ id: "b", amount: "20" })); // seq 102

    // Horizon has seen only the first payment.
    state.account = account({ sequence: "101", balances: [{ asset_type: "native", balance: "90.9999000" }] });
    const snap = await wallet.sync(source(state));
    expect(snap.sequence).toBe("102");
    expect(snap.pending.map((p) => p.sequence)).toEqual(["102"]);
    // 90.9999 − 1 reserve − 20 − 0.0001 fee for the pending one
    expect(snap.balances.native).toBe(String(699_998_000n));
  });

  it("signs with the synced clock so time bounds match network time", async () => {
    const { wallet, device } = setup(undefined, NOW - 4 * 3600);
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    device.now += 60; // still offline, a minute later
    const request = makeRequest({ expiresAt: NOW + 600 });
    // Device time says the request expires in 4h10m; network time says 9 minutes. Either way it is valid now.
    const signed = await wallet.pay(request);
    expect(verifySignedPayment(signed.xdr, request, await wallet.clock()).maxTime).toBe(NOW + 600);
    expect((await wallet.clock())()).toBe(NOW + 60);
  });

  it("refuses a request that the network clock says has expired, even if the device clock disagrees", async () => {
    const { wallet } = setup(undefined, NOW - 4 * 3600);
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    await expect(wallet.pay(makeRequest({ expiresAt: NOW - 10 }))).rejects.toMatchObject({ code: "EXPIRED" });
  });
});

describe("PayerWallet pending pruning (bounded state)", () => {
  it("records each payment's maxTime", async () => {
    const { wallet } = setup();
    await wallet.sync(source({ account: account(), networkTime: NOW }));
    await wallet.pay(makeRequest({ expiresAt: NOW + 300 }));
    expect((await wallet.snapshot())?.pending[0]?.maxTime).toBe(NOW + 300);
  });

  it("voids debits and frees sequences once every pending payment has expired unlanded", async () => {
    const { wallet } = setup();
    const state = { account: account(), networkTime: NOW };
    await wallet.sync(source(state));
    await wallet.pay(makeRequest({ id: "a", amount: "10", expiresAt: NOW + 300 }));
    await wallet.pay(makeRequest({ id: "b", amount: "20", expiresAt: NOW + 600 }));

    state.networkTime = NOW + 600 + 61; // past both maxTimes + grace; Horizon still at sequence 100
    const snap = await wallet.sync(source(state));
    expect(snap.pending).toEqual([]);
    expect(snap.sequence).toBe("100");
    expect(snap.balances.native).toBe("1000000000"); // nothing deducted: neither payment can land
  });

  it("keeps every pending debit while any is still live (reusing a lower sequence would be unsafe)", async () => {
    const { wallet } = setup();
    const state = { account: account(), networkTime: NOW };
    await wallet.sync(source(state));
    await wallet.pay(makeRequest({ id: "a", amount: "10", expiresAt: NOW + 300 }));
    await wallet.pay(makeRequest({ id: "b", amount: "20", expiresAt: NOW + 3600 }));

    state.networkTime = NOW + 1000; // first expired, second still live
    const snap = await wallet.sync(source(state));
    expect(snap.pending.map((p) => p.sequence)).toEqual(["101", "102"]);
    expect(snap.sequence).toBe("102");
  });

  it("never expires legacy entries without a maxTime", async () => {
    const store = new MemoryPayerStore();
    await store.save({
      publicKey: "ignored",
      sequence: "101",
      balances: { native: "0" },
      syncedAt: NOW,
      clockOffsetSeconds: 0,
      pending: [{ sequence: "101", asset: "native", amount: "1", fee: "1000", maxTime: null }],
    });
    const { wallet } = setup(store);
    const snap = await wallet.sync(source({ account: account(), networkTime: NOW + 999_999 }));
    expect(snap.pending.map((p) => p.sequence)).toEqual(["101"]);
  });

  it("stored state does not grow across repeated offline rounds that expire unlanded", async () => {
    const driver = nodeSqliteDriver();
    const { wallet } = setup(await SqlPayerStore.open(driver));
    const size = async () =>
      Number((await driver.execute("SELECT length(balances) + length(pending) AS n FROM payer_state")).rows[0]!.n);
    const state = { account: account(), networkTime: NOW };
    await wallet.sync(source(state));
    const baseline = await size();

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) {
        await wallet.pay(makeRequest({ id: `r${round}-${i}`, amount: "1", expiresAt: state.networkTime + 300 }));
      }
      expect(await size()).toBeGreaterThan(baseline); // grows while offline, by design
      state.networkTime += 1000; // all five expire unlanded
      await wallet.sync(source(state));
      expect(await size()).toBe(baseline);
    }
  });

  it("stored state does not grow when payments land", async () => {
    const driver = nodeSqliteDriver();
    const { wallet } = setup(await SqlPayerStore.open(driver));
    const size = async () =>
      Number((await driver.execute("SELECT length(pending) AS n FROM payer_state")).rows[0]!.n);
    const state = { account: account(), networkTime: NOW };
    await wallet.sync(source(state));
    const baseline = await size();
    for (let i = 0; i < 5; i++) await wallet.pay(makeRequest({ id: `l${i}`, amount: "1" }));
    state.account = account({ sequence: "105" }); // all five landed
    await wallet.sync(source(state));
    expect(await size()).toBe(baseline);
  });
});
