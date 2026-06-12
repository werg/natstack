import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "./output.js";
import { RpcClient, clearShellTokenCache, refreshShell } from "./rpcClient.js";

const CREDS = {
  url: "https://host.tailnet.ts.net",
  deviceId: "dev_cli",
  refreshToken: "refresh_cli",
};

describe("rpcClient", () => {
  beforeEach(() => {
    clearShellTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("types the refresh-shell response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              shellToken: "tok",
              callerId: "shell:dev_cli",
              deviceId: "dev_cli",
              serverId: "srv_1",
              serverBootId: "boot_1",
              workspaceId: "ws_1",
            })
          )
      )
    );
    const refresh = await refreshShell(CREDS);
    expect(refresh).toEqual({
      shellToken: "tok",
      callerId: "shell:dev_cli",
      deviceId: "dev_cli",
      label: undefined,
      serverId: "srv_1",
      serverBootId: "boot_1",
      workspaceId: "ws_1",
    });
  });

  it("rejects a refresh without a shell token as an auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unknown device" }), { status: 401 }))
    );
    await expect(refreshShell(CREDS)).rejects.toThrow(AuthError);
  });

  it("calls /rpc with a bearer token and caches it across calls", async () => {
    const requests: Array<{ url: string; auth?: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({
          url: String(url),
          auth: headers["Authorization"],
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response(JSON.stringify({ result: { ok: true } }));
      })
    );

    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toEqual({ ok: true });
    await expect(client.call("workspace.getActive", [])).resolves.toEqual({ ok: true });

    // One refresh, then two RPC posts with the same token.
    expect(requests.map((req) => req.url)).toEqual([
      "https://host.tailnet.ts.net/_r/s/auth/refresh-shell",
      "https://host.tailnet.ts.net/rpc",
      "https://host.tailnet.ts.net/rpc",
    ]);
    expect(requests[1]?.auth).toBe("Bearer tok");
    expect(requests[2]?.auth).toBe("Bearer tok");
    expect(requests[1]?.body).toEqual({ method: "meta.listServices", args: [] });
  });

  it("refreshes exactly once on a 401 and retries the call", async () => {
    let rpcCalls = 0;
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          refreshes += 1;
          return new Response(
            JSON.stringify({ shellToken: `tok_${refreshes}`, callerId: "c", deviceId: "dev_cli" })
          );
        }
        rpcCalls += 1;
        if (rpcCalls === 1) {
          return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
        }
        return new Response(JSON.stringify({ result: 42 }));
      })
    );

    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toBe(42);
    expect(refreshes).toBe(2); // initial token + the one 401-triggered refresh
    expect(rpcCalls).toBe(2);
  });

  it("fails with an auth error when 401 persists after the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toThrow(AuthError);
  });

  it("surfaces server-reported RPC errors with their code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response(JSON.stringify({ error: "boom", errorCode: "ENOENT" }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("fs.readFile", ["/missing"])).rejects.toMatchObject({
      name: "RpcError",
      message: "boom",
      errorCode: "ENOENT",
    });
  });

  it("sends the relay body shape for callTarget", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ result: "pong" }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.callTarget("worker:repo:abc", "ping", ["x"])).resolves.toBe("pong");
    expect(bodies).toEqual([
      { type: "call", targetId: "worker:repo:abc", method: "ping", args: ["x"] },
    ]);
  });

  it("rejects a 200 /rpc response without result or error keys as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toMatchObject({
      name: "RpcError",
      message: "malformed rpc response (non-JSON or proxy response?)",
    });
  });

  it("rejects a non-JSON 200 /rpc response as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response("<html>proxy says hi</html>");
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toMatchObject({
      name: "RpcError",
      message: "malformed rpc response (non-JSON or proxy response?)",
    });
  });

  it("still returns null results without treating them as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "c", deviceId: "dev_cli" })
          );
        }
        return new Response(JSON.stringify({ result: null }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toBeNull();
  });

  it("maps unreachable servers to auth/connection errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toThrow(AuthError);
  });
});
