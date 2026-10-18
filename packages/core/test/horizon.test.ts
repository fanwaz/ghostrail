import { NotFoundError } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { HorizonGateway, classifySubmitError, type HorizonServerLike } from "../src/index.js";
import { makeVerified } from "./helpers.js";

const horizonError = (status: number, code?: string, inner?: string) =>
  Object.assign(new Error("Request failed"), {
    response: {
      status,
      data: code ? { extras: { result_codes: { transaction: code, ...(inner ? { inner_transaction: inner } : {}) } } } : {},
    },
  });

describe("classifySubmitError", () => {
  it("classifies retryable tx codes", () => {
    expect(classifySubmitError("h", horizonError(400, "tx_bad_seq"))).toEqual({
      kind: "rejected",
      hash: "h",
      code: "tx_bad_seq",
      retryable: true,
    });
  });

  it("classifies permanent tx codes", () => {
    expect(classifySubmitError("h", horizonError(400, "tx_bad_auth"))).toMatchObject({ retryable: false });
    expect(classifySubmitError("h", horizonError(400, "tx_too_late"))).toMatchObject({ retryable: false });
  });

  it("uses the inner code when a fee-bump wrapper fails", () => {
    expect(classifySubmitError("h", horizonError(400, "tx_fee_bump_inner_failed", "tx_bad_seq"))).toEqual({
      kind: "rejected",
      hash: "h",
      code: "tx_bad_seq",
      retryable: true,
    });
    expect(classifySubmitError("h", horizonError(400, "tx_fee_bump_inner_failed"))).toMatchObject({
      code: "tx_fee_bump_inner_failed",
      retryable: false,
    });
  });

  it("treats timeouts, 5xx and transport errors as unknown", () => {
    expect(classifySubmitError("h", horizonError(504))).toMatchObject({ kind: "unknown" });
    expect(classifySubmitError("h", new Error("ECONNRESET"))).toEqual({ kind: "unknown", hash: "h", error: "ECONNRESET" });
    expect(classifySubmitError("h", horizonError(400))).toMatchObject({ kind: "unknown" });
  });
});

function fakeServer(options: { submit?: () => Promise<unknown>; lookup?: (hash: string) => Promise<unknown> }) {
  const calls: string[] = [];
  const server = {
    submitTransaction: async () => {
      calls.push("submit");
      return options.submit ? options.submit() : {};
    },
    transactions: () => ({
      transaction: (hash: string) => ({
        call: async () => {
          calls.push(`lookup:${hash}`);
          if (!options.lookup) throw new Error("no lookup");
          return options.lookup(hash);
        },
      }),
    }),
  } as unknown as HorizonServerLike;
  return { server, calls };
}

describe("HorizonGateway", () => {
  it("reports accepted submits with the envelope hash", async () => {
    const payment = makeVerified();
    const { server } = fakeServer({});
    expect(await new HorizonGateway(server).submit(payment.xdr)).toEqual({ kind: "accepted", hash: payment.hash });
  });

  it("classifies submit failures", async () => {
    const payment = makeVerified();
    const { server } = fakeServer({ submit: () => Promise.reject(horizonError(400, "tx_bad_seq")) });
    expect(await new HorizonGateway(server).submit(payment.xdr)).toMatchObject({ kind: "rejected", code: "tx_bad_seq" });
  });

  it("confirms from the transaction lookup", async () => {
    const { server, calls } = fakeServer({ lookup: async (hash) => ({ hash, successful: true, ledger_attr: 123 }) });
    expect(await new HorizonGateway(server).confirm("ab")).toEqual({ found: true, hash: "ab", successful: true, ledger: 123 });
    expect(calls).toEqual(["lookup:ab"]);
  });

  it("confirms a fee-bumped tx looked up by its inner hash", async () => {
    const { server } = fakeServer({
      lookup: async () => ({ hash: "outer", inner_transaction: { hash: "ab" }, successful: true, ledger_attr: 5 }),
    });
    expect(await new HorizonGateway(server).confirm("ab")).toEqual({ found: true, hash: "ab", successful: true, ledger: 5 });
  });

  it("maps 404 to not found", async () => {
    const { server } = fakeServer({ lookup: () => Promise.reject(new NotFoundError("Not Found", { status: 404 })) });
    expect(await new HorizonGateway(server).confirm("ab")).toEqual({ found: false, hash: "ab" });
  });

  it("propagates transport errors instead of guessing", async () => {
    const { server } = fakeServer({ lookup: () => Promise.reject(new Error("ETIMEDOUT")) });
    await expect(new HorizonGateway(server).confirm("ab")).rejects.toThrow("ETIMEDOUT");
  });

  it("rejects a lookup that returns a different hash", async () => {
    const { server } = fakeServer({ lookup: async () => ({ hash: "cd", successful: true, ledger_attr: 1 }) });
    await expect(new HorizonGateway(server).confirm("ab")).rejects.toThrow(/returned cd for ab/);
  });
});
