import { describe, expect, it } from "vitest";
import { PAYMENT_STATES, TERMINAL_STATES, assertTransition, canTransition, isTerminal } from "../src/index.js";

describe("state machine", () => {
  it("never leaves a terminal state", () => {
    for (const from of TERMINAL_STATES) {
      expect(isTerminal(from)).toBe(true);
      for (const to of PAYMENT_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it("cannot mark a queued payment submitted without going through submitting", () => {
    expect(canTransition("queued", "submitted")).toBe(false);
  });

  it("allows the normal settlement path", () => {
    expect(canTransition("queued", "submitting")).toBe(true);
    expect(canTransition("submitting", "submitted")).toBe(true);
    expect(canTransition("submitted", "settled")).toBe(true);
  });

  it("allows resubmission and retry paths", () => {
    expect(canTransition("submitted", "submitting")).toBe(true);
    expect(canTransition("submitting", "queued")).toBe(true);
  });

  it("throws INVALID_TRANSITION for illegal moves", () => {
    expect(() => assertTransition("settled", "queued")).toThrow(/Cannot move payment from settled to queued/);
  });
});
