# Contributing to GhostRail

## Ground rules

- Read the **Invariants** in the [README](README.md). They are not negotiable.
- Testnet only. Don't add mainnet passphrases, URLs, or paid services.
- Every change ships with tests. `pnpm test` must pass, and `pnpm test:testnet` too if you touch signing, submission, or confirmation.
- Keep modules small and single-purpose. Put new behavior behind the existing interfaces (`QueueStore`, `SqlDriver`, `Submitter`, `Confirmer`, `TransitionListener`, `Clock`) rather than reaching into internals.
- If a choice is Stellar-specific, explain it in a one-line comment starting with `Stellar:`.

## Where things plug in

Search for `TODO(`:

| Tag | Where | Idea |
| --- | --- | --- |
| `TODO(qr)` | `apps/merchant/App.tsx` | Render and scan QR codes (expo-camera) |
| `TODO(triggers)` | `settle.ts`, `merchant.ts` | Run settlement on NetInfo reconnect and on a timer |
| `TODO(backoff)` | `settle.ts` | Per-record exponential backoff |
| `TODO(clock-sync)` | `clock.ts` | Clock offset from Horizon's `Date` header |
| `TODO(sequence-gaps)` | `sign.ts` | Serialize offline signing / channel accounts |
| `TODO(multisig)` | `sign.ts` | Additional signers |
| `TODO(risk)` | `verify.ts` | Online balance/sequence pre-check when available |
| `TODO(fee-bump)` | `verify.ts`, relayer `app.ts` | Relayer-sponsored fee bumps |
| `TODO(rate-limit)`, `TODO(auth)`, `TODO(policy)` | relayer, `relayer-client.ts` | Merchant API keys, rate limits, allow-lists |
| `TODO(hooks)` | `queue.ts` | Audit log, notifications, backend sync via `onTransition` |
| `TODO(migrations)` | `sql-store.ts` | Append schema migrations (never edit shipped ones) |
| `TODO(nav)` | `apps/merchant/App.tsx` | Split screens |

A customer wallet app is not built yet. `signPayment` plus a cached `OfflineAccount` is all it needs from core.

## Conventions

- TypeScript strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM, `.js` import specifiers in packages.
- Amounts are strings and get compared in stroops (`toStroops`). Never use floats.
- Errors that callers branch on are `GhostRailError` with a `code`.
- Tests use vitest. Inject `Clock`, `Submitter`, and `Confirmer` fakes rather than mocking modules.
