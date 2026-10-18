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
  it("starts with no offset on first launch", async () => {
    expect((await loadClock()).offsetSeconds).toBe(0);
  });

  it("persists the measured offset and restores it on the next (offline) launch", async () => {
    const clock = await loadClock();
    expect(await syncClock(clock, async () => deviceNow() + 4 * 3600)).toBe(true);
    const offset = Number(secure.get("ghostrail.clock-offset"));
    expect(offset).toBeGreaterThanOrEqual(4 * 3600 - 1);

    const restored = await loadClock();
    expect(restored.offsetSeconds).toBe(offset);
  });

  it("keeps the old offset when offline", async () => {
    secure.set("ghostrail.clock-offset", "120");
    const clock = await loadClock();
    expect(await syncClock(clock, async () => Promise.reject(new Error("offline")))).toBe(false);
    expect(clock.offsetSeconds).toBe(120);
    expect(secure.get("ghostrail.clock-offset")).toBe("120");
  });

  it("ignores a corrupt stored offset", async () => {
    secure.set("ghostrail.clock-offset", "garbage");
    expect((await loadClock()).offsetSeconds).toBe(0);
  });
});
