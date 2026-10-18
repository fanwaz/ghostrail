import { Horizon, type Keypair } from "@stellar/stellar-sdk";
import { toStroops } from "./amount.js";
import type { AssetRef } from "./asset.js";
import { NetworkClock, systemClock, type Clock } from "./clock.js";
import { GhostRailError } from "./errors.js";
import { fetchLatestLedgerCloseTime } from "./horizon.js";
import { HORIZON_URL, OFFLINE_FEE_STROOPS } from "./network.js";
import { isPastExpiry } from "./queue.js";
import type { PaymentRequest } from "./request.js";
import { buildOfflinePayment, type SignedPayment } from "./sign.js";

/** A payment this wallet signed that Horizon has not yet accounted for. */
export interface PendingDebit {
  sequence: string;
  asset: AssetRef;
  /** Stroops, as a decimal string. */
  amount: string;
  /** Stroops (native), as a decimal string. */
  fee: string;
  /** The tx's maxTime (unix seconds); null for entries saved before it was recorded, which never expire locally. */
  maxTime: number | null;
}

/** Everything the payer needs to sign offline, as of the last time it was online. */
export interface PayerSnapshot {
  publicKey: string;
  /** Last sequence number used, by the network or by this wallet, whichever is higher. */
  sequence: string;
  /** Spendable amount per asset in stroops, after reserves, liabilities and pending debits. */
  balances: Record<AssetRef, string>;
  /** Network time (unix seconds) when balances and sequence were read from Horizon. */
  syncedAt: number;
  /** Device-to-network clock offset measured at sync; restores the NetworkClock offline. */
  clockOffsetSeconds: number;
  pending: PendingDebit[];
}

/** Persists the snapshot. `save` must be durable when it resolves. */
export interface PayerStore {
  load(): Promise<PayerSnapshot | undefined>;
  save(snapshot: PayerSnapshot): Promise<void>;
}

export class MemoryPayerStore implements PayerStore {
  private snapshot: PayerSnapshot | undefined;
  async load() {
    return this.snapshot && structuredClone(this.snapshot);
  }
  async save(snapshot: PayerSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }
}

/** The fields of a Horizon account record we read. */
export interface HorizonAccountLike {
  sequence: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: readonly {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    selling_liabilities?: string;
  }[];
}

/** Where `PayerWallet.sync` reads from. */
export interface PayerSyncSource {
  loadAccount(publicKey: string): Promise<HorizonAccountLike>;
  /** Network time in unix seconds. */
  networkTime(): Promise<number>;
}

export function horizonPayerSource(server: Horizon.Server = new Horizon.Server(HORIZON_URL)): PayerSyncSource {
  return {
    loadAccount: (publicKey) => server.loadAccount(publicKey),
    networkTime: () => fetchLatestLedgerCloseTime(server),
  };
}

/** Stellar: an account must keep (2 + subentries + sponsoring − sponsored) × 0.5 XLM as a reserve. */
const BASE_RESERVE_STROOPS = 5_000_000n;

/** Spendable stroops per asset for a Horizon account (liquidity-pool shares are skipped). */
export function spendableBalances(account: HorizonAccountLike): Record<AssetRef, bigint> {
  const out: Record<AssetRef, bigint> = {};
  for (const b of account.balances) {
    if (b.asset_type === "liquidity_pool_shares") continue;
    let spendable = toStroopsOrZero(b.balance) - toStroopsOrZero(b.selling_liabilities ?? "0");
    let ref: AssetRef;
    if (b.asset_type === "native") {
      ref = "native";
      const entries = 2n + BigInt(account.subentry_count) + BigInt(account.num_sponsoring ?? 0) - BigInt(account.num_sponsored ?? 0);
      spendable -= entries * BASE_RESERVE_STROOPS;
    } else {
      ref = `${b.asset_code}:${b.asset_issuer}`;
    }
    out[ref] = spendable > 0n ? spendable : 0n;
  }
  return out;
}

/**
 * The customer's offline wallet state: cached sequence, cached spendable
 * balances with a timestamp, and the clock offset.
 *
 * Every signature consumes a sequence number and debits the cached balance,
 * and that is persisted BEFORE the signed tx is returned. A crash therefore
 * can never cause a sequence number to be signed twice.
 *
 * TODO(payer-app): a customer wallet UI (Expo) that renders the signed XDR as a QR code.
 */
