import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
}));

const { loadClock, syncClock } = await import("../src/clock.js");
const deviceNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => secure.clear());

describe("merchant clock", () => {
  it("is unsynced on first launch", async () => {
    const clock = await loadClock();
    expect(clock.isSynced).toBe(false);
    expect(() => clock.assertSynced()).toThrow(/Connect once to sync/);
  });

  it("persists offset and sync time, and restores both on the next (offline) launch", async () => {
    const clock = await loadClock();
    const networkTime = deviceNow() + 4 * 3600;
    expect(await syncClock(clock, async () => networkTime)).toBe(true);

    const restored = await loadClock();
    expect(restored.isSynced).toBe(true);
    expect(restored.syncedAt).toBe(networkTime);
    expect(restored.offsetSeconds).toBe(clock.offsetSeconds);
  });

  it("stays unsynced, and stores nothing, when the first sync fails", async () => {
    const clock = await loadClock();
    expect(await syncClock(clock, async () => Promise.reject(new Error("offline")))).toBe(false);
    expect(clock.isSynced).toBe(false);
    expect(secure.size).toBe(0);
  });

  it("keeps a previous sync when a later one fails", async () => {
    secure.set("ghostrail.clock", JSON.stringify({ offsetSeconds: 120, syncedAt: 1_000 }));
    const clock = await loadClock();
    expect(await syncClock(clock, async () => Promise.reject(new Error("offline")))).toBe(false);
    expect(clock).toMatchObject({ offsetSeconds: 120, syncedAt: 1_000, isSynced: true });
  });

  it.each(["garbage", "{}", JSON.stringify({ offsetSeconds: 5 }), "42"])("treats corrupt stored value %j as unsynced", async (raw) => {
    secure.set("ghostrail.clock", raw);
    expect((await loadClock()).isSynced).toBe(false);
  });
});
