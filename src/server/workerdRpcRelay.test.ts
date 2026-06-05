import { describe, expect, it, vi } from "vitest";
import { doRefUrl, encodeUniversalKey, postToDurableObject } from "./workerdRpcRelay.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

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

  it("stamps the workerd dispatch secret on DO relay requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
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

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey({ source: "workers/agent", className: "AgentDO", objectKey: "channel-1" }))}/ping`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token",
          "X-NatStack-Dispatch-Secret": "dispatch-secret",
        }),
      })
    );
  });

  it("forwards caller identity headers including resolved panel slot id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
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

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey({ source: "workers/agent", className: "AgentDO", objectKey: "channel-1" }))}/ping`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Natstack-Rpc-Caller-Id": "panel:parent-entity",
          "X-Natstack-Rpc-Caller-Kind": "panel",
          "X-Natstack-Rpc-Caller-Panel-Id": "parent-slot",
        }),
      })
    );
  });
});
