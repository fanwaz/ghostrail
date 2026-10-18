import { HorizonGateway } from "@ghostrail/core";
import { buildApp } from "./app.js";

const gateway = new HorizonGateway();
const app = buildApp({ submitter: gateway, confirmer: gateway }, { logger: true });

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
