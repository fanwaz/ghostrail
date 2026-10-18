import { Keypair } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL } from "@ghostrail/core";

export interface SponsorEnv {
  NODE_ENV?: string | undefined;
  RELAYER_SPONSOR_SECRET?: string | undefined;
}

export interface SponsorDeps {
  /** Funds a new testnet account; defaults to Friendbot. */
  fund?: (publicKey: string) => Promise<void>;
  warn?: (message: string) => void;
}

/**
 * Loads the testnet account that pays fee-bumps.
 *
 * - Production (NODE_ENV=production) requires RELAYER_SPONSOR_SECRET, so the
 *   sponsor's address (and its balance) stays the same across restarts.
 * - Otherwise, a temporary Friendbot-funded sponsor is created with a warning.
 */
export async function loadSponsor(env: SponsorEnv, deps: SponsorDeps = {}): Promise<Keypair> {
  const secret = env.RELAYER_SPONSOR_SECRET;
  if (secret) return Keypair.fromSecret(secret);
  if (env.NODE_ENV === "production") {
    throw new Error("RELAYER_SPONSOR_SECRET is required when NODE_ENV=production");
  }
  const sponsor = Keypair.random();
  await (deps.fund ?? friendbotFund)(sponsor.publicKey());
  (deps.warn ?? console.warn)(
    `RELAYER_SPONSOR_SECRET not set: using temporary sponsor ${sponsor.publicKey()}; it is replaced on every restart`,
  );
  return sponsor;
}

async function friendbotFund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot failed to fund sponsor: HTTP ${res.status}`);
}
