import { describe, expect, it } from "vitest";
import type { PayerSnapshot } from "@ghostrail/core";
import { formatAgo, formatAmount, formatLastKnownBalance } from "../src/format";

describe("formatAgo", () => {
  it.each([
    [0, "0s"],
    [-5, "0s"],
    [59, "59s"],
    [60, "1 min"],
    [3599, "59 min"],
    [3600, "1 h"],
    [86_399, "23 h"],
    [86_400, "1 d"],
    [10 * 86_400, "10 d"],
  ])("%i seconds → %s", (seconds, text) => {
    expect(formatAgo(seconds)).toBe(text);
  });
});

describe("formatAmount", () => {
  it.each([
    ["1000000000", "100"],
    ["999999000", "99.9999"],
    ["1", "0.0000001"],
    ["0", "0"],
  ])("%s stroops → %s", (stroops, text) => {
    expect(formatAmount(stroops)).toBe(text);
  });
});

describe("formatLastKnownBalance", () => {
  const snapshot: PayerSnapshot = {
    publicKey: "G",
    sequence: "1",
    balances: { native: "999999000", "USDC:GISSUER": "50000000" },
    syncedAt: 1_000,
    clockOffsetSeconds: 0,
    pending: [],
  };

  it("labels the cached balance as last known, with its age", () => {
    expect(formatLastKnownBalance(snapshot, 1_000 + 12 * 60)).toBe("Last known balance 99.9999 XLM, synced 12 min ago");
  });

  it("formats issued assets by code and treats a missing asset as zero", () => {
    expect(formatLastKnownBalance(snapshot, 1_030, "USDC:GISSUER")).toBe("Last known balance 5 USDC, synced 30s ago");
    expect(formatLastKnownBalance(snapshot, 1_000, "EURC:GX")).toBe("Last known balance 0 EURC, synced 0s ago");
  });
});
