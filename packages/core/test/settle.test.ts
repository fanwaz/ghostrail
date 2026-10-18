import { describe, expect, it } from "vitest";
import { MemoryQueueStore, PaymentQueue, Settler, sortForSubmission, type PaymentRecord } from "../src/index.js";
import { FakeNetwork, NOW, fakeClock, makeVerified } from "./helpers.js";

async function setup(options: { resubmitAfterSeconds?: number } = {}) {
  const clock = fakeClock();
  const store = new MemoryQueueStore();
  const queue = new PaymentQueue(store, { clock });
  const network = new FakeNetwork();
  const settler = new Settler({ queue, submitter: network, confirmer: network, clock, ...options });
  return { clock, store, queue, network, settler };
}

describe("Settler", () => {
  it("settles a payment once Horizon confirms the hash", async () => {
    const { queue, network, settler } = await setup();
    const { record } = await queue.enqueue(makeVerified());

    const report = await settler.runOnce();

    expect(report.settled).toEqual([record.hash]);
    expect(await queue.get(record.hash)).toMatchObject({ state: "settled", ledger: 4242, attempts: 1 });
    expect(network.events.map((e) => e.type)).toEqual(["submit", "confirm"]);
  });

  it("does NOT settle on an accepted submit that Horizon cannot confirm", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = (hash) => ({ kind: "accepted", hash }); // lies: never lands
    const { record } = await queue.enqueue(makeVerified());

    const report = await settler.runOnce();

    expect(report.settled).toEqual([]);
    expect(report.pending).toEqual([record.hash]);
    expect((await queue.get(record.hash))?.state).toBe("submitted");
  });

  it("persists 'submitting' before the submit call", async () => {
    const { queue, network, settler } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const seen: (PaymentRecord | undefined)[] = [];
    network.beforeCall = async (event) => {
      if (event.type === "submit") seen.push(await queue.get(event.hash));
    };

    await settler.runOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ state: "submitting", attempts: 1 });
    expect(record.state).toBe("queued");
  });

  it("settles a timed-out submit that actually landed", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = (hash) => {
      network.ledger.set(hash, { successful: true, ledger: 5 });
      return { kind: "unknown", hash, error: "socket hang up" };
    };
    const { record } = await queue.enqueue(makeVerified());

    expect((await settler.runOnce()).settled).toEqual([record.hash]);
  });

  it("keeps an unknown outcome as submitted and settles it on a later pass", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = (hash) => ({ kind: "unknown", hash, error: "timeout" });
    const { record } = await queue.enqueue(makeVerified());

    await settler.runOnce();
    expect(await queue.get(record.hash)).toMatchObject({ state: "submitted", lastError: "timeout" });

    network.ledger.set(record.hash, { successful: true, ledger: 6 });
    expect((await settler.runOnce()).settled).toEqual([record.hash]);
  });

  it("treats a thrown submit as an unknown outcome", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = () => {
      throw new Error("offline");
    };
    const { record } = await queue.enqueue(makeVerified());
    await settler.runOnce();
    expect(await queue.get(record.hash)).toMatchObject({ state: "submitted", lastError: "Error: offline" });
  });

  it("marks an on-ledger failure as failed", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = (hash) => {
      network.ledger.set(hash, { successful: false, ledger: 7 });
      return { kind: "rejected", hash, code: "tx_failed", retryable: false };
    };
    const { record } = await queue.enqueue(makeVerified());

    expect((await settler.runOnce()).failed).toEqual([record.hash]);
    expect(await queue.get(record.hash)).toMatchObject({ state: "failed", ledger: 7 });
  });

  it("fails a permanent rejection only after Horizon reports the hash unknown", async () => {
    const { queue, network, settler } = await setup();
    network.onSubmit = (hash) => ({ kind: "rejected", hash, code: "tx_bad_auth", retryable: false });
    const { record } = await queue.enqueue(makeVerified());

    expect((await settler.runOnce()).failed).toEqual([record.hash]);
    expect(await queue.get(record.hash)).toMatchObject({ state: "failed", lastError: "tx_bad_auth", ledger: null });
    expect(network.events.map((e) => e.type)).toEqual(["submit", "confirm"]);
  });

  it("requeues a retryable rejection and retries next pass", async () => {
    const { queue, network, settler } = await setup();
    let calls = 0;
    network.onSubmit = (hash) => {
      if (calls++ === 0) return { kind: "rejected", hash, code: "tx_bad_seq", retryable: true };
      network.ledger.set(hash, { successful: true, ledger: 8 });
      return { kind: "accepted", hash };
    };
    const { record } = await queue.enqueue(makeVerified());

    await settler.runOnce();
    expect(await queue.get(record.hash)).toMatchObject({ state: "queued", lastError: "tx_bad_seq", attempts: 1 });

    await settler.runOnce();
    expect(await queue.get(record.hash)).toMatchObject({ state: "settled", attempts: 2 });
  });

  it("recovers a record left 'submitting' by a crash without resubmitting first", async () => {
    const { queue, network, settler } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    await queue.beginSubmit(record); // simulate a crash right after persisting

    await settler.runOnce();
    expect(await queue.get(record.hash)).toMatchObject({ state: "submitted" });
    expect(network.events.map((e) => e.type)).toEqual(["confirm"]);
  });

  it("settles a crashed 'submitting' record that had landed", async () => {
    const { queue, network, settler } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    await queue.beginSubmit(record);
    network.ledger.set(record.hash, { successful: true, ledger: 9 });

    expect((await settler.runOnce()).settled).toEqual([record.hash]);
  });

  it("leaves the record 'submitting' if confirmation fails mid-pass", async () => {
    const { queue, network, settler } = await setup();
    network.confirmError = new Error("Horizon unreachable");
    const { record } = await queue.enqueue(makeVerified());

    const report = await settler.runOnce();
    expect(report.errors).toEqual([{ hash: record.hash, message: "Horizon unreachable" }]);
    expect((await queue.get(record.hash))?.state).toBe("submitting");
  });

  it("resubmits the same envelope after the resubmit delay", async () => {
    const { queue, network, settler, clock } = await setup({ resubmitAfterSeconds: 30 });
    network.onSubmit = (hash) => ({ kind: "accepted", hash });
    const { record } = await queue.enqueue(makeVerified());
    await settler.runOnce();

    clock.advance(10);
    await settler.runOnce();
    expect(network.events.filter((e) => e.type === "submit")).toHaveLength(1);

    clock.advance(30);
    await settler.runOnce();
    expect(network.events.filter((e) => e.type === "submit").map((e) => e.hash)).toEqual([record.hash, record.hash]);
  });

  it("expires a never-submitted payment without touching the network", async () => {
    const { queue, network, settler, clock } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    clock.advance(record.maxTime - NOW + 61);

    expect((await settler.runOnce()).expired).toEqual([record.hash]);
    expect(network.events).toEqual([]);
  });

  it("expires a submitted payment only after Horizon reports it unknown", async () => {
    const { queue, network, settler, clock } = await setup();
    network.onSubmit = (hash) => ({ kind: "unknown", hash, error: "timeout" });
    const { record } = await queue.enqueue(makeVerified());
    await settler.runOnce();

    clock.advance(10_000);
    expect((await settler.runOnce()).expired).toEqual([record.hash]);
    expect(network.events.at(-1)).toEqual({ type: "confirm", hash: record.hash });
  });

  it("settles rather than expires a requeued payment that landed late", async () => {
    const { queue, network, settler, clock } = await setup();
    network.onSubmit = (hash) => ({ kind: "rejected", hash, code: "tx_bad_seq", retryable: true });
    const { record } = await queue.enqueue(makeVerified());
    await settler.runOnce();

    network.ledger.set(record.hash, { successful: true, ledger: 10 });
    clock.advance(10_000);
    expect((await settler.runOnce()).settled).toEqual([record.hash]);
  });

  it("shares one pass between overlapping runOnce calls", async () => {
    const { queue, network, settler } = await setup();
    await queue.enqueue(makeVerified());
    const [a, b] = await Promise.all([settler.runOnce(), settler.runOnce()]);
    expect(a).toBe(b);
    expect(network.events.filter((e) => e.type === "submit")).toHaveLength(1);
  });

  it("submits each customer's payments in sequence order", async () => {
    const { queue, network, settler } = await setup();
    const later = makeVerified({ id: "later" }, 501n);
    const earlier = makeVerified({ id: "earlier" }, 500n);
    await queue.enqueue(later);
    await queue.enqueue(earlier);

    await settler.runOnce();
    expect(network.events.filter((e) => e.type === "submit").map((e) => e.hash)).toEqual([earlier.hash, later.hash]);
  });
});

describe("sortForSubmission", () => {
  it("orders by source then numeric sequence", () => {
    const r = (source: string, sequence: string) => ({ source, sequence }) as PaymentRecord;
    const sorted = sortForSubmission([r("B", "2"), r("A", "10"), r("A", "9"), r("B", "1")]);
    expect(sorted.map((x) => `${x.source}${x.sequence}`)).toEqual(["A9", "A10", "B1", "B2"]);
  });
});
