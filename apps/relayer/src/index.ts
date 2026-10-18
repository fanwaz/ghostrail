import { Keypair } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, HorizonGateway, NetworkClock, fetchLatestLedgerCloseTime } from "@ghostrail/core";
import { buildApp } from "./app.js";

const CLOCK_SYNC_MS = 5 * 60_000;

/** Testnet sponsor that pays fee-bumps. Without RELAYER_SPONSOR_SECRET, a fresh one is funded by Friendbot. */
async function loadSponsor(): Promise<Keypair> {
  const secret = process.env.RELAYER_SPONSOR_SECRET;
  if (secret) return Keypair.fromSecret(secret);
  const sponsor = Keypair.random();
  const res = await fetch(`${FRIENDBOT_URL}?addr=${sponsor.publicKey()}`);
  if (!res.ok) throw new Error(`Friendbot failed to fund sponsor: HTTP ${res.status}`);
  return sponsor;
}

const gateway = new HorizonGateway();
const clock = new NetworkClock();
await clock.sync(() => fetchLatestLedgerCloseTime());
setInterval(() => void clock.sync(() => fetchLatestLedgerCloseTime()).catch(() => undefined), CLOCK_SYNC_MS).unref();

const sponsor = await loadSponsor();
const app = buildApp({ submitter: gateway, confirmer: gateway, sponsor, clock: clock.now }, { logger: true });
app.log.info({ sponsor: sponsor.publicKey(), clockOffsetSeconds: clock.offsetSeconds }, "relayer ready");

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
