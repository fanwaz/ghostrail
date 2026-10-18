import { Account, Keypair, Memo, Networks, Operation, TransactionBuilder, Asset } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { GhostRailError, NETWORK_PASSPHRASE, buildOfflinePayment, verifySignedPayment } from "../src/index.js";
import { NOW, customer, makeRequest, merchant } from "./helpers.js";

const account = () => ({ publicKey: customer.publicKey(), sequence: "100" });
const clock = () => NOW;

/** Builds a custom envelope so tests can produce txs our signer never would. */
function craft(
  options: {
    passphrase?: string;
    maxTime?: number;
    memo?: Memo;
    amount?: string;
    destination?: string;
    extraOp?: boolean;
    signer?: Keypair;
    opSource?: string;
  } = {},
): string {
  const request = makeRequest();
  const tx = new TransactionBuilder(new Account(customer.publicKey(), "100"), {
    fee: "1000",
    networkPassphrase: options.passphrase ?? NETWORK_PASSPHRASE,
    timebounds: { minTime: 0, maxTime: options.maxTime ?? request.expiresAt },
    memo: options.memo ?? Memo.text(request.id),
  }).addOperation(
    Operation.payment({
      destination: options.destination ?? request.destination,
      asset: Asset.native(),
      amount: options.amount ?? request.amount,
      ...(options.opSource ? { source: options.opSource } : {}),
    }),
  );
  if (options.extraOp) tx.addOperation(Operation.bumpSequence({ bumpTo: "200" }));
  const built = tx.build();
  built.sign(options.signer ?? customer);
  return built.toEnvelope().toXDR("base64");
}

function expectCode(fn: () => unknown, code: GhostRailError["code"]) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GhostRailError);
    expect((err as GhostRailError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("buildOfflinePayment", () => {
  it("produces a testnet tx bound to the request and advances the sequence", () => {
    const request = makeRequest();
    const signed = buildOfflinePayment({ request, signer: customer, account: account(), clock });
    const tx = TransactionBuilder.fromXDR(signed.xdr, NETWORK_PASSPHRASE);
    if (!("sequence" in tx)) throw new Error("expected a plain transaction");

    expect(signed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.nextSequence).toBe("101");
    expect(tx.sequence).toBe("101");
    expect(Number(tx.timeBounds?.maxTime)).toBe(request.expiresAt);
    expect(tx.fee).toBe("1000");
  });

  it("is deterministic: same inputs give the same hash (the idempotency key)", () => {
    const a = buildOfflinePayment({ request: makeRequest(), signer: customer, account: account(), clock });
    const b = buildOfflinePayment({ request: makeRequest(), signer: customer, account: account(), clock });
    expect(a.hash).toBe(b.hash);
  });

  it("refuses to sign an expired request", () => {
    expectCode(() => buildOfflinePayment({ request: makeRequest({ expiresAt: NOW }), signer: customer, account: account(), clock }), "EXPIRED");
  });

  it("refuses a signer that is not the paying account", () => {
    expectCode(
      () => buildOfflinePayment({ request: makeRequest(), signer: Keypair.random(), account: account(), clock }),
      "BAD_SIGNATURE",
    );
  });
});

describe("verifySignedPayment", () => {
  it("accepts a payment signed by buildOfflinePayment", () => {
    const request = makeRequest();
    const signed = buildOfflinePayment({ request, signer: customer, account: account(), clock });
    const verified = verifySignedPayment(signed.xdr, request, clock);
    expect(verified).toMatchObject({
      hash: signed.hash,
      requestId: request.id,
      source: customer.publicKey(),
      destination: merchant.publicKey(),
      asset: "native",
      sequence: "101",
      maxTime: request.expiresAt,
    });
  });

  it("accepts equal amounts in different notation", () => {
    expect(() => verifySignedPayment(craft({ amount: "12.5000000" }), makeRequest(), clock)).not.toThrow();
  });

  it("rejects garbage", () => expectCode(() => verifySignedPayment("AAAA", makeRequest(), clock), "INVALID_TRANSACTION"));

  it("rejects a tx signed for another network", () => {
    expectCode(() => verifySignedPayment(craft({ passphrase: Networks.PUBLIC }), makeRequest(), clock), "BAD_SIGNATURE");
  });

  it("rejects a signature from someone else", () => {
    expectCode(() => verifySignedPayment(craft({ signer: Keypair.random() }), makeRequest(), clock), "BAD_SIGNATURE");
  });

  it("rejects a wrong amount", () => expectCode(() => verifySignedPayment(craft({ amount: "1" }), makeRequest(), clock), "MISMATCH"));

  it("rejects a wrong destination", () => {
    expectCode(() => verifySignedPayment(craft({ destination: Keypair.random().publicKey() }), makeRequest(), clock), "MISMATCH");
  });

  it("rejects a wrong memo", () => {
    expectCode(() => verifySignedPayment(craft({ memo: Memo.text("other") }), makeRequest(), clock), "MISMATCH");
    expectCode(() => verifySignedPayment(craft({ memo: Memo.none() }), makeRequest(), clock), "MISMATCH");
  });

  it("rejects a tx without maxTime", () => {
    expectCode(() => verifySignedPayment(craft({ maxTime: 0 }), makeRequest(), clock), "MISSING_TIME_BOUNDS");
  });

  it("rejects a tx that outlives the request", () => {
    expectCode(() => verifySignedPayment(craft({ maxTime: NOW + 10_000 }), makeRequest(), clock), "MISMATCH");
  });

  it("rejects an already-expired tx (local check)", () => {
    expectCode(() => verifySignedPayment(craft(), makeRequest(), () => NOW + 600), "EXPIRED");
  });

  it("rejects extra operations", () => {
    expectCode(() => verifySignedPayment(craft({ extraOp: true }), makeRequest(), clock), "INVALID_TRANSACTION");
  });

  it("rejects an operation paid from a different account", () => {
    expectCode(() => verifySignedPayment(craft({ opSource: Keypair.random().publicKey() }), makeRequest(), clock), "INVALID_TRANSACTION");
  });

  it("rejects fee-bump envelopes", () => {
    const inner = TransactionBuilder.fromXDR(craft(), NETWORK_PASSPHRASE);
    if (!("sequence" in inner)) throw new Error("expected inner tx");
    const sponsor = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "2000", inner, NETWORK_PASSPHRASE);
    bump.sign(sponsor);
    expectCode(() => verifySignedPayment(bump.toEnvelope().toXDR("base64"), makeRequest(), clock), "INVALID_TRANSACTION");
  });
});
