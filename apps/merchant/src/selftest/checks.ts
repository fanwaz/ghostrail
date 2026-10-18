import { open } from "@op-engineering/op-sqlite";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { buildOfflinePayment, decodeRequest, encodeRequest, toHex, verifySignedPayment, type PaymentRequest } from "@ghostrail/core";

/**
 * On-device checks for the native pieces unit tests can only mock. Each check
 * resolves to a short detail string on pass, or throws with the reason.
 * Dev-only: reached from the Self-test screen when __DEV__ is true.
 */
export interface Check {
  name: string;
  run: () => Promise<string>;
}

export interface CheckResult {
  name: string;
  status: "pass" | "fail";
  detail: string;
  ms: number;
}

export async function runCheck(check: Check): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await check.run();
    return { name: check.name, status: "pass", detail, ms: Date.now() - started };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { name: check.name, status: "fail", detail, ms: Date.now() - started };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SELFTEST_DB = "ghostrail-selftest.db";
const SELFTEST_SECURE_KEY = "ghostrail.selftest";

export const cryptoKeyCheck: Check = {
  name: "expo-crypto key generation",
  async run() {
    const a = Crypto.getRandomBytes(32);
    const b = Crypto.getRandomBytes(32);
    assert(a.length === 32, `expected 32 bytes, got ${a.length}`);
    assert(toHex(a) !== toHex(b), "two draws returned identical bytes");
    assert(a.some((x) => x !== 0), "random bytes are all zero");
    const key = Keypair.fromRawEd25519Seed(a);
    assert(StrKey.isValidEd25519PublicKey(key.publicKey()), "derived public key is invalid");
    return `keypair ${key.publicKey().slice(0, 6)}…`;
  },
};

export const stellarSignCheck: Check = {
  name: "Stellar transaction sign + verify",
  async run() {
    const payer = Keypair.fromRawEd25519Seed(Crypto.getRandomBytes(32));
    const merchant = Keypair.fromRawEd25519Seed(Crypto.getRandomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const request: PaymentRequest = {
      v: 1,
      id: "selftest",
      destination: merchant.publicKey(),
      amount: "1.5",
      asset: "native",
      expiresAt: now + 600,
    };
    // Exercises base64/TextEncoder paths used by request QR codes.
    const decoded = decodeRequest(encodeRequest(request));
    assert(decoded.amount === request.amount, "request encode/decode round trip changed the amount");

    const signed = buildOfflinePayment({
      request: decoded,
      signer: payer,
      account: { publicKey: payer.publicKey(), sequence: "0" },
      clock: () => now,
    });
    const verified = verifySignedPayment(signed.xdr, request, () => now);
    assert(verified.hash === signed.hash, "verified hash differs from signed hash");

    let tamperedRejected = false;
    try {
      verifySignedPayment(signed.xdr, { ...request, amount: "2" }, () => now);
    } catch {
      tamperedRejected = true;
    }
    assert(tamperedRejected, "verification accepted a mismatched amount");
    return `hash ${signed.hash.slice(0, 12)}…`;
  },
};

export const secureStoreCheck: Check = {
  name: "SecureStore write/read",
  async run() {
    const value = toHex(Crypto.getRandomBytes(16));
    await SecureStore.setItemAsync(SELFTEST_SECURE_KEY, value);
    try {
      const read = await SecureStore.getItemAsync(SELFTEST_SECURE_KEY);
      assert(read === value, `read back ${JSON.stringify(read)}`);
    } finally {
      await SecureStore.deleteItemAsync(SELFTEST_SECURE_KEY);
    }
    assert((await SecureStore.getItemAsync(SELFTEST_SECURE_KEY)) === null, "value survived delete");
    return "write, read, delete ok";
  },
};

export const sqlcipherCheck: Check = {
  name: "SQLCipher open/write/close/reopen/read",
  async run() {
    const key = toHex(Crypto.getRandomBytes(32));
    const value = toHex(Crypto.getRandomBytes(8));
    // Start clean in case an earlier run crashed midway.
    open({ name: SELFTEST_DB, encryptionKey: key }).delete();

    const first = open({ name: SELFTEST_DB, encryptionKey: key });
    const cipher = await first.execute("PRAGMA cipher_version");
    const cipherVersion = String(Object.values(cipher.rows[0] ?? {})[0] ?? "");
    assert(cipherVersion.length > 0, "PRAGMA cipher_version is empty: this build is plain SQLite, not SQLCipher");
    await first.execute("CREATE TABLE t (v TEXT NOT NULL)");
    await first.execute("INSERT INTO t (v) VALUES (?)", [value]);
    first.close();

    const reopened = open({ name: SELFTEST_DB, encryptionKey: key });
    const { rows } = await reopened.execute("SELECT v FROM t");
    reopened.close();
    assert(rows[0]?.v === value, `reopen read ${JSON.stringify(rows[0]?.v)}`);

    const wrongKey = open({ name: SELFTEST_DB, encryptionKey: toHex(Crypto.getRandomBytes(32)) });
    let locked = false;
    try {
      await wrongKey.execute("SELECT v FROM t");
    } catch {
      locked = true;
    }
    wrongKey.delete(); // closes and removes the test database
    assert(locked, "database was readable with the wrong key: it is not encrypted");
    return `SQLCipher ${cipherVersion}; wrong key rejected`;
  },
};

/** Checks that need no user action, in display order. */
export const AUTO_CHECKS: readonly Check[] = [cryptoKeyCheck, stellarSignCheck, secureStoreCheck, sqlcipherCheck];

export const QR_RENDER_CHECK = "QR render";
export const QR_SCAN_CHECK = "QR scan from another device";

/** Payload for the QR this device shows; the nonce tells the scanner it came from a different device. */
export const SELFTEST_QR_PREFIX = "ghostrail:selftest:";

export function makeSelfTestPayload(nonce: string): string {
  return `${SELFTEST_QR_PREFIX}${nonce}`;
}

/** Passes for a self-test QR shown by a different device (a different nonce). */
export function checkScannedPayload(data: string, ownNonce: string): string {
  assert(data.startsWith(SELFTEST_QR_PREFIX), `scanned something else: ${JSON.stringify(data.slice(0, 40))}`);
  const nonce = data.slice(SELFTEST_QR_PREFIX.length);
  assert(/^[0-9a-f]{16}$/.test(nonce), "malformed self-test code");
  assert(nonce !== ownNonce, "scanned this device's own code; scan the code on another device");
  return `read code ${nonce.slice(0, 6)}… from another device`;
}

/** Passes when react-native-qrcode-svg produced a non-trivial PNG data URL. */
export function checkQrDataUrl(base64Png: string): string {
  assert(base64Png.length > 100, `PNG data too short (${base64Png.length} chars)`);
  // The 8-byte PNG signature encodes to exactly these 10 base64 chars (the 11th mixes in the next byte).
  assert(base64Png.startsWith("iVBORw0KGg"), "output is not a PNG");
  return `rendered ${base64Png.length} chars of PNG`;
}
