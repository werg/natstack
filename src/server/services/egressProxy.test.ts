import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import type { AuditEntry, Credential } from "../../../packages/shared/src/credentials/types.js";
import { mintCallerAssertion } from "../../../packages/shared/src/identity/callerAssertion.js";
import { EgressProxy } from "./egressProxy.js";
import { CredentialLifecycleError } from "./credentialLifecycle.js";

class MemoryCredentialStore {
  constructor(private readonly credentials = new Map<string, Credential>()) {}

  loadUrlBound(id: string): Credential | null {
    return this.credentials.get(id) ?? null;
  }

  listUrlBound(): Credential[] {
    return [...this.credentials.values()];
  }

  saveUrlBound(credential: Credential & { id: string }): void {
    this.credentials.set(credential.id, credential);
  }
}

class MemoryAuditLog {
  readonly entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

class MemoryCapabilityGrantStore {
  readonly grants = new Map<string, { credentialSelectionId?: string | null }>();

  hasGrant(capability: string, resourceKey: string, identity: { repoPath: string; effectiveVersion: string }): boolean {
    return !!this.getGrant(capability, resourceKey, identity);
  }

  getGrant(capability: string, resourceKey: string, identity: { repoPath: string; effectiveVersion: string }): { credentialSelectionId?: string | null } | null {
    return this.grants.get(this.key(capability, resourceKey, identity)) ?? null;
  }

  grant(
    capability: string,
    resourceKey: string,
    identity: { repoPath: string; effectiveVersion: string },
    scope: string,
    options: { credentialSelectionId?: string | null } = {}
  ): void {
    if (scope === "session" || scope === "version" || scope === "repo") {
      this.grants.set(this.key(capability, resourceKey, identity), options);
    }
  }

  private key(capability: string, resourceKey: string, identity: { repoPath: string; effectiveVersion: string }): string {
    return `${capability}:${resourceKey}:${identity.repoPath}:${identity.effectiveVersion}`;
  }
}

function createCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    label: "Example",
    owner: { sourceId: "/repo", sourceKind: "workspace", label: "/repo" },
    bindings: [
      {
        id: "api",
        use: "fetch",
        audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
        injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
      },
    ],
    providerId: "url-bound",
    connectionId: "cred-1",
    connectionLabel: "Example",
    accountIdentity: { providerUserId: "acct-1" },
    accessToken: "secret-token",
    scopes: ["read"],
    ...overrides,
  };
}

function createProxy(
  credential = createCredential(),
  auditLog = new MemoryAuditLog(),
  assertionSecret?: Buffer,
): EgressProxy {
  return new EgressProxy({
    credentialStore: new MemoryCredentialStore(
      new Map([[credential.id ?? credential.connectionId, credential]])
    ),
    auditLog: auditLog as never,
    codeIdentityResolver: {
      resolveByCallerId: (callerId: string) =>
        callerId === "worker:test"
          ? { callerId, callerKind: "worker", repoPath: "/repo", effectiveVersion: "hash-1" }
          : null,
    },
    assertionSecret,
  });
}

function basicProxyAuthorization(secret: Buffer, callerId = "worker:test"): string {
  const assertion = mintCallerAssertion(secret, {
    callerId,
    callerKind: "worker",
    audience: "egress-proxy",
  });
  return `Basic ${Buffer.from(`natstack:${assertion}`, "utf8").toString("base64")}`;
}

