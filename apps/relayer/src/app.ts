import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  GhostRailError,
  systemClock,
  type Clock,
  type Confirmer,
  type RelayResponse,
  type Submitter,
} from "@ghostrail/core";
import { validateForRelay } from "./validate.js";

export interface RelayerDeps {
  submitter: Submitter;
  confirmer: Confirmer;
  clock?: Clock;
}

const HASH_PATTERN = "^[0-9a-f]{64}$";

/**
 * Builds the relayer HTTP app. Stateless apart from an in-flight map: the tx
 * hash is the idempotency key, and Horizon is the source of truth.
 *
 * Routes:
 *   POST /v1/transactions        { xdr }  → RelayResponse (never claims settlement)
 *   GET  /v1/transactions/:hash           → Horizon confirmation for the hash
 *   GET  /health
 *
 * TODO(rate-limit): register @fastify/rate-limit per merchant key.
 * TODO(fee-bump): optionally wrap envelopes in a sponsored fee bump.
 */
export function buildApp(deps: RelayerDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const clock = deps.clock ?? systemClock;
  const inFlight = new Map<string, Promise<{ code: number; body: RelayResponse }>>();
  const app = Fastify(options);

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: { xdr: string } }>(
    "/v1/transactions",
    {
      schema: {
        body: {
          type: "object",
          required: ["xdr"],
          additionalProperties: false,
          properties: { xdr: { type: "string", minLength: 1, maxLength: 20_000 } },
        },
      },
    },
    async (request, reply) => {
      let hash: string;
      try {
        hash = validateForRelay(request.body.xdr, clock);
      } catch (err) {
        if (!(err instanceof GhostRailError)) throw err;
        return reply.code(400).send({ hash: "", status: "rejected", code: err.code, retryable: false, error: err.message });
      }

      // Concurrent posts of the same envelope share one submit.
      let pending = inFlight.get(hash);
      if (!pending) {
        pending = relay(deps, hash, request.body.xdr).finally(() => inFlight.delete(hash));
        inFlight.set(hash, pending);
      }
      const { code, body } = await pending;
      return reply.code(code).send(body);
    },
  );

  app.get<{ Params: { hash: string } }>(
    "/v1/transactions/:hash",
    { schema: { params: { type: "object", properties: { hash: { type: "string", pattern: HASH_PATTERN } } } } },
    async (request, reply) => {
      try {
        return await deps.confirmer.confirm(request.params.hash);
      } catch (err) {
        request.log.warn({ err }, "Horizon lookup failed");
        return reply.code(502).send({ error: "Horizon lookup failed" });
      }
    },
  );

  return app;
}

async function relay(deps: RelayerDeps, hash: string, xdr: string): Promise<{ code: number; body: RelayResponse }> {
  // Idempotency: if Horizon already has this hash, don't submit again.
  try {
    const existing = await deps.confirmer.confirm(hash);
    if (existing.found) return { code: 200, body: { hash, status: "confirmed" } };
  } catch {
    // Lookup failure is not fatal; submitting the same envelope twice is harmless.
  }

  const outcome = await deps.submitter.submit(xdr);
  switch (outcome.kind) {
    case "accepted":
      // 202, not 200: acceptance is not settlement; clients confirm by hash.
      return { code: 202, body: { hash, status: "accepted" } };
    case "rejected":
      return { code: 400, body: { hash, status: "rejected", code: outcome.code, retryable: outcome.retryable } };
    case "unknown":
      return { code: 502, body: { hash, status: "unknown", error: outcome.error } };
  }
}
