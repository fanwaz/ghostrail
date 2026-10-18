import { Keypair } from "@stellar/stellar-sdk";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { FRIENDBOT_URL, PayerWallet, type PayerSnapshot, type PayerStore } from "@ghostrail/core";

const SECRET_KEY = "ghostrail.payer-secret";
const SNAPSHOT_KEY = "ghostrail.payer-snapshot";
const SECURE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/**
 * Payer snapshot in the OS keystore. Durable when `save` resolves, which
 * PayerWallet relies on to never reuse a sequence number.
 * TODO(payer-app): a standalone wallet should keep this in its SQLCipher DB;
 * SecureStore values are meant to stay small (pending debits grow while offline).
 */
export class SecureStorePayerStore implements PayerStore {
  async load(): Promise<PayerSnapshot | undefined> {
    const raw = await SecureStore.getItemAsync(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as PayerSnapshot) : undefined;
  }

  async save(snapshot: PayerSnapshot): Promise<void> {
    await SecureStore.setItemAsync(SNAPSHOT_KEY, JSON.stringify(snapshot), SECURE);
  }
}

/** The payer's testnet key, created on first use from OS randomness and kept in the keystore. */
export async function loadPayerKeypair(): Promise<Keypair> {
  const secret = await SecureStore.getItemAsync(SECRET_KEY);
  if (secret) return Keypair.fromSecret(secret);
  // expo-crypto rather than Keypair.random(): Hermes has no crypto.getRandomValues by default.
  const keypair = Keypair.fromRawEd25519Seed(Crypto.getRandomBytes(32));
  await SecureStore.setItemAsync(SECRET_KEY, keypair.secret(), SECURE);
  return keypair;
}

export async function createPayer(): Promise<{ wallet: PayerWallet; publicKey: string }> {
  const keypair = await loadPayerKeypair();
  return { wallet: new PayerWallet(new SecureStorePayerStore(), keypair), publicKey: keypair.publicKey() };
}

/** Testnet only: asks Friendbot to create and fund the payer account. */
export async function fundWithFriendbot(publicKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed: HTTP ${res.status}`);
}
