import { afterEach, describe, expect, it, vi } from "vitest";
import { doRefUrl, encodeUniversalKey, postToDurableObject } from "./workerdRpcRelay.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workerdRpcRelay", () => {
  it("routes userland DOs through the UniversalDO facet host (/_u/)", () => {
    const ref = {
      source: "workspace/workers/gad store",
      className: "EventStore",
      objectKey: "ctx/tree:chat",
    };
    expect(doRefUrl(ref, "__lifecycle/prepare now")).toBe(
      `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__lifecycle/prepare%20now`
    );
  });

  it("routes internal DOs through their static namespace (/_w/), encoding source segments", () => {
    expect(
      doRefUrl(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: "ctx/tree:chat" },
        "__lifecycle/prepare now"
      )
    ).toBe(
      `/_w/${INTERNAL_DO_SOURCE.split("/").map(encodeURIComponent).join("/")}/WorkspaceDO/ctx%2Ftree%3Achat/__lifecycle/prepare%20now`
    );
  });

  // Inbound dispatch converged on envelope-via-__rpc: the relay POSTs an
  // RpcEnvelope to the DO's single `__rpc` endpoint and unwraps a response
  // envelope; caller attribution rides in `envelope.delivery.caller`.
  function responseEnvelope(result: unknown): Response {
    return new Response(
      JSON.stringify({
        from: "do",
        target: "main",
        delivery: { caller: { callerId: "do", callerKind: "do" } },
        provenance: [],
        message: { type: "response", requestId: "x", result },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("POSTs an envelope to __rpc, stamps the dispatch secret, and unwraps the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseEnvelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postToDurableObject(
        { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
        "ping",
        ["arg"],
        {
          workerdUrl: "http://127.0.0.1:8787",
          workerdGatewayToken: "gateway-token",
          workerdDispatchSecret: "dispatch-secret",
        }
      )
    ).resolves.toEqual({ ok: true });

    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" };
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__rpc`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token",
          "X-NatStack-Dispatch-Secret": "dispatch-secret",
        }),
      })
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.message).toMatchObject({ type: "request", method: "ping", args: ["arg"] });
  });

  it("annotates fetch failures with the DO relay URL and low-level cause", async () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw fetchError;
      })
    );

    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" };
    const url = `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__rpc`;

    await expect(
      postToDurableObject(ref, "ping", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).rejects.toThrow(
      `DO RPC fetch to ${url} failed: fetch failed (cause: Error: other side closed code=UND_ERR_SOCKET)`
    );
  });

  it("carries caller identity in the envelope's delivery.caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseEnvelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await postToDurableObject(
      { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
      "ping",
      [],
      {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
        callerId: "panel:parent-entity",
        callerKind: "panel",
        callerPanelId: "parent-slot",
      }
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.delivery.caller).toEqual({
      callerId: "panel:parent-entity",
      callerKind: "panel",
      callerPanelId: "parent-slot",
    });
  });
});
