import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@ghostrail/core";
import { describe, expect, it } from "vitest";
import { wrapInFeeBump } from "../src/fee-bump.js";

function inner(fee: string) {
  const payer = Keypair.random();
  const tx = new TransactionBuilder(new Account(payer.publicKey(), "1"), {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: { minTime: 0, maxTime: 2_000_000_000 },
    memo: Memo.text("x"),
  })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
    .build();
  tx.sign(payer);
  return tx;
}

describe("wrapInFeeBump", () => {
  const sponsor = Keypair.random();

  it("uses the base fee when it exceeds the inner fee", () => {
    const { xdr } = wrapInFeeBump(inner("1000"), sponsor, 2000);
    expect(TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE).fee).toBe("4000");
  });

  it("never offers less per op than the inner tx, which validators would reject", () => {
    const { xdr } = wrapInFeeBump(inner("5000"), sponsor, 2000);
    expect(TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE).fee).toBe("10000");
  });
});
