// Runs every package's tests with the testnet e2e suites enabled.
// A script rather than `GHOSTRAIL_TESTNET=1 pnpm ...` so it also works in Windows cmd.
import { spawnSync } from "node:child_process";

const { status } = spawnSync("pnpm", ["-r", "--if-present", "test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, GHOSTRAIL_TESTNET: "1" },
});
process.exit(status ?? 1);
