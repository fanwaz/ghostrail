import { open } from "@op-engineering/op-sqlite";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { SqlQueueStore, toHex, type SqlDriver } from "@ghostrail/core";

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

/**
 * Opens the encrypted payment queue. SQLCipher is enabled by the
 * `"op-sqlite": { "sqlcipher": true }` block in package.json (native rebuild required).
 */
export async function openQueueStore(): Promise<SqlQueueStore> {
  const db = open({ name: DB_NAME, encryptionKey: await getDatabaseKey() });
  const driver: SqlDriver = {
    async execute(sql, params) {
      const result = await db.execute(sql, params);
      return { rows: result.rows, rowsAffected: result.rowsAffected };
    },
  };
  return SqlQueueStore.open(driver);
}
