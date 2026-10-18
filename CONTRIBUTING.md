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
| `TODO(triggers)` | `settle.ts`, `merchant.ts` | Run settlement on NetInfo reconnect and on a timer |
| `TODO(backoff)` | `settle.ts` | Per-record exponential backoff |
| `TODO(sequence-gaps)` | `sign.ts` | Channel accounts, so one payer account works on several devices |
| `TODO(multisig)` | `sign.ts` | Additional signers |
| `TODO(risk)` | `verify.ts` | Online balance/sequence pre-check when available |
| `TODO(fee-bump)` | `verify.ts` | Let merchants accept customer-supplied fee-bump envelopes |
| `TODO(rate-limit)`, `TODO(auth)`, `TODO(policy)` | relayer, `relayer-client.ts` | Merchant API keys, rate limits, allow-lists |
| `TODO(hooks)` | `queue.ts` | Audit log, notifications, backend sync via `onTransition` |
| `TODO(migrations)` | `sql-store.ts` | Append schema migrations (never edit shipped ones) |
| `TODO(nav)` | `apps/merchant/App.tsx` | Split screens |
| `TODO(payer-app)` | `payer.ts`, merchant `src/PayerScreen.tsx`, `src/payerWallet.ts` | Standalone customer wallet (Payer mode in the merchant app is a stand-in) |
| `TODO(clock-monotonic)` | `clock.ts` | Detect wall-clock changes after sync using monotonic uptime (needs a small native module) |

A standalone customer wallet app is not built yet; the merchant app's Payer mode shows the flow. `PayerWallet` (sync, then `pay(request)`) is all it needs from core. Give it a durable `PayerStore` (SecureStore/SQLCipher).

## Conventions

- TypeScript strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM, `.js` import specifiers in packages.
- Amounts are strings and get compared in stroops (`toStroops`). Never use floats.
- Errors that callers branch on are `GhostRailError` with a `code`.
- Tests use vitest. Inject `Clock`, `Submitter`, and `Confirmer` fakes rather than mocking modules.
