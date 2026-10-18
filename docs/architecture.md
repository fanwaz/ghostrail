# Architecture

## Modules (`packages/core/src`)

| Module | Responsibility |
| --- | --- |
| `network.ts` | Testnet passphrase, Horizon/Friendbot URLs, offline fee. The only place network constants live. |
| `request.ts` | `PaymentRequest` shape, validation, and the QR string encoding (`ghostrail:req:v1:…`). |
| `sign.ts` | `buildOfflinePayment`: builds and signs the payment offline from a cached sequence. |
| `payer.ts` | `PayerWallet`: cached sequence, spendable balance (with `syncedAt`), pending debits, clock offset. Persists each increment before returning the signed tx. |
| `clock.ts` | `NetworkClock`: device time plus an offset measured from the latest ledger close time. |
| `verify.ts` | `verifySignedPayment`: merchant-side offline checks (network, signature, amount, destination, asset, memo, time bounds). |
| `state.ts` | The state machine: allowed transitions only. |
| `queue.ts` | `PaymentQueue`: the only way to change state. It persists through a `QueueStore`, then notifies listeners. |
| `store.ts` / `sql-store.ts` | The `QueueStore` contract, an in-memory store, and the SQL store over a tiny `SqlDriver`. |
| `horizon.ts` | `Submitter` / `Confirmer` interfaces, the Horizon implementation, and `fetchLatestLedgerCloseTime`. |
| `relayer-client.ts` | `Submitter` that posts to the GhostRail relayer. |
| `settle.ts` | `Settler`: one idempotent pass that drives records toward a terminal state. |

## State machine

```
queued ──► submitting ──► submitted ──► settled
  │            │  ▲           │  │
  │            │  └───────────┘  ├──► failed
  │            ├──► queued       └──► expired
  │            └──► settled | failed | expired
  └──► expired | settled | failed   (settled/failed only if previously submitted)
```

How the settler handles each record:

| Current state | Action |
| --- | --- |
| `queued`, not expired | persist `submitting`, then submit, then **confirm by hash** |
| `queued`, expired, never submitted | `expired` (no network call) |
| `queued`, expired, submitted before | confirm by hash first, then settle/fail or expire |
| `submitting` (crash leftover) | confirm by hash. If not found: `submitted`, or `expired` if past maxTime |
| `submitted` | confirm by hash. If not found: resubmit after `resubmitAfterSeconds`, or expire |

After a submit, the confirmation result decides the outcome:

- found → `settled` / `failed` (with ledger)
- not found + permanent rejection → `failed`
- not found + retryable rejection → `queued`
- not found otherwise → `submitted`

## Relayer and fee-bumps

`POST /submit` wraps the customer's tx in a fee-bump paid by the relayer's testnet sponsor (`RELAYER_SPONSOR_SECRET`, or a Friendbot-funded key at startup). The **inner** hash stays the idempotency key:

- Horizon finds a fee-bump by its inner hash, and `HorizonGateway.confirm` accepts that match.
- The wrapper is deterministic, so a retry submits an identical envelope.
- When the wrapper fails, its result is `tx_fee_bump_inner_failed`. The retry decision uses the inner result code.

`GET /status/:hash` returns Horizon's confirmation for the hash.

## Clock

Expiry and time bounds use `NetworkClock`. Its offset comes from the latest ledger close time, because that is what validators compare `maxTime` against.

- **Payer:** measures the offset on `sync()` and stores it in the snapshot.
- **Merchant:** measures it at launch and before each settle, and persists it in SecureStore.
- **Relayer:** measures it at startup and every 5 minutes.

## Why the relayer can't settle anything

The merchant app uses the relayer only as a `Submitter`. Its `Confirmer` is always `HorizonGateway`. Even a relayer that lies about acceptance cannot move a payment to `settled`.

## Known limitations (good first contributions)

- **Sequence conflicts across devices:** `PayerWallet` serializes signing on one device, but the same account on two devices can still sign the same sequence. See `TODO(sequence-gaps)`.
- **Clock before first sync:** a device that has never been online has no offset, so it uses its raw clock. (The dev machine was 4 h behind testnet, which is how this showed up.)
- **Stale cached balance:** `PayerWallet` subtracts its own pending payments, but it can't see other spending from the same account since `syncedAt`.
- **Single signer:** only the source account's master key is verified. See `TODO(multisig)`.
- **No funds check on the merchant side:** the merchant can't know the payer's balance offline. See `TODO(risk)`.
