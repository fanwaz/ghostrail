import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SqlPayerStore,
  encodeRequest,
  verifySignedPayment,
  type HorizonAccountLike,
  type PayerSnapshot,
  type PayerSyncSource,
  type PaymentRequest,
  type SqlDriver,
} from "@ghostrail/core";

const secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
let seed = 0;
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, () => (seed++ * 37) % 256) }));

// The encrypted DB, stood in for by node:sqlite (same SQL, no cipher). A new
// database and connection per test, like a fresh install.
let sqlite: DatabaseSync;
let driver: SqlDriver;
const connect = (db: DatabaseSync): SqlDriver => ({
  async execute(sql, params = []) {
    const st = db.prepare(sql);
    if (st.columns().length > 0) return { rows: st.all(...params) as Record<string, unknown>[], rowsAffected: 0 };
    return { rows: [], rowsAffected: Number(st.run(...params).changes) };
  },
});
vi.mock("../src/db", () => ({ openPayerStore: () => SqlPayerStore.open(driver) }));

const { createPayer, fundWithFriendbot, loadPayerKeypair, migrateLegacySnapshot } = await import("../src/payerWallet.js");
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

const legacy: PayerSnapshot = {
  publicKey: "GLEGACY",
  sequence: "205",
  balances: { native: "123" },
  syncedAt: NOW - 3600,
  clockOffsetSeconds: 7,
  // Shape written by the previous build: no maxTime.
  pending: [{ sequence: "205", asset: "native", amount: "10", fee: "1000" } as never],
};

beforeEach(() => {
  secure.clear();
  sqlite = new DatabaseSync(":memory:");
  driver = connect(sqlite);
});

describe("payer keypair", () => {
  it("is created once and reused across launches", async () => {
    const first = await loadPayerKeypair();
    const second = await loadPayerKeypair();
    expect(second.publicKey()).toBe(first.publicKey());
    expect(secure.get("ghostrail.payer-secret")).toBe(first.secret());
  });
});

describe("payer storage", () => {
  it("keeps only the secret key in SecureStore; sequence, balance and history go to SQLite", async () => {
    const { wallet } = await createPayer();
    await wallet.sync(source());
    await wallet.pay(request());

    expect([...secure.keys()]).toEqual(["ghostrail.payer-secret"]);
    const row = sqlite.prepare("SELECT sequence, synced_at, balances, pending FROM payer_state").get() as { sequence: string; synced_at: number; balances: string; pending: string };
    expect(row.sequence).toBe("101");
    expect(Number(row.synced_at)).toBe(NOW);
    expect(JSON.parse(row.balances)).toHaveProperty("native");
    expect(JSON.parse(row.pending)).toHaveLength(1);
  });
});

describe("migrateLegacySnapshot", () => {
  it("does nothing when there is no legacy value", async () => {
    expect(await migrateLegacySnapshot(await SqlPayerStore.open(driver))).toBe("none");
  });

  it("moves a SecureStore snapshot into SQLite, filling maxTime as null, then deletes it", async () => {
    secure.set("ghostrail.payer-snapshot", JSON.stringify(legacy));
    const store = await SqlPayerStore.open(driver);

    expect(await migrateLegacySnapshot(store)).toBe("migrated");
    expect(await store.load()).toEqual({ ...legacy, pending: [{ ...legacy.pending[0], maxTime: null }] });
    expect(secure.has("ghostrail.payer-snapshot")).toBe(false);
  });

  it("finishes an interrupted migration without overwriting SQLite", async () => {
    const store = await SqlPayerStore.open(driver);
    await store.save({ ...legacy, sequence: "300", pending: [] }); // newer state already in SQLite
    secure.set("ghostrail.payer-snapshot", JSON.stringify(legacy));

    expect(await migrateLegacySnapshot(store)).toBe("discarded-duplicate");
    expect((await store.load())?.sequence).toBe("300");
    expect(secure.has("ghostrail.payer-snapshot")).toBe(false);
  });

  it("refuses to drop a corrupt legacy value", async () => {
    secure.set("ghostrail.payer-snapshot", "{not json");
    await expect(migrateLegacySnapshot(await SqlPayerStore.open(driver))).rejects.toThrow(/corrupt/);
    expect(secure.get("ghostrail.payer-snapshot")).toBe("{not json");
  });

  it("runs on wallet open, so an upgraded install keeps its sequence", async () => {
    secure.set("ghostrail.payer-snapshot", JSON.stringify(legacy));
    const { wallet } = await createPayer();
    expect((await wallet.snapshot())?.sequence).toBe("205");
    expect([...secure.keys()]).toEqual(["ghostrail.payer-secret"]);
  });
});

describe("payer mode flow", () => {
  it("blocks signing until the first sync with 'Connect once to sync'", async () => {
    const { wallet } = await createPayer();
    await expect(wallet.pay(request())).rejects.toThrow(/^Connect once to sync/);
  });

  it("scans, reviews, signs offline, and persists the next sequence", async () => {
    const { wallet, publicKey } = await createPayer();
    await wallet.sync(source());
    const clock = await wallet.clock();

    const review = reviewRequest(encodeRequest(request()), clock(), publicKey);
    expect(review.expiresInSeconds).toBeGreaterThan(590);
    const signed = await wallet.pay(review.request);
    expect(verifySignedPayment(signed.xdr, review.request, clock).source).toBe(publicKey);

    // Same database on the next launch: the sequence keeps advancing.
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
