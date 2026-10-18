import { describe, expect, it, vi } from "vitest";
import { MemoryQueueStore, NetworkClock } from "@ghostrail/core";

const calls: string[] = [];
vi.mock("../src/db", () => ({ openQueueStore: async () => new MemoryQueueStore() }));
vi.mock("../src/clock", () => ({
  loadClock: async () => new NetworkClock(3600),
  syncClock: async () => void calls.push("sync"),
}));

async function load(relayerUrl: string) {
  vi.resetModules();
  calls.length = 0;
  vi.stubEnv("EXPO_PUBLIC_RELAYER_URL", relayerUrl);
  const core = await import("@ghostrail/core");
  const { createMerchant } = await import("../src/merchant.js");
  const merchant = await createMerchant(() => {});
  // Settler keeps its wiring private; inspect it for this test only.
  const options = (merchant.settler as unknown as { options: Record<string, unknown> }).options;
  return { core, merchant, options };
}

describe("createMerchant", () => {
  it("submits and confirms via Horizon when no relayer is configured", async () => {
    const { core, options } = await load("");
    expect(options.submitter).toBeInstanceOf(core.HorizonGateway);
    expect(options.confirmer).toBeInstanceOf(core.HorizonGateway);
  });

  it("submits via the relayer but still confirms against Horizon", async () => {
    const { core, options } = await load("http://relay.test");
    expect(options.submitter).toBeInstanceOf(core.RelayerSubmitter);
    expect(options.confirmer).toBeInstanceOf(core.HorizonGateway);
  });

  it("uses the network clock for settlement and syncs it at startup", async () => {
    const { merchant, options } = await load("");
    expect(options.clock).toBe(merchant.clock.now);
    expect(merchant.clock.now() - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(3599);
    expect(calls).toEqual(["sync"]);
  });

  it("re-syncs the clock before each settlement pass", async () => {
    const { merchant } = await load("");
    calls.length = 0;
    const report = await merchant.settle();
    expect(calls).toEqual(["sync"]);
    expect(report.pending).toEqual([]);
  });
});
