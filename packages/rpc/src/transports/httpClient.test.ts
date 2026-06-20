import { describe, expect, it, vi } from "vitest";
import { envelopeFromMessage } from "../envelope.js";
import { httpClientTransport } from "./httpClient.js";
import type { RpcEnvelope } from "../types.js";

function requestEnvelope(): RpcEnvelope {
  return envelopeFromMessage({
    selfId: "worker:agent",
    from: "worker:agent",
    target: "main",
    callerKind: "worker",
    message: {
      type: "request",
      requestId: "req-1",
      fromId: "worker:agent",
      method: "ping",
      args: [],
    },
  });
}

describe("httpClientTransport", () => {
  it("annotates fetch failures with the RPC endpoint and low-level cause", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65530"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "127.0.0.1",
      port: 65530,
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchMock = vi.fn(async () => {
      throw fetchError;
    }) as unknown as typeof fetch;
    const transport = httpClientTransport({
      selfId: "worker:agent",
      serverUrl: "http://127.0.0.1:65530",
      authToken: "token",
      fetch: fetchMock,
    });

    await expect(transport.send(requestEnvelope())).rejects.toThrow(
      /RPC fetch to http:\/\/127\.0\.0\.1:65530\/rpc failed after 3 attempts: fetch failed \(cause: Error: connect ECONNREFUSED 127\.0\.0\.1:65530 code=ECONNREFUSED syscall=connect address=127\.0\.0\.1 port=65530\)/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respond() resolves a rejecting error envelope on timeout (not null)", async () => {
    vi.useFakeTimers();
    try {
      const transport = httpClientTransport({
        selfId: "do:notes:Bucket:key",
        serverUrl: "http://127.0.0.1:65530",
        authToken: "token",
        // No handler ever resolves the capture — model a dropped/never-answered
        // inbound request. A short reaper deadline so the test stays fast.
        respondTimeoutMs: 100,
      });

      const settled = transport.respond(requestEnvelope());
      await vi.advanceTimersByTimeAsync(101);
      const result = await settled;

      // A9 (silent-drop): the old code resolved `null`, which downstream
      // unwrapped to `undefined` (a silent wrong result). It must resolve a
      // rejecting response envelope so the relay rejects the caller's call.
      expect(result).not.toBeNull();
      expect(result?.message).toMatchObject({
        type: "response",
        requestId: "req-1",
        errorCode: "RESPOND_TIMEOUT",
      });
      expect((result?.message as { error: string }).error).toContain("timed out after 100ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respond() never reaps when respondTimeoutMs <= 0 (held exemption preserved)", async () => {
    vi.useFakeTimers();
    try {
      const transport = httpClientTransport({
        selfId: "do:eval:EvalDO:key",
        serverUrl: "http://127.0.0.1:65530",
        authToken: "token",
        respondTimeoutMs: 0,
      });

      let settled = false;
      void transport.respond(requestEnvelope()).then(() => {
        settled = true;
      });
      // Far beyond any default deadline — the held handler must stay pending.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
