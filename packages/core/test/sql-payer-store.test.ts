import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PaymentQueue, SqlPayerStore, SqlQueueStore, type PayerSnapshot } from "../src/index.js";
import { makeVerified, nodeSqliteDriver } from "./helpers.js";

const snapshot = (overrides: Partial<PayerSnapshot> = {}): PayerSnapshot => ({
  publicKey: "GPAYER",
  sequence: "102",
  balances: { native: "700000000", "USDC:GI": "5" },
  syncedAt: 1_800_000_000,
  clockOffsetSeconds: -14_400,
  pending: [
    { sequence: "101", asset: "native", amount: "100000000", fee: "1000", maxTime: 1_800_000_600 },
    { sequence: "102", asset: "native", amount: "200000000", fee: "1000", maxTime: null },
  ],
  ...overrides,
});

describe("SqlPayerStore", () => {
  it("is empty before the first save and round-trips a snapshot exactly", async () => {
    const store = await SqlPayerStore.open(nodeSqliteDriver());
    expect(await store.load()).toBeUndefined();
    await store.save(snapshot());
    expect(await store.load()).toEqual(snapshot());
  });

  it("keeps a single row: later saves replace earlier ones", async () => {
    const driver = nodeSqliteDriver();
    const store = await SqlPayerStore.open(driver);
    await store.save(snapshot());
    await store.save(snapshot({ sequence: "103", pending: [] }));
    expect(await store.load()).toMatchObject({ sequence: "103", pending: [] });
    expect((await driver.execute("SELECT COUNT(*) AS n FROM payer_state")).rows[0]).toEqual({ n: 1 });
  });

  it("writes each save as a single statement (atomic without a transaction)", async () => {
    const inner = nodeSqliteDriver();
    const statements: string[] = [];
    const store = await SqlPayerStore.open(inner);
    const counting = await SqlPayerStore.open({
      execute: (sql, params) => (statements.push(sql), inner.execute(sql, params)),
    });
    statements.length = 0;
    await counting.save(snapshot());
    expect(statements).toHaveLength(1);
    expect(await store.load()).toEqual(snapshot());
  });

  it("shares one database and schema with the payment queue, whichever opens first", async () => {
    const driver = nodeSqliteDriver();
    const payer = await SqlPayerStore.open(driver);
    const queue = new PaymentQueue(await SqlQueueStore.open(driver));
    await payer.save(snapshot());
    const { record } = await queue.enqueue(makeVerified());
    expect(await payer.load()).toEqual(snapshot());
    expect((await queue.get(record.hash))?.state).toBe("queued");
    expect((await driver.execute("PRAGMA user_version")).rows[0]).toEqual({ user_version: 2 });
  });

  it("migrates a version-1 database (queue only) without touching its payments", async () => {
    const file = new DatabaseSync(":memory:");
    // Recreate the v1 state: queue table present, user_version 1.
    const before = nodeSqliteDriver(file);
    const v1 = new PaymentQueue(await SqlQueueStore.open(before));
    await before.execute("DROP TABLE payer_state");
    await before.execute("PRAGMA user_version = 1");
    const { record } = await v1.enqueue(makeVerified());

    // Next app launch: a new connection to the same database.
    const driver = nodeSqliteDriver(file);
    const payer = await SqlPayerStore.open(driver);
    await payer.save(snapshot());
    expect(await payer.load()).toEqual(snapshot());
    expect((await (await SqlQueueStore.open(driver)).get(record.hash))?.state).toBe("queued");
  });

  it("migrates once when the queue and payer stores open concurrently on one connection", async () => {
    const driver = nodeSqliteDriver();
    const [queue, payer] = await Promise.all([SqlQueueStore.open(driver), SqlPayerStore.open(driver)]);
    expect(await queue.list()).toEqual([]);
    expect(await payer.load()).toBeUndefined();
  });

  it("retries migrations after a failed attempt", async () => {
    const inner = nodeSqliteDriver();
    let fail = true;
    const flaky = {
      execute: async (sql: string, params?: (string | number | null)[]) => {
        if (fail && sql.startsWith("CREATE TABLE payer_state")) throw new Error("disk I/O error");
        return inner.execute(sql, params);
      },
    };
    await expect(SqlPayerStore.open(flaky)).rejects.toThrow("disk I/O error");
    fail = false;
    await expect(SqlPayerStore.open(flaky)).resolves.toBeDefined();
  });
});
