import type { SubmitOutcome, Submitter } from "./horizon.js";

/** Body returned by the relayer's POST /submit. */
export interface RelayResponse {
  /** The customer's (inner) tx hash: the idempotency key. */
  hash: string;
  /** Hash of the relayer's fee-bump wrapper, for debugging only. */
  feeBumpHash?: string;
  /** "confirmed" means the relayer already saw the hash on Horizon; it is still re-checked by the caller. */
  status: "accepted" | "rejected" | "unknown" | "confirmed";
  code?: string;
  retryable?: boolean;
  error?: string;
}

/**
 * Submits through the GhostRail relayer instead of Horizon directly.
 * Only a submitter: settlement is always confirmed against Horizon by the
 * caller, so a buggy or malicious relayer cannot mark a payment settled.
 *
 * TODO(auth): send a merchant API key once the relayer requires one.
 */
export class RelayerSubmitter implements Submitter {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submit(xdr: string): Promise<SubmitOutcome> {
    let body: RelayResponse;
    try {
      const response = await this.fetchImpl(new URL("/submit", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xdr }),
      });
      body = (await response.json()) as RelayResponse;
      if (!response.ok && body.status !== "rejected") {
        return { kind: "unknown", hash: body.hash ?? "", error: `Relayer HTTP ${response.status}` };
      }
    } catch (err) {
      return { kind: "unknown", hash: "", error: err instanceof Error ? err.message : String(err) };
    }
    switch (body.status) {
      case "accepted":
      case "confirmed":
        return { kind: "accepted", hash: body.hash };
      case "rejected":
        return { kind: "rejected", hash: body.hash, code: body.code ?? "unknown", retryable: body.retryable ?? false };
      default:
        return { kind: "unknown", hash: body.hash, error: body.error ?? "Relayer outcome unknown" };
    }
  }
}
