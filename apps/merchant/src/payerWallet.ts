import { Keypair } from "@stellar/stellar-sdk";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { FRIENDBOT_URL, PayerWallet, type PayerSnapshot, type PayerStore, type PendingDebit } from "@ghostrail/core";
import { openPayerStore } from "./db";

/** The only payer value kept in SecureStore. Everything else lives in the encrypted database. */
const SECRET_KEY = "ghostrail.payer-secret";
/** Where builds before the SQLite move kept the whole snapshot. Read once by the migration, then deleted. */
const LEGACY_SNAPSHOT_KEY = "ghostrail.payer-snapshot";
const SECURE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** The payer's testnet key, created on first use from OS randomness and kept in the keystore. */
export async function loadPayerKeypair(): Promise<Keypair> {
  const secret = await SecureStore.getItemAsync(SECRET_KEY);
  if (secret) return Keypair.fromSecret(secret);
  // expo-crypto rather than Keypair.random(): Hermes has no crypto.getRandomValues by default.
  const keypair = Keypair.fromRawEd25519Seed(Crypto.getRandomBytes(32));
  await SecureStore.setItemAsync(SECRET_KEY, keypair.secret(), SECURE);
  return keypair;
}

/**
 * One-time move of a SecureStore-held snapshot into `store`. Crash-safe order:
 * write SQLite first, then delete the old key; if SQLite already has state
 * (an earlier run got that far), SQLite wins and the leftover is just deleted.
 *
 * A corrupt legacy value is left in place and reported: deleting it could
 * forget pending payments and later reuse their sequence numbers.
 */
export async function migrateLegacySnapshot(store: PayerStore): Promise<"none" | "migrated" | "discarded-duplicate"> {
  const raw = await SecureStore.getItemAsync(LEGACY_SNAPSHOT_KEY);
  if (raw === null) return "none";
  let outcome: "migrated" | "discarded-duplicate" = "discarded-duplicate";
  if (!(await store.load())) {
    let legacy: PayerSnapshot;
    try {
      legacy = JSON.parse(raw) as PayerSnapshot;
    } catch {
      throw new Error("Stored payer state is corrupt; not migrating it (see payerWallet.ts)");
    }
    // Older entries had no maxTime; null means "never expire locally", the safe reading.
    const pending = (legacy.pending ?? []).map((p: Partial<PendingDebit>) => ({ ...p, maxTime: p.maxTime ?? null }));
    await store.save({ ...legacy, pending: pending as PendingDebit[] });
    outcome = "migrated";
  }
  await SecureStore.deleteItemAsync(LEGACY_SNAPSHOT_KEY);
  return outcome;
}

/**
 * Opens the payer: secret key from SecureStore, state from the encrypted database.
 * TODO(payer-app): a standalone wallet would use its own database and UI.
 */
export async function createPayer(): Promise<{ wallet: PayerWallet; publicKey: string }> {
  const keypair = await loadPayerKeypair();
  const store = await openPayerStore();
  await migrateLegacySnapshot(store);
  return { wallet: new PayerWallet(store, keypair), publicKey: keypair.publicKey() };
}

/** Testnet only: asks Friendbot to create and fund the payer account. */
export async function fundWithFriendbot(publicKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed: HTTP ${res.status}`);
}
