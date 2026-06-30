import { describe, expect, it, vi } from "vitest";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import type { ServerClient } from "./serverClient.js";

type GatewayStream = (service: string, method: string, args: unknown[]) => Promise<Response>;

/** Minimal ServerClient stub — the façade only ever touches `.stream`. */
function fakeServerClient(stream: GatewayStream): ServerClient {
  return {
    call: async () => undefined,
    stream,
    callAs: async () => undefined,
    addMessageListener: () => () => {},
    isConnected: () => true,
    getConnectionStatus: () => "connected",
    close: async () => undefined,
  } as unknown as ServerClient;
}

interface CapturedDescriptor {
  path: string;
  method?: string;
  headers?: Record<string, string>;
}

describe("startPanelAssetFacade", () => {
  it("streams the body, status, and forwarded headers from gateway.fetch", async () => {
    const body = "<!DOCTYPE html><html><body>shell panel</body></html>";

    let captured: CapturedDescriptor | undefined;
    const stream = vi.fn<GatewayStream>(async (_service, _method, args) => {
      captured = (args as [CapturedDescriptor])[0];
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-natstack-build-revision": "7",
          // A stale hop header that must NOT be echoed (body is re-framed + re-sent).
          "content-encoding": "gzip",
        },
      });
    });

    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/?contextId=ctx-1`, {
        headers: { authorization: "Bearer tkn-1", "x-not-forwarded": "1" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("x-natstack-build-revision")).toBe("7");
      // content-encoding stripped → the outer fetch reads plain bytes.
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(body);
    } finally {
      await facade.close();
    }

    // Assert the forwarded descriptor outside the façade's try/catch so a failed
    // expectation surfaces directly instead of being masked as a 502.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith("gateway", "fetch", expect.any(Array));
    expect(captured?.path).toBe("/apps/shell/?contextId=ctx-1");
    expect(captured?.method).toBe("GET");
    // Allowlisted request header forwarded; non-listed header dropped.
    expect(captured?.headers?.["authorization"]).toBe("Bearer tkn-1");
    expect(captured?.headers?.["x-not-forwarded"]).toBeUndefined();
  });

  it("streams a large body (multi-MB) without a size limit", async () => {
    // The whole point of streaming: a body far larger than any single-message
    // data-channel limit flows through chunked.
    const big = "x".repeat(5 * 1024 * 1024);
    const stream = vi.fn<GatewayStream>(async () => new Response(big, { status: 200 }));
    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/bundle.js`);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBe(big.length);
    } finally {
      await facade.close();
    }
  });

  it("responds 502 when the gateway.fetch stream rejects", async () => {
    const stream = vi.fn<GatewayStream>(async () => {
      throw new Error("pipe down");
    });

    const facade = await startPanelAssetFacade(fakeServerClient(stream));
    try {
      const res = await fetch(`http://127.0.0.1:${facade.port}/apps/shell/bundle.js`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Panel asset bridge error");
    } finally {
      await facade.close();
    }
  });
});
