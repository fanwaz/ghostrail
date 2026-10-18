import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, encodeRequest } from "@ghostrail/core";
import { classifyScan } from "../src/scan";

const kp = Keypair.random();
const xdr = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
  fee: "1000",
  networkPassphrase: NETWORK_PASSPHRASE,
  timebounds: { minTime: 0, maxTime: 2_000_000_000 },
  memo: Memo.text("x"),
})
  .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: "1" }))
  .build()
  .toEnvelope()
  .toXDR("base64");

describe("classifyScan", () => {
  it("recognizes a signed transaction envelope, trimming whitespace", () => {
    expect(classifyScan(`  ${xdr}\n`)).toEqual({ kind: "payment", xdr });
  });

  it("flags a payment request scanned by mistake", () => {
    const request = encodeRequest({ v: 1, id: "r", destination: kp.publicKey(), amount: "1", asset: "native", expiresAt: 2_000_000_000 });
    expect(classifyScan(request)).toEqual({ kind: "request" });
  });

  it.each(["", "https://example.com", "not base64!", "abc"])("rejects %j", (data) => {
    expect(classifyScan(data)).toEqual({ kind: "unknown" });
  });
});
