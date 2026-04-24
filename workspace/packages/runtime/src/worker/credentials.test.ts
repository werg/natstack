import { afterEach, describe, expect, it, vi } from "vitest";

import { connect } from "./credentials.js";

type TestGlobals = typeof globalThis & {
  __natstack_rpc?: unknown;
  __natstackEnv?: Record<string, string>;
};

describe("worker credentials RPC", () => {
  afterEach(() => {
    delete (globalThis as TestGlobals).__natstack_rpc;
    delete (globalThis as TestGlobals).__natstackEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts service-qualified credential methods over HTTP RPC without a duplicated main prefix", async () => {
    (globalThis as TestGlobals).__natstackEnv = {
      SERVER_URL: "http://server.test",
      RPC_AUTH_TOKEN: "worker-token",
    };

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer worker-token");

      return new Response(JSON.stringify({
        result: {
          connectionId: "conn-1",
          providerId: "github",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const handle = await connect("github");

    expect(handle.connectionId).toBe("conn-1");
    expect(handle.providerId).toBe("github");

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      targetId: string;
      method: string;
      args: unknown[];
    };
    expect(body.targetId).toBe("main");
    expect(body.method).toBe("credentials.resolveConnection");
    expect(body.method).not.toBe("main.credentials.resolveConnection");
    expect(body.args).toEqual([{ providerId: "github", connectionId: undefined }]);
  });
});
