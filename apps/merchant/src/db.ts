import { open, type DB } from "@op-engineering/op-sqlite";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { SqlPayerStore, SqlQueueStore, toHex, type SqlDriver } from "@ghostrail/core";

const KEY_NAME = "ghostrail.db-key";
const DB_NAME = "ghostrail.db";

/**
 * Returns the SQLCipher key, creating a random 256-bit one on first launch.
 * The key lives in the OS keystore (Keychain / Android Keystore), never in JS storage.
 */
async function getDatabaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return existing;
  const key = toHex(Crypto.getRandomBytes(32));
  await SecureStore.setItemAsync(KEY_NAME, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return key;
}

/** Adapts an op-sqlite connection to core's SqlDriver. */
export function toDriver(db: DB): SqlDriver {
  return {
    async execute(sql, params) {
      const result = await db.execute(sql, params);
      return { rows: result.rows, rowsAffected: result.rowsAffected };
    },
  };
}

let shared: Promise<SqlDriver> | null = null;

/**
 * The app's one encrypted database connection, shared by the payment queue and
 * the payer wallet. SQLCipher is enabled by the `"op-sqlite": { "sqlcipher": true }`
 * block in package.json (native rebuild required).
 */
export function openDatabase(): Promise<SqlDriver> {
  shared ??= getDatabaseKey()
    .then((encryptionKey) => toDriver(open({ name: DB_NAME, encryptionKey })))
    .catch((err: unknown) => {
      shared = null; // let a later call retry
      throw err;
    });
  return shared;
}

export async function openQueueStore(): Promise<SqlQueueStore> {
  return SqlQueueStore.open(await openDatabase());
}

export async function openPayerStore(): Promise<SqlPayerStore> {
  return SqlPayerStore.open(await openDatabase());
}
