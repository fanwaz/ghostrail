import { describe, expect, it, vi } from "vitest";
import { MemoryQueueStore } from "@ghostrail/core";

vi.mock("../src/db", () => ({ openQueueStore: async () => new MemoryQueueStore() }));

async function load(relayerUrl: string) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_RELAYER_URL", relayerUrl);
  const core = await import("@ghostrail/core");
  const { createMerchant } = await import("../src/merchant.js");
  const merchant = await createMerchant(() => {});
  // Settler keeps its wiring private; inspect it for this test only.
  const options = (merchant.settler as unknown as { options: Record<string, unknown> }).options;
  return { core, options };
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
});
