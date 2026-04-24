import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { connect as netConnect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry, ConsentGrant, Credential, ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import { EgressProxy } from "./egressProxy.js";
import type { ResolvedCodeIdentity } from "./codeIdentityResolver.js";

function createProviderManifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "github",
    displayName: "GitHub",
    apiBase: ["https://api.github.com"],
    authInjection: {
      type: "header",
      headerName: "authorization",
      valueTemplate: "Bearer {token}",
    },
    flows: [],
    retry: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
    },
    ...overrides,
  };
}

function createCredential(accessToken = "token-old"): Credential {
  return {
    providerId: "github",
    connectionId: "conn-1",
    connectionLabel: "GitHub",
    accountIdentity: { providerUserId: "user-1" },
    accessToken,
    scopes: ["repo"],
  };
}

function createProxy(options: {
  manifest?: ProviderManifest;
  credentialStore?: {
    load: (providerId: string, connectionId: string) => Promise<Credential | null> | Credential | null;
    list: (providerId?: string) => Promise<Credential[]> | Credential[];
  };
  resolveProxyToken?: (token: string) => ResolvedCodeIdentity | null;
}) {
  const manifest = options.manifest ?? createProviderManifest();
  const auditEntries: AuditEntry[] = [];
  const limiter = {
    tryConsume: () => ({ allowed: true as const }),
    recordRetryAfter: vi.fn(),
  };
  const rateLimiter = {
    getLimiter: vi.fn(() => limiter),
  };
  const proxy = new EgressProxy({
    credentialStore: options.credentialStore ?? {
      load: vi.fn(async () => createCredential()),
      list: vi.fn(async () => [createCredential()]),
    },
    consentStore: {
      check: vi.fn(async () => ({
        codeIdentity: "repo-1",
        codeIdentityType: "repo",
        providerId: manifest.id,
        connectionId: "conn-1",
        scopes: ["repo"],
        grantedAt: 1,
        grantedBy: "panel-1",
      } satisfies ConsentGrant)),
    },
    providerRegistry: {
      list: vi.fn(() => [manifest]),
      matchUrl: vi.fn((targetUrl: URL) => targetUrl.host === "api.github.com" ? manifest : undefined),
    },
    auditLog: {
      append: vi.fn(async (entry: AuditEntry) => {
        auditEntries.push(entry);
      }),
    },
    rateLimiter,
    circuitBreaker: {
      canRequest: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(() => "closed" as const),
    },
    codeIdentityResolver: {
      resolveByCallerId: vi.fn(() => ({
        callerId: "worker:1",
        callerKind: "worker",
        repoPath: "/repo",
        effectiveVersion: "hash-1",
      } satisfies ResolvedCodeIdentity)),
      resolve: vi.fn((token: string) => options.resolveProxyToken?.(token) ?? null),
    },
  });

  return { proxy, auditEntries, manifest, rateLimiter, limiter };
}

async function readSocketResponse(socket: ReturnType<typeof netConnect>): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        resolve(response);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(response));
  });
}

describe("EgressProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries replay-safe proxy fetches on upstream 5xx responses", async () => {
    const { proxy, auditEntries } = createProxy({});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxy.forwardProxyFetch({
      callerId: "worker:1",
      url: "https://api.github.com/user",
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auditEntries[0]?.retries).toBe(1);
  });

  it("reloads the credential once after a 401 when a newer token exists", async () => {
    const loads = [
      createCredential("token-old"),
      createCredential("token-new"),
    ];
    const { proxy, auditEntries } = createProxy({
      credentialStore: {
        load: vi.fn(async () => loads.shift() ?? createCredential("token-new")),
        list: vi.fn(async () => [createCredential("token-old")]),
      },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer token-old") {
        return new Response("expired", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxy.forwardProxyFetch({
      callerId: "worker:1",
      url: "https://api.github.com/user",
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer token-old");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer token-new");
    expect(auditEntries[0]?.retries).toBe(1);
  });

  it("records Retry-After on 429 responses without replaying the request", async () => {
    const { proxy, auditEntries, limiter } = createProxy({});
    const fetchMock = vi.fn(async () => new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "3" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxy.forwardProxyFetch({
      callerId: "worker:1",
      url: "https://api.github.com/user",
      method: "GET",
    });

    expect(result.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(limiter.recordRetryAfter).toHaveBeenCalledWith(3);
    expect(auditEntries[0]?.retries).toBe(0);
  });

  it("rejects CONNECT requests without proxy authentication before dialing upstream", async () => {
    const { proxy, auditEntries } = createProxy({
      resolveProxyToken: () => null,
    });
    const port = await proxy.start();

    const socket = netConnect(port, "127.0.0.1");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    const response = await readSocketResponse(socket);

    expect(response).toContain("407 Proxy Authentication Required");
    expect(auditEntries.some((entry) => entry.method === "CONNECT" && entry.status === 407)).toBe(true);

    socket.destroy();
    await proxy.stop();
  });

  it("allows authenticated CONNECT requests to establish an upstream tunnel", async () => {
    const upstream = await new Promise<NetServer>((resolve) => {
      const server = createNetServer((socket) => {
        socket.end();
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const upstreamPort = (upstream.address() as { port: number }).port;

    const { proxy, auditEntries } = createProxy({
      resolveProxyToken: (token) => token === "proxy-token"
          ? {
              callerId: "worker:1",
              callerKind: "worker",
              repoPath: "/repo",
              effectiveVersion: "hash-1",
            }
        : null,
    });
    const port = await proxy.start();

    const socket = netConnect(port, "127.0.0.1");
    socket.write(
      `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${upstreamPort}\r\n` +
      "x-natstack-proxy-auth: proxy-token\r\n\r\n",
    );
    const response = await readSocketResponse(socket);

    expect(response).toContain("200 Connection Established");
    expect(auditEntries.some((entry) => entry.method === "CONNECT" && entry.status === 200)).toBe(true);

    socket.destroy();
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("does not retry streamed proxied HTTP requests after an upstream 5xx", async () => {
    let upstreamRequests = 0;
    const upstream = await new Promise<ReturnType<typeof createHttpServer>>((resolve) => {
      const server = createHttpServer((req, res) => {
        upstreamRequests += 1;
        req.resume();
        res.statusCode = 503;
        res.end("upstream failure");
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const upstreamPort = (upstream.address() as { port: number }).port;

    const manifest = createProviderManifest({
      apiBase: [`http://127.0.0.1:${upstreamPort}`],
    });
    const { proxy } = createProxy({
      manifest,
      resolveProxyToken: (token) => token === "proxy-token"
          ? {
              callerId: "worker:1",
              callerKind: "worker",
              repoPath: "/repo",
              effectiveVersion: "hash-1",
            }
        : null,
    });
    const proxyPort = await proxy.start();

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxyPort,
        method: "POST",
        path: `http://127.0.0.1:${upstreamPort}/streamed`,
        headers: {
          host: `127.0.0.1:${upstreamPort}`,
          "x-natstack-proxy-auth": "proxy-token",
          "content-type": "text/plain",
        },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end("hello");
    });

    expect(result.status).toBe(503);
    expect(result.body).toBe("upstream failure");
    expect(upstreamRequests).toBe(1);

    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});
