import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  EXPIRY_GRACE_SECONDS,
  MemoryQueueStore,
  PaymentQueue,
  SqlQueueStore,
  type QueueStore,
  type TransitionEvent,
} from "../src/index.js";
import { NOW, fakeClock, makeVerified, nodeSqliteDriver } from "./helpers.js";

const stores: [string, () => Promise<QueueStore>][] = [
  ["MemoryQueueStore", async () => new MemoryQueueStore()],
  ["SqlQueueStore", () => SqlQueueStore.open(nodeSqliteDriver())],
];

describe.each(stores)("PaymentQueue on %s", (_name, makeStore) => {
  async function setup() {
    const clock = fakeClock();
    const events: TransitionEvent[] = [];
    const queue = new PaymentQueue(await makeStore(), { clock, onTransition: (e) => events.push(e) });
    return { clock, events, queue };
  }

  it("enqueues a verified payment as queued", async () => {
    const { queue, events } = await setup();
    const payment = makeVerified();
    const { record, duplicate } = await queue.enqueue(payment);
    expect(duplicate).toBe(false);
    expect(record).toMatchObject({ hash: payment.hash, state: "queued", attempts: 0, ledger: null });
    expect(await queue.get(payment.hash)).toEqual(record);
    expect(events).toEqual([{ record, from: null }]);
  });

  it("is idempotent on the tx hash", async () => {
    const { queue, events } = await setup();
    const payment = makeVerified();
    const first = await queue.enqueue(payment);
    await queue.beginSubmit(first.record);
    const again = await queue.enqueue(payment);
    expect(again.duplicate).toBe(true);
    expect(again.record.state).toBe("submitting");
    expect(await queue.list()).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it("persists each transition and increments attempts on submit", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const submitting = await queue.beginSubmit(record);
    expect(submitting.attempts).toBe(1);
    expect(await queue.get(record.hash)).toEqual(submitting);
  });

  it("settles only with a matching Horizon confirmation", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const submitting = await queue.beginSubmit(record);
    await expect(
      queue.applyConfirmation(submitting, { found: true, hash: "f".repeat(64), successful: true, ledger: 1 }),
    ).rejects.toMatchObject({ code: "MISMATCH" });

    const settled = await queue.applyConfirmation(submitting, { found: true, hash: record.hash, successful: true, ledger: 77 });
    expect(settled).toMatchObject({ state: "settled", ledger: 77, lastError: null });
  });

  it("records an on-ledger failure as failed with its ledger", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const submitting = await queue.beginSubmit(record);
    const failed = await queue.applyConfirmation(submitting, { found: true, hash: record.hash, successful: false, ledger: 9 });
    expect(failed).toMatchObject({ state: "failed", ledger: 9 });
  });

  it("settles a requeued payment that Horizon later confirms", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const requeued = await queue.requeue(await queue.beginSubmit(record), "tx_bad_seq");
    const settled = await queue.applyConfirmation(requeued, { found: true, hash: record.hash, successful: true, ledger: 3 });
    expect(settled.state).toBe("settled");
  });

  it("refuses to settle a payment that was never submitted", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    await expect(
      queue.applyConfirmation(record, { found: true, hash: record.hash, successful: true, ledger: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("expires only after maxTime plus grace", async () => {
    const { queue, clock } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    clock.advance(record.maxTime - NOW + EXPIRY_GRACE_SECONDS);
    await expect(queue.markExpired(record)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    clock.advance(1);
    expect((await queue.markExpired(record)).state).toBe("expired");
  });

  it("needs a not-found lookup to expire a payment that was submitted", async () => {
    const { queue, clock } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    const submitted = await queue.markSubmitted(await queue.beginSubmit(record));
    clock.advance(10_000);
    await expect(queue.markExpired(submitted)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await queue.markExpired(submitted, { found: false, hash: record.hash })).state).toBe("expired");
  });

  it("rejects writes based on a stale copy (optimistic locking)", async () => {
    const { queue } = await setup();
    const { record } = await queue.enqueue(makeVerified());
    await queue.beginSubmit(record);
    await expect(queue.beginSubmit(record)).rejects.toMatchObject({ code: "STALE_STATE" });
  });

  it("lists by state, oldest first", async () => {
    const { queue, clock } = await setup();
    const a = await queue.enqueue(makeVerified());
    clock.advance(1);
    const b = await queue.enqueue(makeVerified());
    await queue.beginSubmit(b.record);
    expect((await queue.list(["queued"])).map((r) => r.hash)).toEqual([a.record.hash]);
    expect((await queue.list()).map((r) => r.hash)).toEqual([a.record.hash, b.record.hash]);
  });
});

describe("SqlQueueStore durability", () => {
  it("keeps records across reopen and does not rerun migrations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostrail-"));
    const file = join(dir, "queue.db");
    try {
      const db1 = new DatabaseSync(file);
      const queue1 = new PaymentQueue(await SqlQueueStore.open(nodeSqliteDriver(db1)), { clock: fakeClock() });
      const { record } = await queue1.enqueue(makeVerified());
      await queue1.beginSubmit(record);
      db1.close();

      const db2 = new DatabaseSync(file);
      const queue2 = new PaymentQueue(await SqlQueueStore.open(nodeSqliteDriver(db2)));
      expect(await queue2.get(record.hash)).toMatchObject({ state: "submitting", attempts: 1, xdr: record.xdr });
      expect(db2.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
