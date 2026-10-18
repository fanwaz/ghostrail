import { defineConfig } from "vitest/config";

// Only plain-TS modules are tested here; native modules are mocked per test.
// hookTimeout: db.test re-imports modules per test to simulate fresh launches, which is slow on a cold cache.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], hookTimeout: 30_000 } });
