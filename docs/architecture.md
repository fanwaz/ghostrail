# Architecture

## Modules (`packages/core/src`)

| Module | Responsibility |
| --- | --- |
| `network.ts` | Testnet passphrase, Horizon/Friendbot URLs, offline fee. The only place network constants live. |
| `request.ts` | `PaymentRequest` shape, validation, and the QR string encoding (`ghostrail:req:v1:…`). |
| `sign.ts` | Customer side: builds and signs the payment offline from a cached sequence. |
| `verify.ts` | Merchant side: offline checks (network, signature, amount, destination, asset, memo, time bounds). |
| `state.ts` | The state machine: allowed transitions only. |
| `queue.ts` | `PaymentQueue`: the only way to change state. It persists through a `QueueStore`, then notifies listeners. |
| `store.ts` / `sql-store.ts` | The `QueueStore` contract, an in-memory store, and the SQL store over a tiny `SqlDriver`. |
| `horizon.ts` | `Submitter` / `Confirmer` interfaces and the Horizon implementation. |
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

## Why the relayer can't settle anything

The merchant app uses the relayer only as a `Submitter`. Its `Confirmer` is always `HorizonGateway`. Even a relayer that lies about acceptance cannot move a payment to `settled`.

## Known limitations (good first contributions)

- **Sequence conflicts:** two payments signed offline from the same cached sequence conflict, and only one can land. Possible fixes: wallet-side locking, or channel accounts. See `TODO(sequence-gaps)`.
- **Clock skew:** devices with a wrong clock can produce txs that are already expired on-network. Validators then reject them (`tx_too_late` → `failed`), which is safe but confusing for users. See `TODO(clock-sync)`. We hit this for real: the dev machine was 4 h behind testnet.
- **Single signer:** only the source account's master key is verified. See `TODO(multisig)`.
- **No funds check offline:** verification can't know the balance. See `TODO(risk)`.
