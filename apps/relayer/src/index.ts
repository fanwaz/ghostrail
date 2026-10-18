import { HorizonGateway, NetworkClock, fetchLatestLedgerCloseTime } from "@ghostrail/core";
import { buildApp } from "./app.js";
import { loadSponsor } from "./sponsor.js";

const CLOCK_SYNC_MS = 5 * 60_000;

const sponsor = await loadSponsor(process.env); // fails fast in production without a secret
const gateway = new HorizonGateway();
const clock = new NetworkClock();
await clock.sync(() => fetchLatestLedgerCloseTime());
setInterval(() => void clock.sync(() => fetchLatestLedgerCloseTime()).catch(() => undefined), CLOCK_SYNC_MS).unref();

const app = buildApp({ submitter: gateway, confirmer: gateway, sponsor, clock: clock.now }, { logger: true });
app.log.info({ sponsor: sponsor.publicKey(), clockOffsetSeconds: clock.offsetSeconds }, "relayer ready");

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
