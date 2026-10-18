import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assetToRef, decodeRequest, encodeRequest, fromStroops, parseAsset, toStroops, validateRequest } from "../src/index.js";
import { makeRequest } from "./helpers.js";

describe("amounts", () => {
  it("converts decimal strings to stroops exactly", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("12.5")).toBe(125_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
  });

  it("round-trips through Stellar's canonical format", () => {
    expect(fromStroops(toStroops("12.5"))).toBe("12.5000000");
  });

  it.each(["0", "-1", "1.", ".5", "1.12345678", "abc", "1e5", "922337203685.4775808"])("rejects %s", (bad) => {
    expect(() => toStroops(bad)).toThrow(/amount/i);
  });
});

describe("assets", () => {
  const issuer = Keypair.random().publicKey();

  it("parses native and issued assets", () => {
    expect(parseAsset("native").isNative()).toBe(true);
    expect(assetToRef(parseAsset(`USDC:${issuer}`))).toBe(`USDC:${issuer}`);
  });

  it.each(["", "USDC", "USDC:nope", `TOO-LONG-CODE1:${issuer}`, `USDC:${issuer}:x`])("rejects %s", (bad) => {
    expect(() => parseAsset(bad)).toThrow(/asset/i);
  });
});

describe("payment requests", () => {
  it("round-trips through the QR encoding", () => {
    const request = makeRequest();
    const encoded = encodeRequest(request);
    expect(encoded).toMatch(/^ghostrail:req:v1:[A-Za-z0-9_-]+$/);
    expect(decodeRequest(encoded)).toEqual(request);
  });

  it("rejects foreign or corrupt payloads", () => {
    expect(() => decodeRequest("bitcoin:abc")).toThrow(/Not a GhostRail/);
    expect(() => decodeRequest("ghostrail:req:v1:!!!")).toThrow(/Malformed/);
  });

  it.each([
    ["version", { v: 2 }],
    ["empty id", { id: "" }],
    ["id over 28 bytes", { id: "x".repeat(29) }],
    ["destination", { destination: "GABC" }],
    ["amount", { amount: "0" }],
    ["asset", { asset: "BTC" }],
    ["expiresAt", { expiresAt: -1 }],
  ])("rejects a bad %s", (_name, overrides) => {
    expect(() => validateRequest({ ...makeRequest(), ...overrides })).toThrow();
  });

  it("drops unknown fields", () => {
    expect(validateRequest({ ...makeRequest(), extra: "x" })).not.toHaveProperty("extra");
  });
});
