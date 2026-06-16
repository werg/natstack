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
});
