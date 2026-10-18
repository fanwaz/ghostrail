import { Account, Keypair, Memo, Operation, Asset, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, signPayment, toHex, type Confirmation, type Confirmer, type SubmitOutcome, type Submitter } from "@ghostrail/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const NOW = 1_800_000_000;
const customer = Keypair.random();
const merchant = Keypair.random();

function signed(expiresAt = NOW + 600) {
  return signPayment({
    request: { v: 1, id: "order-1", destination: merchant.publicKey(), amount: "5", asset: "native", expiresAt },
    signer: customer,
    account: { publicKey: customer.publicKey(), sequence: "10" },
    clock: () => NOW - 1000,
  });
}

class FakeNetwork implements Submitter, Confirmer {
  submits = 0;
  known = new Map<string, Confirmation & { found: true }>();
  outcome: (hash: string) => SubmitOutcome = (hash) => ({ kind: "accepted", hash });
  confirmFails = false;

  async submit(xdr: string): Promise<SubmitOutcome> {
    this.submits++;
    await new Promise((r) => setTimeout(r, 5));
    return this.outcome(toHex(TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE).hash()));
  }

  async confirm(hash: string): Promise<Confirmation> {
    if (this.confirmFails) throw new Error("Horizon down");
    return this.known.get(hash) ?? { found: false, hash };
  }
}

function setup() {
  const network = new FakeNetwork();
  const app = buildApp({ submitter: network, confirmer: network, clock: () => NOW });
  const post = (xdr: unknown) => app.inject({ method: "POST", url: "/v1/transactions", payload: { xdr } });
  return { network, app, post };
}

describe("POST /v1/transactions", () => {
  it("submits a valid envelope and answers 202 accepted (not settled)", async () => {
    const { network, post } = setup();
    const tx = signed();
    const res = await post(tx.xdr);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ hash: tx.hash, status: "accepted" });
    expect(network.submits).toBe(1);
  });

  it("does not resubmit a hash Horizon already has", async () => {
    const { network, post } = setup();
    const tx = signed();
    network.known.set(tx.hash, { found: true, hash: tx.hash, successful: true, ledger: 1 });

    const res = await post(tx.xdr);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: tx.hash, status: "confirmed" });
    expect(network.submits).toBe(0);
  });

  it("shares one submit between concurrent posts of the same envelope", async () => {
    const { network, post } = setup();
    const tx = signed();
    const [a, b] = await Promise.all([post(tx.xdr), post(tx.xdr)]);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(network.submits).toBe(1);
  });

  it("still submits when the idempotency lookup fails", async () => {
    const { network, post } = setup();
    network.confirmFails = true;
    expect((await post(signed().xdr)).statusCode).toBe(202);
    expect(network.submits).toBe(1);
  });

  it("passes Horizon rejections through with their code", async () => {
    const { network, post } = setup();
    const tx = signed();
    network.outcome = (hash) => ({ kind: "rejected", hash, code: "tx_bad_seq", retryable: true });
    const res = await post(tx.xdr);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ hash: tx.hash, status: "rejected", code: "tx_bad_seq", retryable: true });
  });

  it("reports unknown outcomes as 502", async () => {
    const { network, post } = setup();
    network.outcome = (hash) => ({ kind: "unknown", hash, error: "timeout" });
    const res = await post(signed().xdr);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ status: "unknown", error: "timeout" });
  });

  it.each([
    ["garbage", "AAAA", "INVALID_TRANSACTION"],
    ["expired", signed(NOW - 120).xdr, "EXPIRED"],
  ])("rejects %s envelopes without touching Horizon", async (_name, xdr, code) => {
    const { network, post } = setup();
    const res = await post(xdr);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "rejected", code, retryable: false });
    expect(network.submits).toBe(0);
  });

  it("rejects unsigned, unbounded and non-payment envelopes", async () => {
    const build = (opts: { sign?: boolean; maxTime?: number; op?: "payment" | "bump" }) => {
      const tx = new TransactionBuilder(new Account(customer.publicKey(), "10"), {
        fee: "1000",
        networkPassphrase: NETWORK_PASSPHRASE,
        timebounds: { minTime: 0, maxTime: opts.maxTime ?? NOW + 600 },
        memo: Memo.text("x"),
      })
        .addOperation(
          opts.op === "bump"
            ? Operation.bumpSequence({ bumpTo: "99" })
            : Operation.payment({ destination: merchant.publicKey(), asset: Asset.native(), amount: "1" }),
        )
        .build();
      if (opts.sign !== false) tx.sign(customer);
      return tx.toEnvelope().toXDR("base64");
    };
    const { post } = setup();
    expect((await post(build({ sign: false }))).json()).toMatchObject({ code: "BAD_SIGNATURE" });
    expect((await post(build({ maxTime: 0 }))).json()).toMatchObject({ code: "MISSING_TIME_BOUNDS" });
    expect((await post(build({ op: "bump" }))).json()).toMatchObject({ code: "INVALID_TRANSACTION" });
  });

  it("validates the request body", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/v1/transactions", payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/transactions/:hash", () => {
  it("returns Horizon's view of the hash", async () => {
    const { app, network } = setup();
    const hash = "a".repeat(64);
    network.known.set(hash, { found: true, hash, successful: true, ledger: 9 });
    const res = await app.inject({ method: "GET", url: `/v1/transactions/${hash}` });
    expect(res.json()).toEqual({ found: true, hash, successful: true, ledger: 9 });
  });

  it("returns 502 when Horizon is unreachable", async () => {
    const { app, network } = setup();
    network.confirmFails = true;
    expect((await app.inject({ method: "GET", url: `/v1/transactions/${"a".repeat(64)}` })).statusCode).toBe(502);
  });

  it("rejects malformed hashes", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/v1/transactions/xyz" })).statusCode).toBe(400);
  });
});

describe("GET /health", () => {
  it("is up", async () => {
    expect((await setup().app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});
