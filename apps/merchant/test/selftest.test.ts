import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) }));

/**
 * Fake op-sqlite with SQLCipher-like behaviour: each named file remembers the
 * key it was created with, and the wrong key makes queries fail. `mode` lets a
 * test simulate a plain-SQLite build or one that ignores the key.
 */
const fake = { mode: "sqlcipher" as "sqlcipher" | "plain" | "ignores-key", files: new Map<string, { key: string; db: DatabaseSync }>() };
vi.mock("@op-engineering/op-sqlite", () => ({
  open: ({ name, encryptionKey }: { name: string; encryptionKey: string }) => {
    let file = fake.files.get(name);
    if (!file) fake.files.set(name, (file = { key: encryptionKey, db: new DatabaseSync(":memory:") }));
    const f = file;
    return {
      execute: async (sql: string, params: (string | number)[] = []) => {
        if (fake.mode !== "ignores-key" && f.key !== encryptionKey) throw new Error("file is not a database");
        if (sql === "PRAGMA cipher_version") return { rows: fake.mode === "plain" ? [] : [{ cipher_version: "4.6.1 community" }], rowsAffected: 0 };
        const st = f.db.prepare(sql);
        if (st.columns().length > 0) return { rows: st.all(...params), rowsAffected: 0 };
        return { rows: [], rowsAffected: Number(st.run(...params).changes) };
      },
      close: () => {},
      delete: () => void fake.files.delete(name),
    };
  },
}));

const checks = await import("../src/selftest/checks.js");

beforeEach(() => {
  secure.clear();
  fake.files.clear();
  fake.mode = "sqlcipher";
});

describe("automatic self-test checks", () => {
  it.each(checks.AUTO_CHECKS.map((c) => [c.name, c] as const))("%s passes on a healthy device", async (_name, check) => {
    const result = await checks.runCheck(check);
    expect(result, result.detail).toMatchObject({ status: "pass" });
  });

  it("leave no test data behind", async () => {
    for (const check of checks.AUTO_CHECKS) await checks.runCheck(check);
    expect(secure.size).toBe(0);
    expect(fake.files.size).toBe(0);
  });

  it("SQLCipher check fails on a plain SQLite build", async () => {
    fake.mode = "plain";
    expect(await checks.runCheck(checks.sqlcipherCheck)).toMatchObject({ status: "fail", detail: expect.stringMatching(/not SQLCipher/) });
  });

  it("SQLCipher check fails if the database opens with the wrong key", async () => {
    fake.mode = "ignores-key";
    expect(await checks.runCheck(checks.sqlcipherCheck)).toMatchObject({ status: "fail", detail: expect.stringMatching(/not encrypted/) });
  });

  it("reports thrown errors as failures with the reason, including missing globals", async () => {
    const result = await checks.runCheck({
      name: "x",
      run: async () => {
        throw new ReferenceError("Buffer is not defined");
      },
    });
    expect(result).toMatchObject({ status: "fail", detail: "ReferenceError: Buffer is not defined" });
  });
});

describe("QR checks", () => {
  const own = "0123456789abcdef";

  it("accepts another device's self-test code", () => {
    expect(checks.checkScannedPayload(checks.makeSelfTestPayload("fedcba9876543210"), own)).toMatch(/another device/);
  });

  it("rejects this device's own code, other QR content, and malformed codes", () => {
    expect(() => checks.checkScannedPayload(checks.makeSelfTestPayload(own), own)).toThrow(/own code/);
    expect(() => checks.checkScannedPayload("ghostrail:req:v1:abc", own)).toThrow(/something else/);
    expect(() => checks.checkScannedPayload(`${checks.SELFTEST_QR_PREFIX}xyz`, own)).toThrow(/malformed/);
  });

  it("accepts real PNG output and rejects empty or non-PNG output", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]).toString("base64");
    expect(checks.checkQrDataUrl(png)).toMatch(/rendered/);
    expect(() => checks.checkQrDataUrl("")).toThrow(/too short/);
    expect(() => checks.checkQrDataUrl("A".repeat(200))).toThrow(/not a PNG/);
  });
});