export class PayerWallet {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: PayerStore,
    private readonly signer: Keypair,
    private readonly base: Clock = systemClock,
  ) {}

  /** The cached state, or undefined before the first sync. */
  snapshot(): Promise<PayerSnapshot | undefined> {
    return this.store.load();
  }

  /** Clock corrected by the last measured offset; works offline. */
  async clock(): Promise<Clock> {
    return new NetworkClock((await this.store.load())?.clockOffsetSeconds ?? 0, this.base).now;
  }

  /** Online moment: refresh sequence, balances and clock offset from Horizon. */
  sync(source: PayerSyncSource): Promise<PayerSnapshot> {
    return this.serialized(async () => {
      const publicKey = this.signer.publicKey();
      const clock = new NetworkClock(0, this.base);
      await clock.sync(() => source.networkTime());
      const account = await source.loadAccount(publicKey);
      const previous = await this.store.load();

      // Stellar: a pending tx with sequence <= the account's has either landed or can never land.
      const networkSeq = BigInt(account.sequence);
      let pending = (previous?.pending ?? []).filter((p) => BigInt(p.sequence) > networkSeq);
      let cachedSeq = previous ? BigInt(previous.sequence) : 0n;

      // Stellar: once every remaining pending tx is past its maxTime, none can ever land, so their
      // debits are void and their sequence numbers are free to reuse. This keeps `pending` bounded
      // by the payments still inside their expiry window. (If any is still live, all are kept:
      // reusing a sequence below a live tx could let that tx land later, unaccounted for.)
      const now = clock.now();
      if (pending.length > 0 && pending.every((p) => p.maxTime !== null && isPastExpiry(p.maxTime, now))) {
        pending = [];
        cachedSeq = networkSeq;
      }

      const balances = spendableBalances(account);
      for (const p of pending) debit(balances, p);

      const snapshot: PayerSnapshot = {
        publicKey,
        sequence: String(networkSeq > cachedSeq ? networkSeq : cachedSeq),
        balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])),
        syncedAt: now,
        clockOffsetSeconds: clock.offsetSeconds,
        pending,
      };
      await this.store.save(snapshot);
      return snapshot;
    });
  }

  /**
   * Signs a payment offline against the cached state. Throws NOT_SYNCED or
   * INSUFFICIENT_BALANCE. Persists the incremented sequence and debited
   * balance before resolving.
   */
  pay(request: PaymentRequest): Promise<SignedPayment> {
    return this.serialized(async () => {
      const snapshot = await this.store.load();
      if (!snapshot) throw new GhostRailError("NOT_SYNCED", "Connect once to sync this wallet with the Stellar network");

      const pendingDebit: Omit<PendingDebit, "sequence"> = {
        asset: request.asset,
        amount: String(toStroops(request.amount)),
        fee: String(OFFLINE_FEE_STROOPS),
        maxTime: request.expiresAt,
      };
      const balances = Object.fromEntries(Object.entries(snapshot.balances).map(([k, v]) => [k, BigInt(v)]));
      debit(balances, { ...pendingDebit, sequence: "0" });
      const short = Object.entries(balances).find(([, v]) => v < 0n);
      if (short) {
        throw new GhostRailError(
          "INSUFFICIENT_BALANCE",
          `Cached ${short[0]} balance is too low (as of ${new Date(snapshot.syncedAt * 1000).toISOString()})`,
        );
      }

      const signed = buildOfflinePayment({
        request,
        signer: this.signer,
        account: { publicKey: snapshot.publicKey, sequence: snapshot.sequence },
        clock: new NetworkClock(snapshot.clockOffsetSeconds, this.base).now,
      });
      await this.store.save({
        ...snapshot,
        sequence: signed.nextSequence,
        balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])),
        pending: [...snapshot.pending, { ...pendingDebit, sequence: signed.nextSequence }],
      });
      return signed;
    });
  }

  /** Runs wallet operations one at a time so two payments never share a sequence. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function debit(balances: Record<AssetRef, bigint>, p: PendingDebit): void {
  balances[p.asset] = (balances[p.asset] ?? 0n) - BigInt(p.amount);
  balances.native = (balances.native ?? 0n) - BigInt(p.fee);
}

function toStroopsOrZero(amount: string): bigint {
  return /^0(\.0+)?$/.test(amount) ? 0n : toStroops(amount);
}

