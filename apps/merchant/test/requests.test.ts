import { Keypair } from "@stellar/stellar-sdk";
import { NetworkClock } from "@ghostrail/core";
import { describe, expect, it } from "vitest";
import { createPaymentRequest } from "../src/requests";

const destination = Keypair.random().publicKey();

describe("createPaymentRequest", () => {
  it("refuses until the clock has synced once", () => {
    expect(() => createPaymentRequest(new NetworkClock(), "5", destination)).toThrow(/Connect once to sync/);
  });

  it("uses network time for expiry, not the device clock", () => {
    const device = () => 1_000;
    const clock = new NetworkClock(4 * 3600, device, 1_000 + 4 * 3600);
    const request = createPaymentRequest(clock, "5", destination);
    expect(request.expiresAt).toBe(1_000 + 4 * 3600 + 15 * 60);
    expect(request).toMatchObject({ v: 1, amount: "5", asset: "native", destination });
  });

  it("produces ids that fit the 28-byte memo and differ between requests", () => {
    const clock = new NetworkClock(0, undefined, 1);
    const a = createPaymentRequest(clock, "1", destination);
    const b = createPaymentRequest(clock, "1", destination);
    expect(new TextEncoder().encode(a.id).length).toBeLessThanOrEqual(28);
    expect(a.id).not.toBe(b.id);
  });

  it("rejects invalid input", () => {
    const clock = new NetworkClock(0, undefined, 1);
    expect(() => createPaymentRequest(clock, "0", destination)).toThrow(/amount/i);
    expect(() => createPaymentRequest(clock, "1", "")).toThrow(/destination/);
  });
});
