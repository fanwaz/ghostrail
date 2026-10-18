import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for the native modules.
const secure = new Map<string, string>();
const opened: { name: string; encryptionKey?: string }[] = [];
let sqlite: DatabaseSync;

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => i) }));
// Mimics op-sqlite's async execute() → { rows, rowsAffected } on top of node:sqlite.
vi.mock("@op-engineering/op-sqlite", () => ({
  open: (params: { name: string; encryptionKey?: string }) => {
    opened.push(params);
    return {
      execute: async (sql: string, params: (string | number | null)[] = []) => {
        const st = sqlite.prepare(sql);
        if (st.columns().length > 0) return { rows: st.all(...params), rowsAffected: 0 };
        return { rows: [], rowsAffected: Number(st.run(...params).changes) };
      },
    };
  },
}));

// db.ts memoizes its connection, so each test gets a fresh module (a fresh "launch").
let db: typeof import("../src/db.js");
const openQueueStore = () => db.openQueueStore();

beforeEach(async () => {
  secure.clear();
  opened.length = 0;
  sqlite = new DatabaseSync(":memory:");
  vi.resetModules();
  db = await import("../src/db.js");
});

describe("openQueueStore", () => {
  it("creates a 256-bit key on first launch and opens the DB with it", async () => {
    await openQueueStore();
    const key = secure.get("ghostrail.db-key");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(opened).toEqual([{ name: "ghostrail.db", encryptionKey: key }]);
  });

  it("reuses the stored key on later launches", async () => {
    secure.set("ghostrail.db-key", "existing-key");
    await openQueueStore();
    expect(opened[0]?.encryptionKey).toBe("existing-key");
  });

  it("returns a working queue store over op-sqlite", async () => {
    const store = await openQueueStore();
    expect(await store.list()).toEqual([]);
    expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  });
});

describe("openDatabase", () => {
  it("opens one shared connection for the queue and the payer", async () => {
    const [queue, payer] = await Promise.all([db.openQueueStore(), db.openPayerStore()]);
    await payer.save({ publicKey: "G", sequence: "1", balances: {}, syncedAt: 1, clockOffsetSeconds: 0, pending: [] });
    expect(await queue.list()).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM payer_state").get()).toEqual({ n: 1 });
  });
});
