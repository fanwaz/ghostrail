import { describe, expect, it } from "vitest";
import { RelayerSubmitter } from "../src/index.js";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("RelayerSubmitter", () => {
  it("posts the envelope to the relayer", async () => {
    const { impl, calls } = fakeFetch(202, { hash: "ab", status: "accepted" });
    expect(await new RelayerSubmitter("http://relay.test", impl).submit("XDR")).toEqual({ kind: "accepted", hash: "ab" });
    expect(calls[0]?.url).toBe("http://relay.test/submit");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ xdr: "XDR" }));
  });

  it("treats a relayer 'confirmed' as accepted, never as settled", async () => {
    const { impl } = fakeFetch(200, { hash: "ab", status: "confirmed" });
    expect(await new RelayerSubmitter("http://relay.test", impl).submit("XDR")).toEqual({ kind: "accepted", hash: "ab" });
  });

  it("passes rejections through", async () => {
    const { impl } = fakeFetch(400, { hash: "ab", status: "rejected", code: "tx_bad_seq", retryable: true });
    expect(await new RelayerSubmitter("http://relay.test", impl).submit("XDR")).toEqual({
      kind: "rejected",
      hash: "ab",
      code: "tx_bad_seq",
      retryable: true,
    });
  });

  it("maps relayer errors and network failures to unknown", async () => {
    const { impl } = fakeFetch(502, { hash: "ab", status: "unknown", error: "Horizon down" });
    expect(await new RelayerSubmitter("http://relay.test", impl).submit("XDR")).toMatchObject({ kind: "unknown" });

    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await new RelayerSubmitter("http://relay.test", failing).submit("XDR")).toEqual({
      kind: "unknown",
      hash: "",
      error: "offline",
    });
  });
});
