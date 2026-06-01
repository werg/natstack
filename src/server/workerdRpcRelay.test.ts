import { describe, expect, it, vi } from "vitest";
import { doRefUrl, postToDurableObject } from "./workerdRpcRelay.js";

describe("workerdRpcRelay", () => {
  it("encodes arbitrary-depth DO source paths segment by segment", () => {
    expect(
      doRefUrl(
        {
          source: "workspace/workers/gad store",
          className: "EventStore",
          objectKey: "ctx/tree:chat",
        },
        "__lifecycle/prepare now"
      )
    ).toBe(
      "/_w/workspace/workers/gad%20store/EventStore/ctx%2Ftree%3Achat/__lifecycle/prepare%20now"
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
      "http://127.0.0.1:8787/_w/workers/agent/AgentDO/channel-1/ping",
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
      "http://127.0.0.1:8787/_w/workers/agent/AgentDO/channel-1/ping",
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