function proxyGet(port: number, target: string, proxyAuthorization?: string): Promise<{
  statusCode: number;
  body: string;
}>;
function proxyGet(
  port: number,
  target: string,
  proxyAuthorization: string | undefined,
  extraHeaders: Record<string, string>
): Promise<{
  statusCode: number;
  body: string;
}>;
function proxyGet(
  port: number,
  target: string,
  proxyAuthorization?: string,
  extraHeaders: Record<string, string> = {}
): Promise<{
  statusCode: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: target,
        headers: {
          ...extraHeaders,
          ...(proxyAuthorization ? { "Proxy-Authorization": proxyAuthorization } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function proxyConnect(
  proxyPort: number,
  authority: string,
  proxyAuthorization?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1", () => {
      socket.write(
        [
          `CONNECT ${authority} HTTP/1.1`,
          `Host: ${authority}`,
          ...(proxyAuthorization ? [`Proxy-Authorization: ${proxyAuthorization}`] : []),
          "",
          "",
        ].join("\r\n")
      );
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

function runProxyFetch(
  proxy: EgressProxy,
  params: {
    callerId: string;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    credentialId?: string;
  },
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const body = params.body;
  const bytesOut = body ? Buffer.byteLength(body) : 0;
  return proxy.executeAuthorizedRequest({
    callerId: params.callerId,
    method: params.method.toUpperCase(),
    targetUrl: new URL(params.url),
    inputHeaders: params.headers ?? {},
    credentialId: params.credentialId,
    credentialUse: "fetch",
    initialBytesOut: bytesOut,
    replaySafe: true,
    execute: async (targetUrl, headers) => {
      const response = await fetch(targetUrl.toString(), {
        method: params.method,
        headers: headers as HeadersInit,
        body,
      });
      const responseBody = await response.text();
      return {
        statusCode: response.status,
        bytesIn: Buffer.byteLength(responseBody),
        bytesOut,
        payload: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        },
      };
    },
  });
}

function runGitHttp(
  proxy: EgressProxy,
  params: {
    callerId: string;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    credentialId?: string;
  },
): Promise<{
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array;
}> {
  const body = params.body;
  const bytesOut = body?.byteLength ?? 0;
  return proxy.executeAuthorizedRequest({
    callerId: params.callerId,
    method: params.method.toUpperCase(),
    targetUrl: new URL(params.url),
    inputHeaders: params.headers ?? {},
    credentialId: params.credentialId,
    credentialUse: "git-http",
    initialBytesOut: bytesOut,
    replaySafe: false,
    execute: async (targetUrl, headers) => {
      const response = await fetch(targetUrl.toString(), {
        method: params.method,
        headers: headers as HeadersInit,
        body: body as BodyInit | undefined,
      });
      const responseBody = new Uint8Array(await response.arrayBuffer());
      return {
        statusCode: response.status,
        bytesIn: responseBody.byteLength,
        bytesOut,
        payload: {
          url: response.url,
          method: params.method,
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
        },
      };
    },
  });
}

describe("EgressProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("injects URL-bound credentials and strips incoming credential carriers", () => {
    const proxy = createProxy();
    const prepared = proxy.prepareForwardRequest(
      new URL("https://api.example.test/v1/items"),
      {
        Authorization: "Bearer attacker",
        "x-api-key": "attacker",
        "x-natstack-caller-id": "attacker",
        "x-safe": "keep",
        Connection: "close",
      },
      createCredential()
    );

    expect(prepared.targetUrl.toString()).toBe("https://api.example.test/v1/items");
    expect(prepared.headers).toMatchObject({
      authorization: "Bearer secret-token",
      "x-safe": "keep",
      host: "api.example.test",
    });
    expect(prepared.headers["x-api-key"]).toBeUndefined();
    expect(prepared.headers["x-natstack-caller-id"]).toBeUndefined();
    expect(prepared.headers.connection).toBeUndefined();
  });

  it("requires Basic proxy authorization on HTTP proxy requests", async () => {
    const proxy = createProxy(createCredential(), new MemoryAuditLog(), Buffer.from("a".repeat(64), "hex"));
    const port = await proxy.start();
    try {
      const response = await proxyGet(port, "http://example.test/");
      expect(response.statusCode).toBe(407);
      expect(response.body).toContain("Proxy authentication required");
    } finally {
      await proxy.stop();
    }
  });

  it("rejects a bad proxy assertion signature", async () => {
    const proxy = createProxy(createCredential(), new MemoryAuditLog(), Buffer.from("a".repeat(64), "hex"));
    const port = await proxy.start();
    try {
      const badHeader = basicProxyAuthorization(Buffer.from("b".repeat(64), "hex"));
      const response = await proxyGet(port, "http://example.test/", badHeader);
      expect(response.statusCode).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("attributes HTTP proxy requests from verified assertions", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const auditLog = new MemoryAuditLog();
    const upstream = createServer((req, res) => {
      expect(req.headers["x-natstack-caller-id"]).toBeUndefined();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("test upstream did not bind");
    }

    const proxy = createProxy(createCredential(), auditLog, assertionSecret);
    const port = await proxy.start();
    try {
      const response = await proxyGet(
        port,
        `http://127.0.0.1:${upstreamAddress.port}/`,
        basicProxyAuthorization(assertionSecret),
      );
      expect(response).toEqual({ statusCode: 200, body: "ok" });
      expect(auditLog.entries[auditLog.entries.length - 1]).toMatchObject({
        callerId: "worker:test",
        workerId: "/repo",
        status: 200,
      });
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("uses explicit credential header on HTTP proxy requests and strips it upstream", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const auditLog = new MemoryAuditLog();
    const upstream = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer secret-token");
      expect(req.headers["x-natstack-use-credential"]).toBeUndefined();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("test upstream did not bind");
    }

    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: `${origin}/v1`, match: "path-prefix" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
    });
    const proxy = createProxy(credential, auditLog, assertionSecret);
    const port = await proxy.start();
    try {
      const response = await proxyGet(
        port,
        `${origin}/v1/items`,
        basicProxyAuthorization(assertionSecret),
        {
          "X-NatStack-Use-Credential": "cred-1",
          Authorization: "Bearer attacker",
        }
      );
      expect(response).toEqual({ statusCode: 200, body: "ok" });
      expect(auditLog.entries[auditLog.entries.length - 1]).toMatchObject({
        callerId: "worker:test",
        connectionId: "cred-1",
        status: 200,
      });
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects CONNECT without opening a tunnel when egress approval is denied", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const auditLog = new MemoryAuditLog();
    let upstreamConnections = 0;
    const upstream = createServer((_req, res) => {
      upstreamConnections += 1;
      res.end("unexpected");
    });
    upstream.on("connection", () => {
      upstreamConnections += 1;
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("test upstream did not bind");
    }
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestCapability: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(),
      auditLog: auditLog as never,
      assertionSecret,
      approvalQueue: approvalQueue as never,
      capabilityGrantStore: new MemoryCapabilityGrantStore() as never,
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) =>
          callerId === "worker:test"
            ? { callerId, callerKind: "worker", repoPath: "/repo", effectiveVersion: "hash-1" }
            : null,
      },
    });
    const port = await proxy.start();
    try {
      const response = await proxyConnect(
        port,
        `127.0.0.1:${upstreamAddress.port}`,
        basicProxyAuthorization(assertionSecret)
      );
      expect(response).toContain("HTTP/1.1 403 Forbidden");
      expect(upstreamConnections).toBe(0);
      expect(auditLog.entries[auditLog.entries.length - 1]).toMatchObject({
        callerId: "worker:test",
        status: 403,
      });
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("dispatches internal gateway CONNECT tunnel requests with verified caller identity", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const auditLog = new MemoryAuditLog();
    const gatewayPort = 43210;
    const gateway = {
      handleHttpRequest: vi.fn((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        expect(req.natstackCaller).toMatchObject({
          callerId: "worker:test",
          callerKind: "worker",
        });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`internal:${req.url}`);
      }),
      handleUpgrade: vi.fn(),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(),
      auditLog: auditLog as never,
      assertionSecret,
      gateway: gateway as never,
      gatewayPort,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    const port = await proxy.start();
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(port, "127.0.0.1", () => {
          socket.write(
            [
              `CONNECT 127.0.0.1:${gatewayPort} HTTP/1.1`,
              `Host: 127.0.0.1:${gatewayPort}`,
              `Proxy-Authorization: ${basicProxyAuthorization(assertionSecret)}`,
              "",
              "POST /rpc HTTP/1.1",
              `Host: 127.0.0.1:${gatewayPort}`,
              "Connection: close",
              "",
              "",
            ].join("\r\n")
          );
        });
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          data += chunk;
        });
        socket.on("end", () => resolve(data));
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("HTTP/1.1 200 Connection Established");
      expect(response).toContain("internal:/rpc");
      expect(gateway.handleHttpRequest).toHaveBeenCalledTimes(1);
      expect(auditLog.entries[auditLog.entries.length - 1]).toMatchObject({
        callerId: "worker:test",
        status: 200,
        method: "CONNECT",
      });
    } finally {
      await proxy.stop();
    }
  });

  it("parses bracketed IPv6 CONNECT authorities before internal gateway dispatch", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const gatewayPort = 43210;
    const gateway = {
      handleHttpRequest: vi.fn((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`internal:${req.natstackCaller?.callerId}:${req.url}`);
      }),
      handleUpgrade: vi.fn(),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(),
      auditLog: new MemoryAuditLog() as never,
      assertionSecret,
      gateway: gateway as never,
      gatewayPort,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    const port = await proxy.start();
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(port, "127.0.0.1", () => {
          socket.write(
            [
              `CONNECT [::1]:${gatewayPort} HTTP/1.1`,
              `Host: [::1]:${gatewayPort}`,
              `Proxy-Authorization: ${basicProxyAuthorization(assertionSecret)}`,
              "",
              "GET /healthz HTTP/1.1",
              `Host: [::1]:${gatewayPort}`,
              "Connection: close",
              "",
              "",
            ].join("\r\n")
          );
        });
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          data += chunk;
        });
        socket.on("end", () => resolve(data));
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("HTTP/1.1 200 Connection Established");
      expect(response).toContain("internal:worker:test:/healthz");
      expect(gateway.handleHttpRequest).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.stop();
    }
  });

  it("rejects internal gateway fallback paths before panel HTTP fallback can handle them", async () => {
    const assertionSecret = Buffer.from("a".repeat(64), "hex");
    const gatewayPort = 43210;
    const gateway = {
      handleHttpRequest: vi.fn((_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("unexpected");
      }),
      handleUpgrade: vi.fn(),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(),
      auditLog: new MemoryAuditLog() as never,
      assertionSecret,
      gateway: gateway as never,
      gatewayPort,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    const port = await proxy.start();
    try {
      const response = await proxyGet(
        port,
        `http://127.0.0.1:${gatewayPort}/`,
        basicProxyAuthorization(assertionSecret)
      );

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("internal-route-not-exposed");
      expect(gateway.handleHttpRequest).not.toHaveBeenCalled();
    } finally {
      await proxy.stop();
    }
  });

  it("injects query-param credentials by replacing any incoming value", () => {
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
          injection: { type: "query-param", name: "key" },
        },
      ],
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://api.example.test/v1/items?key=attacker&x=1"),
      { authorization: "Bearer attacker" },
      credential
    );

    expect(prepared.targetUrl.toString()).toBe(
      "https://api.example.test/v1/items?x=1&key=secret-token"
    );
    expect(prepared.headers.authorization).toBeUndefined();
  });

  it("injects only cookie-session cookies matching request domain and path", () => {
    const credential = createCredential({
      bindings: [
        {
          id: "app",
          use: "fetch",
          audience: [{ url: "https://app.example.test/", match: "origin" }],
          injection: { type: "cookie" },
        },
      ],
      cookieHeader: "sid=secret; admin=wrong-path",
      cookieSession: {
        origins: ["https://app.example.test"],
        cookies: [
          { name: "sid", value: "secret", domain: "app.example.test", path: "/", secure: true },
          {
            name: "admin",
            value: "wrong-path",
            domain: "app.example.test",
            path: "/admin",
            secure: true,
          },
          {
            name: "other",
            value: "wrong-domain",
            domain: "other.example.test",
            path: "/",
            secure: true,
          },
        ],
      },
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://app.example.test/dashboard"),
      {},
      credential
    );

    expect(prepared.headers.cookie).toBe("sid=secret");
  });

  it("injects basic auth credentials for git-http bindings", () => {
    const credential = createCredential({
      bindings: [
        {
          id: "github-git",
          use: "git-http",
          audience: [{ url: "https://github.com/", match: "origin" }],
          injection: {
            type: "basic-auth",
            usernameTemplate: "x-access-token",
            passwordTemplate: "{token}",
          },
        },
      ],
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://github.com/acme/project.git/info/refs?service=git-upload-pack"),
      { authorization: "Bearer attacker" },
      credential,
      credential.bindings![0]
    );

    expect(prepared.headers.authorization).toBe("Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu");
  });

  it("signs AWS SigV4 requests at egress time", () => {
    const credential = createCredential({
      accessToken: "AKIATEST",
      awsSecretAccessKey: "aws-secret",
      awsSessionToken: "session-token",
      bindings: [
        {
          id: "aws",
          use: "fetch",
          audience: [{ url: "https://s3.us-east-1.amazonaws.com/", match: "origin" }],
          injection: { type: "aws-sigv4", service: "s3", region: "us-east-1" },
        },
      ],
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://s3.us-east-1.amazonaws.com/bucket/key"),
      { authorization: "Bearer attacker" },
      credential,
      credential.bindings![0],
      "GET"
    );

    expect(prepared.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
    expect(prepared.headers.authorization).toContain("SignedHeaders=");
    expect(prepared.headers["x-amz-date"]).toBeTypeOf("string");
    expect(prepared.headers["x-amz-security-token"]).toBe("session-token");
  });

  it("redacts query-param credentials from audit URLs", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
          injection: { type: "query-param", name: "key" },
        },
      ],
    });
    const proxy = createProxy(credential, auditLog);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL) => new Response("ok", { status: 200, statusText: "OK" })
      )
    );

    await runProxyFetch(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items?key=attacker&x=1",
      method: "GET",
    });

    expect(String(fetch).includes("secret-token")).toBe(false);
    expect(auditLog.entries[0]?.url).toBe(
      "https://api.example.test/v1/items?key=%5Bredacted%5D&x=1"
    );
    expect(JSON.stringify(auditLog.entries)).not.toContain("secret-token");
  });

  it("forwards fetches through matching URL-bound credentials", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(_input)).toBe("https://api.example.test/v1/items");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
        return new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    const response = await runProxyFetch(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
      headers: { authorization: "Bearer attacker" },
    });

    expect(response).toMatchObject({ status: 200, body: "ok" });
    expect(auditLog.entries[0]).toMatchObject({
      callerId: "worker:test",
      providerId: "url-bound",
      connectionId: "cred-1",
      status: 200,
      scopesUsed: ["read"],
    });
  });

  it("refreshes expired OAuth credentials before injection", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1,
      metadata: { clientConfigId: "google", clientConfigVersion: "v1" },
    });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const credentialLifecycle = {
      refreshIfNeeded: vi.fn(async (current: Credential & { id: string }) => {
        const updated = {
          ...current,
          accessToken: "fresh-token",
          expiresAt: Date.now() + 3_600_000,
        };
        store.saveUrlBound(updated);
        return updated;
      }),
    };
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: auditLog as never,
      credentialLifecycle: credentialLifecycle as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
        return new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    await runProxyFetch(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(credentialLifecycle.refreshIfNeeded).toHaveBeenCalled();
    expect(store.loadUrlBound("cred-1")?.accessToken).toBe("fresh-token");
  });

  it("surfaces stable OAuth refresh errors from egress", async () => {
    const credential = createCredential({
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1,
      metadata: { clientConfigId: "google", clientConfigVersion: "missing" },
    });
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(new Map([[credential.id!, credential]])),
      auditLog: new MemoryAuditLog() as never,
      credentialLifecycle: {
        refreshIfNeeded: vi.fn(async () => {
          throw new CredentialLifecycleError("client_not_authorized");
        }),
      } as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      runProxyFetch(proxy, {
        callerId: "worker:test",
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      })
    ).rejects.toThrow("client_not_authorized");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards git HTTP requests through git-http bindings", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      bindings: [
        {
          id: "github-git",
          use: "git-http",
          audience: [{ url: "https://github.com/", match: "origin" }],
          injection: {
            type: "basic-auth",
            usernameTemplate: "x-access-token",
            passwordTemplate: "{token}",
          },
        },
      ],
    });
    const proxy = createProxy(credential, auditLog);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(_input)).toBe("https://github.com/acme/project.git/git-upload-pack");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu"
        );
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        expect(Array.from(body)).toEqual([1, 2, 3]);
        return new Response(new Uint8Array([4, 5]), { status: 200, statusText: "OK" });
      })
    );

    const response = await runGitHttp(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://github.com/acme/project.git/git-upload-pack",
      method: "POST",
      headers: { authorization: "Bearer attacker" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(Array.from(response.body)).toEqual([4, 5]);
    expect(auditLog.entries[0]).toMatchObject({
      callerId: "worker:test",
      connectionId: "cred-1",
      method: "POST",
      status: 200,
    });
  });

  it("requests git-specific approval copy metadata for git HTTP writes", async () => {
    const credential = createCredential({
      bindings: [
        {
          id: "github-git",
          use: "git-http",
          audience: [{ url: "https://github.com/", match: "origin" }],
          injection: {
            type: "basic-auth",
            usernameTemplate: "x-access-token",
            passwordTemplate: "{token}",
          },
        },
      ],
    });
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
      requestCapability: vi.fn(async () => ({ decision: "once" as const, credentialSelectionId: JSON.stringify(["cred-1", "github-git"]) })),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const capabilityGrantStore = new MemoryCapabilityGrantStore();
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(new Map([[credential.id!, credential]])),
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      capabilityGrantStore: capabilityGrantStore as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(), { status: 200, statusText: "OK" }))
    );

    await runGitHttp(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://github.com/acme/project.git/git-receive-pack",
      method: "POST",
    });

    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "egress",
        details: expect.arrayContaining([
          { label: "Credential", value: "Example" },
          { label: "Credential binding", value: "github-git" },
          { label: "Git operation", value: "git push" },
          { label: "Git remote", value: "https://github.com/acme/project.git" },
          { label: "Git service", value: "git-receive-pack" },
        ]),
      })
    );
  });

  it("offers all matching implicit credentials plus no credential in one egress approval", async () => {
    const credentialA = createCredential({
      id: "cred-1",
      label: "Credential A",
      accessToken: "secret-a",
    });
    const credentialB = createCredential({
      id: "cred-2",
      connectionId: "cred-2",
      label: "Credential B",
      accessToken: "secret-b",
    });
    const selected = JSON.stringify(["cred-2", "api"]);
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestCapability: vi.fn(async (req: { credentialOptions?: unknown }) => {
        expect(req.credentialOptions).toEqual([
          {
            selectionId: JSON.stringify(["cred-1", "api"]),
            label: "Credential A (api)",
            description: "api",
          },
          {
            selectionId: selected,
            label: "Credential B (api)",
            description: "api",
          },
          {
            selectionId: null,
            label: "No credential",
            description: "Send the request without credential injection",
          },
        ]);
        return { decision: "session" as const, credentialSelectionId: selected };
      }),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(new Map([
        [credentialA.id!, credentialA],
        [credentialB.id!, credentialB],
      ])),
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      capabilityGrantStore: new MemoryCapabilityGrantStore() as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-b");
        return new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    const response = await runProxyFetch(proxy, {
      callerId: "worker:test",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
  });

  it("retries replay-safe retryable responses and records retry count", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 503, statusText: "Service Unavailable" })
          : new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    const response = await runProxyFetch(proxy, {
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(auditLog.entries[0]).toMatchObject({ retries: 1, breakerState: "closed" });
  });

  it("rejects audience and caller mismatches before forwarding", async () => {
    const proxy = createProxy();
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      runProxyFetch(proxy, {
        callerId: "worker:test",
        credentialId: "cred-1",
        url: "https://api.example.test/v2/items",
        method: "GET",
      })
    ).rejects.toThrow(/credential-audience-mismatch/);

    await expect(
      runProxyFetch(proxy, {
        callerId: "worker:other",
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      })
    ).rejects.toThrow(/credential-caller-not-granted/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps session grants in memory across callers with the same code version", async () => {
    const credential = createCredential();
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestCapability: vi.fn(async () => ({ decision: "session" as const, credentialSelectionId: JSON.stringify(["cred-1", "api"]) })),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const capabilityGrantStore = new MemoryCapabilityGrantStore();
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      capabilityGrantStore: capabilityGrantStore as never,
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => {
          if (callerId === "worker:first" || callerId === "do:worker:first") {
            return {
              callerId,
              callerKind: "worker",
              repoPath: "/repo",
              effectiveVersion: "hash-1",
            };
          }
          return null;
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
    );

    await runProxyFetch(proxy, {
      callerId: "worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await runProxyFetch(proxy, {
      callerId: "do:worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(
      capabilityGrantStore.getGrant("egress", "https://api.example.test", {
        repoPath: "/repo",
        effectiveVersion: "hash-1",
      })
    ).toMatchObject({ credentialSelectionId: JSON.stringify(["cred-1", "api"]) });
  });

  it.each(["version", "repo"] as const)(
    "reuses persisted %s capability grants across callers",
    async (decision) => {
      const credential = createCredential();
      const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
      const approvalQueue = {
        request: vi.fn(async () => decision),
        requestCapability: vi.fn(async () => ({ decision, credentialSelectionId: JSON.stringify(["cred-1", "api"]) })),
        resolve: vi.fn(),
        listPending: vi.fn(() => []),
      };
      const capabilityGrantStore = new MemoryCapabilityGrantStore();
      const proxy = new EgressProxy({
        credentialStore: store,
        auditLog: new MemoryAuditLog() as never,
        approvalQueue: approvalQueue as never,
        capabilityGrantStore: capabilityGrantStore as never,
        codeIdentityResolver: {
          resolveByCallerId: (callerId: string) => {
            if (callerId === "worker:first" || callerId === "do:worker:first") {
              return {
                callerId,
                callerKind: "worker",
                repoPath: "/repo",
                effectiveVersion: "hash-1",
              };
            }
            return null;
          },
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
      );

      await runProxyFetch(proxy, {
        callerId: "worker:first",
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      });
      await runProxyFetch(proxy, {
        callerId: "do:worker:first",
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      });

      expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
      expect(
        capabilityGrantStore.getGrant("egress", "https://api.example.test", {
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        })
      ).toMatchObject({ credentialSelectionId: JSON.stringify(["cred-1", "api"]) });
    }
  );
});
