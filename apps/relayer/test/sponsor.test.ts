import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { loadSponsor } from "../src/sponsor.js";

function deps() {
  const funded: string[] = [];
  const warnings: string[] = [];
  return {
    funded,
    warnings,
    deps: { fund: async (pk: string) => void funded.push(pk), warn: (m: string) => void warnings.push(m) },
  };
}

describe("loadSponsor", () => {
  it("uses RELAYER_SPONSOR_SECRET when set, in any mode", async () => {
    const kp = Keypair.random();
    for (const NODE_ENV of ["production", "development", undefined]) {
      const d = deps();
      const sponsor = await loadSponsor({ NODE_ENV, RELAYER_SPONSOR_SECRET: kp.secret() }, d.deps);
      expect(sponsor.publicKey()).toBe(kp.publicKey());
      expect(d.funded).toEqual([]);
      expect(d.warnings).toEqual([]);
    }
  });

  it("refuses to start in production without a secret", async () => {
    const d = deps();
    await expect(loadSponsor({ NODE_ENV: "production" }, d.deps)).rejects.toThrow(/RELAYER_SPONSOR_SECRET is required/);
    expect(d.funded).toEqual([]);
  });

  it("creates, funds and warns about a temporary sponsor in dev", async () => {
    const d = deps();
    const sponsor = await loadSponsor({}, d.deps);
    expect(d.funded).toEqual([sponsor.publicKey()]);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain(sponsor.publicKey());
    expect(d.warnings[0]).toMatch(/temporary sponsor/);
  });

  it("propagates a funding failure instead of starting with an empty sponsor", async () => {
    await expect(
      loadSponsor({}, { fund: async () => Promise.reject(new Error("Friendbot down")), warn: () => {} }),
    ).rejects.toThrow("Friendbot down");
  });

  it("rejects a malformed secret", async () => {
    await expect(loadSponsor({ RELAYER_SPONSOR_SECRET: "SNOPE" })).rejects.toThrow();
  });
});
