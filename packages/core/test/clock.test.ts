import { describe, expect, it } from "vitest";
import { CLOCK_NOT_SYNCED_MESSAGE, NetworkClock, fetchLatestLedgerCloseTime } from "../src/index.js";

describe("NetworkClock", () => {
  it("corrects a device clock that is hours behind the network", async () => {
    const device = () => 1_000;
    const clock = new NetworkClock(0, device);
    expect(await clock.sync(async () => 1_000 + 4 * 3600)).toBe(4 * 3600);
    expect(clock.now()).toBe(1_000 + 4 * 3600);
  });

  it("keeps working offline from a persisted offset", () => {
    let device = 500;
    const clock = new NetworkClock(-30, () => device);
    expect(clock.now()).toBe(470);
    device = 600;
    expect(clock.now()).toBe(570);
    expect(clock.offsetSeconds).toBe(-30);
  });

  it("keeps the previous offset when sync fails or returns garbage", async () => {
    const clock = new NetworkClock(10, () => 100);
    await expect(clock.sync(async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await expect(clock.sync(async () => Number.NaN)).rejects.toThrow(/Invalid network time/);
    expect(clock.now()).toBe(110);
  });
});

describe("fetchLatestLedgerCloseTime", () => {
  const server = (records: { closed_at: string }[]) => {
    const calls: string[] = [];
    const builder = {
      order: (o: string) => (calls.push(`order:${o}`), builder),
      limit: (n: number) => (calls.push(`limit:${n}`), builder),
      call: async () => ({ records }),
    };
    return { server: { ledgers: () => builder } as never, calls };
  };

  it("reads the newest ledger's close time", async () => {
    const { server: s, calls } = server([{ closed_at: "2026-10-18T04:11:02Z" }]);
    expect(await fetchLatestLedgerCloseTime(s)).toBe(Date.parse("2026-10-18T04:11:02Z") / 1000);
    expect(calls).toEqual(["order:desc", "limit:1"]);
  });

  it("throws on an empty page", async () => {
    await expect(fetchLatestLedgerCloseTime(server([]).server)).rejects.toThrow(/no ledgers/);
  });
});

describe("NetworkClock sync state", () => {
  it("is unsynced until the first successful sync, and assertSynced says so", async () => {
    const clock = new NetworkClock(0, () => 100);
    expect(clock.isSynced).toBe(false);
    expect(clock.syncedAt).toBeNull();
    expect(() => clock.assertSynced()).toThrow(CLOCK_NOT_SYNCED_MESSAGE);
    try {
      clock.assertSynced();
    } catch (err) {
      expect(err).toMatchObject({ code: "CLOCK_NOT_SYNCED" });
    }

    await expect(clock.sync(async () => Promise.reject(new Error("offline")))).rejects.toThrow();
    expect(clock.isSynced).toBe(false);

    await clock.sync(async () => 250);
    expect(clock.isSynced).toBe(true);
    expect(clock.syncedAt).toBe(250);
    expect(() => clock.assertSynced()).not.toThrow();
  });

  it("restores the synced state from persisted values", () => {
    const clock = new NetworkClock(30, () => 100, 90);
    expect(clock.isSynced).toBe(true);
    expect(clock.syncedAt).toBe(90);
  });
});
