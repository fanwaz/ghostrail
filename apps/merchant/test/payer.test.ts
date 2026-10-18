import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeRequest,
  verifySignedPayment,
  type HorizonAccountLike,
  type PayerSyncSource,
  type PaymentRequest,
} from "@ghostrail/core";

const secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
}));
let seed = 0;
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, () => (seed++ * 37) % 256) }));

const { createPayer, fundWithFriendbot, loadPayerKeypair, SecureStorePayerStore } = await import("../src/payerWallet.js");
const { reviewRequest } = await import("../src/payerFlow.js");

const NOW = Math.floor(Date.now() / 1000);
const merchant = Keypair.random().publicKey();
const request = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  v: 1,
  id: "r-1",
  destination: merchant,
  amount: "5",
  asset: "native",
  expiresAt: NOW + 600,
  ...overrides,
});

function source(sequence = "100"): PayerSyncSource {
  const account: HorizonAccountLike = { sequence, subentry_count: 0, balances: [{ asset_type: "native", balance: "100.0000000" }] };
  return { loadAccount: async () => account, networkTime: async () => NOW };
}

beforeEach(() => secure.clear());

describe("payer keypair", () => {
  it("is created once and reused across launches", async () => {
    const first = await loadPayerKeypair();
    const second = await loadPayerKeypair();
    expect(second.publicKey()).toBe(first.publicKey());
    expect(secure.get("ghostrail.payer-secret")).toBe(first.secret());
  });
});

describe("SecureStorePayerStore", () => {
  it("round-trips a snapshot", async () => {
    const store = new SecureStorePayerStore();
    expect(await store.load()).toBeUndefined();
    const snapshot = { publicKey: "G", sequence: "5", balances: { native: "1" }, syncedAt: 1, clockOffsetSeconds: 2, pending: [] };
    await store.save(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });
});

describe("payer mode flow", () => {
  it("blocks signing until the first sync with 'Connect once to sync'", async () => {
    const { wallet } = await createPayer();
    await expect(wallet.pay(request())).rejects.toThrow(/^Connect once to sync/);
  });

  it("scans, reviews, signs offline, and persists the next sequence in the keystore", async () => {
    const { wallet, publicKey } = await createPayer();
    await wallet.sync(source());
    const clock = await wallet.clock();

    const review = reviewRequest(encodeRequest(request()), clock(), publicKey);
    expect(review.expiresInSeconds).toBeGreaterThan(590);
    const signed = await wallet.pay(review.request);

    expect(verifySignedPayment(signed.xdr, review.request, clock).source).toBe(publicKey);
    const stored = JSON.parse(secure.get("ghostrail.payer-snapshot")!);
    expect(stored.sequence).toBe("101");

    // Same keystore on the next launch: the sequence keeps advancing.
    const relaunched = await createPayer();
    expect((await relaunched.wallet.pay(request({ id: "r-2" }))).nextSequence).toBe("102");
  });
});

describe("reviewRequest", () => {
  const payer = Keypair.random().publicKey();

  it("accepts a valid request and reports time left", () => {
    expect(reviewRequest(` ${encodeRequest(request())}\n`, NOW, payer)).toEqual({ request: request(), expiresInSeconds: 600 });
  });

  it("rejects an expired request by network time", () => {
    expect(() => reviewRequest(encodeRequest(request({ expiresAt: NOW })), NOW, payer)).toThrow(/expired/);
  });

  it("rejects a request to the payer's own account", () => {
    expect(() => reviewRequest(encodeRequest(request({ destination: payer })), NOW, payer)).toThrow(/your own account/);
  });

  it("rejects things that are not requests", () => {
    expect(() => reviewRequest("AAAA", NOW, payer)).toThrow(/Not a GhostRail payment request/);
  });
});

describe("fundWithFriendbot", () => {
  it("calls Friendbot for the account and surfaces failures", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => (urls.push(url), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    await fundWithFriendbot("GABC", ok);
    expect(urls).toEqual(["https://friendbot.stellar.org?addr=GABC"]);

    const bad = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(fundWithFriendbot("GABC", bad)).rejects.toThrow(/HTTP 400/);
  });
});
