# GhostRail

Offline-first payments on the **Stellar testnet**. A customer signs a Stellar payment with no connectivity; the merchant verifies it offline, keeps it in an encrypted local queue, and settles it once the network is back.

> Testnet only. There is no mainnet configuration, by design.

## Invariants

These rules hold everywhere in the codebase. PRs that weaken them will not be merged.

1. **"Settled" means Horizon confirmed the hash.** A payment moves to `settled` only via `PaymentQueue.applyConfirmation`, which needs a Horizon lookup for that exact hash with `successful: true`. A submit response, relayer or not, never counts as proof.
2. **The signed transaction hash is the idempotency key.** It is the queue's primary key, and the relayer dedupes on it, so resubmitting the same envelope is always safe.
3. **Expiry has two layers.** The tx `maxTime` makes validators reject it after expiry, and the merchant checks it locally (with a 60 s grace for ledger close time and clock skew).
4. **Every state change is persisted before the network call that follows it.** `submitting` is written before every submit. After a crash, a leftover `submitting` record means "outcome unknown" and gets reconciled by hash.
5. **Testnet only, no paid services.** Horizon testnet and Friendbot only.

## Layout

```
packages/core     @ghostrail/core: signing, verification, queue state machine, stores, settlement
apps/relayer      Fastify relayer: validates and forwards envelopes to Horizon (stateless)
apps/merchant     Expo / React Native merchant app: op-sqlite + SQLCipher queue
docs/             architecture notes
```

## Flow

```
merchant                     customer (offline)               network (later)
────────                     ──────────────────               ───────────────
encodeRequest(req) ──QR──►   decodeRequest
                             signPayment(req, key, cachedSeq)
verifyPayment(xdr, req) ◄─QR─ signed XDR
queue.enqueue  (queued)
                                                              settler.runOnce():
                                                                beginSubmit  (persist: submitting)
                                                                submit       (Horizon or relayer)
                                                                confirm(hash) on Horizon
                                                                → settled | failed | queued | submitted | expired
```

## Getting started

Requires Node ≥ 22.5 (for the built-in `node:sqlite` used in tests) and pnpm 10.

```sh
pnpm install
pnpm test            # builds core, runs every package's tests (no network)
pnpm test:testnet    # also runs a real offline → settle round trip on testnet (uses Friendbot)
pnpm typecheck
```

Relayer:

```sh
pnpm --filter @ghostrail/relayer dev    # http://localhost:8787
```

Merchant app (needs a dev build, because op-sqlite and SQLCipher are native):

```sh
cp apps/merchant/.env.example apps/merchant/.env   # set EXPO_PUBLIC_MERCHANT_ADDRESS
pnpm --filter @ghostrail/merchant android          # or ios
```

## Stellar decisions, one line each

- **Fixed fee (1000 stroops/op):** an offline signer can't fetch fee stats, so it pays 10× base to survive surge pricing.
- **Cached sequence number:** a tx must carry the account's next sequence, so wallets sign against the last value they saw online.
- **Explicit `timebounds.maxTime`:** validators reject the tx after expiry even if someone replays it; `maxTime = 0` (never expires) is refused.
- **Memo = request id:** this ties the on-chain payment to the merchant's request; ids are capped at 28 bytes (`MEMO_TEXT` limit).
- **Testnet passphrase baked in:** it's hashed into every tx hash, so a signature from another network fails verification.
- **Confirm via `GET /transactions/:hash`:** failed txs are also included in ledgers (fee charged), so we read `successful`, not just presence.
- **Submit in sequence order per source:** txs from one account must land in sequence order.
- **`tx_bad_seq` / `tx_insufficient_fee` / `tx_too_early` are retried:** the same envelope can still succeed later; other submit rejections are permanent.

## Extending

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md). Extension points are marked `TODO(<topic>)` in the code. Find them with `grep -rn "TODO(" packages apps --include=*.ts --include=*.tsx`.
