import { defineConfig } from "vitest/config";

// Only plain-TS modules are tested here; native modules are mocked per test.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
