import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer } from "ws";

import type { AuditEntry, Credential } from "../../../packages/shared/src/credentials/types.js";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { EgressProxy } from "./egressProxy.js";
import { CredentialSessionGrantStore } from "./credentialSessionGrants.js";
import { CredentialLifecycleError } from "./credentialLifecycle.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createApprovalQueue, type ApprovalQueue } from "./approvalQueue.js";

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

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-egress-"));
}

function workerCaller(callerId: string) {
  return createVerifiedCaller(callerId, "worker", {
    callerId,
    callerKind: "worker",
    repoPath: callerId.startsWith("do:") ? "/repo" : "/repo",
    effectiveVersion: "hash-1",
  });
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
    grants: [
      {
        bindingId: "api",
        use: "fetch",
        resource: "https://api.example.test/v1",
        action: "use",
        scope: "caller",
        callerId: "worker:test",
        grantedAt: 1,
        grantedBy: "self",
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
  extraDeps: Partial<ConstructorParameters<typeof EgressProxy>[0]> = {}
): EgressProxy {
  return new EgressProxy({
    credentialStore: new MemoryCredentialStore(
      new Map([[credential.id ?? credential.connectionId, credential]])
    ),
    auditLog: auditLog as never,
    ...extraDeps,
  });
}

function createApprovalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    submitClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

function requestThroughHttpProxy(params: {
  proxyPort: number;
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: params.proxyPort,
        method: params.method ?? "GET",
        path: params.targetUrl,
        headers: {
          ...(params.body ? { "Content-Length": Buffer.byteLength(params.body) } : {}),
          ...params.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.end(params.body);
  });
}

function requestWebSocketUpgradeThroughProxy(params: {
  proxyPort: number;
  targetUrl: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: IncomingMessage["headers"]; body?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: params.proxyPort,
      method: "GET",
      path: params.targetUrl,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...params.headers,
      },
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
    });
    req.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function encodeWebSocketMetadata(headers: Array<[string, string]>): string {
  return Buffer.from(JSON.stringify(headers)).toString("base64url");
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
    expect(prepared.headers.connection).toBeUndefined();
  });

  it("allows authenticated loopback platform RPC callbacks through direct proxy", async () => {
    let received: { url?: string; authorization?: string; runtimeId?: string; body?: string } = {};
    const target = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = {
          url: req.url,
          authorization: req.headers.authorization,
          runtimeId: req.headers["x-natstack-runtime-id"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok" }));
      });
    });
    const proxy = createProxy();
    let proxyPort = 0;
    let targetPort = 0;
    try {
      targetPort = await new Promise<number>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", () => {
          target.off("error", reject);
          resolve((target.address() as AddressInfo).port);
        });
      });
      proxyPort = await proxy.start();

      const res = await requestThroughHttpProxy({
        proxyPort,
        targetUrl: `http://127.0.0.1:${targetPort}/rpc`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer platform-token",
          "X-Natstack-Runtime-Id": "do:workers/agent-worker:AiChatWorker:agent-1",
        },
        body: JSON.stringify({ type: "emit" }),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ok" });
      expect(received).toMatchObject({
        url: "/rpc",
        authorization: "Bearer platform-token",
        runtimeId: "do:workers/agent-worker:AiChatWorker:agent-1",
        body: JSON.stringify({ type: "emit" }),
      });
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("rejects unauthenticated direct proxy HTTP forwarding", async () => {
    const proxy = createProxy();
    try {
      const proxyPort = await proxy.start();
      const res = await fetch(`http://127.0.0.1:${proxyPort}/anything`, {
        headers: { Host: "example.test", "X-Forwarded-Proto": "https" },
      });
      expect(res.status).toBe(403);
      await expect(res.text()).resolves.toContain(
        "Direct egress proxy HTTP forwarding requires an attributed workerd service"
      );
    } finally {
      await proxy.stop();
    }
  });

  it("forwards attributed WebSocket upgrades with injected URL-bound credentials", async () => {
    const auditLog = new MemoryAuditLog();
    const upstreamServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => {
        resolve((upstreamServer.address() as AddressInfo).port);
      });
    });
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: `http://127.0.0.1:${upstreamPort}/v1`, match: "path-prefix" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
      grants: [
        {
          bindingId: "api",
          use: "fetch",
          resource: `http://127.0.0.1:${upstreamPort}/v1`,
          action: "use",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
        },
      ],
    });
    const proxy = createProxy(credential, auditLog);
    proxy.setCallerResolver((callerId) =>
      callerId === "worker:test" ? workerCaller(callerId) : null
    );
    const proxyPort = await proxy.startShared("secret");
    let observedAuthorization: string | undefined;
    let observedOpenAIBeta: string | undefined;
    let observedOrigin: string | undefined;
    let observedUrl: string | undefined;

    upstreamServer.on("upgrade", (req, socket, head) => {
      observedAuthorization = req.headers.authorization;
      observedOpenAIBeta = req.headers["openai-beta"] as string | undefined;
      observedOrigin = req.headers.origin;
      observedUrl = req.url;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(1000, "done");
      });
    });

    try {
      const response = await requestWebSocketUpgradeThroughProxy({
        proxyPort,
        targetUrl: `ws://127.0.0.1:${upstreamPort}/v1/socket?__natstack_ws_headers=${encodeURIComponent(
          encodeWebSocketMetadata([
            ["openai-beta", "responses=experimental; websockets=v1"],
            ["origin", `http://127.0.0.1:${upstreamPort}`],
            ["authorization", "Bearer attacker"],
          ])
        )}`,
        headers: {
          Authorization: "Bearer sentinel",
          Origin: "http://127.0.0.1:12345",
          "X-NatStack-Egress-Caller": "worker:test",
          "X-NatStack-Egress-Secret": "secret",
        },
      });

      expect(response.status).toBe(101);
      expect(observedAuthorization).toBe("Bearer secret-token");
      expect(observedOpenAIBeta).toBe("responses=experimental; websockets=v1");
      expect(observedOrigin).toBe(`http://127.0.0.1:${upstreamPort}`);
      expect(observedUrl).toBe("/v1/socket");
      expect(auditLog.entries[auditLog.entries.length - 1]).toMatchObject({
        callerId: "worker:test",
        method: "GET",
        status: 101,
      });
    } finally {
      await proxy.stop();
      wss.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("does not forward local WebSocket proxy-hop origin without provider metadata", async () => {
    const auditLog = new MemoryAuditLog();
    const upstreamServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => {
        resolve((upstreamServer.address() as AddressInfo).port);
      });
    });
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: `http://127.0.0.1:${upstreamPort}/v1`, match: "path-prefix" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
      grants: [
        {
          bindingId: "api",
          use: "fetch",
          resource: `http://127.0.0.1:${upstreamPort}/v1`,
          action: "use",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
        },
      ],
    });
    const proxy = createProxy(credential, auditLog);
    proxy.setCallerResolver((callerId) =>
      callerId === "worker:test" ? workerCaller(callerId) : null
    );
    const proxyPort = await proxy.startShared("secret");
    let observedOrigin: string | undefined;

    upstreamServer.on("upgrade", (req, socket, head) => {
      observedOrigin = req.headers.origin;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(1000, "done");
      });
    });

    try {
      const response = await requestWebSocketUpgradeThroughProxy({
        proxyPort,
        targetUrl: `ws://127.0.0.1:${upstreamPort}/v1/socket`,
        headers: {
          Origin: "http://127.0.0.1:12345",
          "X-NatStack-Egress-Caller": "worker:test",
          "X-NatStack-Egress-Secret": "secret",
        },
      });

      expect(response.status).toBe(101);
      expect(observedOrigin).toBeUndefined();
    } finally {
      await proxy.stop();
      wss.close();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("logs sanitized upstream WebSocket upgrade rejections", async () => {
    const auditLog = new MemoryAuditLog();
    const upstreamServer = createServer((_req, res) => {
      res.writeHead(403, {
        "Content-Type": "text/plain",
        "Set-Cookie": "secret=session",
        "X-Reject-Reason": "origin",
      });
      res.end("bad websocket origin");
    });
    const upstreamPort = await new Promise<number>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => {
        resolve((upstreamServer.address() as AddressInfo).port);
      });
    });
    const credential = createCredential({
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: `http://127.0.0.1:${upstreamPort}/v1`, match: "path-prefix" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
      grants: [
        {
          bindingId: "api",
          use: "fetch",
          resource: `http://127.0.0.1:${upstreamPort}/v1`,
          action: "use",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
        },
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const proxy = createProxy(credential, auditLog);
    proxy.setCallerResolver((callerId) =>
      callerId === "worker:test" ? workerCaller(callerId) : null
    );
    const proxyPort = await proxy.startShared("secret");

    try {
      const response = await requestWebSocketUpgradeThroughProxy({
        proxyPort,
        targetUrl: `ws://127.0.0.1:${upstreamPort}/v1/socket?__natstack_ws_headers=${encodeURIComponent(
          encodeWebSocketMetadata([
            ["openai-beta", "responses=experimental; websockets=v1"],
            ["origin", `http://127.0.0.1:${upstreamPort}`],
            ["cookie", "session=secret; csrf=hidden"],
            ["chatgpt-account-id", "account-secret"],
          ])
        )}`,
        headers: {
          Authorization: "Bearer sentinel",
          Origin: "http://127.0.0.1:12345",
          "X-NatStack-Egress-Caller": "worker:test",
          "X-NatStack-Egress-Secret": "secret",
        },
      });

      expect(response.status).toBe(403);
      expect(response.body).toBe("bad websocket origin");
      expect(warn).toHaveBeenCalledWith(
        "[EgressProxy] WebSocket upgrade failed",
        expect.objectContaining({
          phase: "upstream_response",
          reason: "upstream_non_upgrade_response",
          statusCode: 403,
          target: `ws://127.0.0.1:${upstreamPort}/v1/socket`,
          body: "bad websocket origin",
          requestHeaders: expect.objectContaining({
            authorization: "Bearer [redacted]",
            "chatgpt-account-id": "[redacted]",
            cookie: "session; csrf",
            origin: `http://127.0.0.1:${upstreamPort}`,
            "openai-beta": "responses=experimental; websockets=v1",
            "sec-websocket-key": "[redacted]",
            "sec-websocket-version": "13",
          }),
          responseHeaders: expect.not.objectContaining({ "set-cookie": expect.anything() }),
        })
      );
      const diagnostic = warn.mock.calls.find(
        (call) => call[0] === "[EgressProxy] WebSocket upgrade failed"
      )?.[1] as { requestHeaders?: Record<string, string> } | undefined;
      expect(diagnostic?.requestHeaders).not.toHaveProperty("sec-websocket-extensions");
    } finally {
      warn.mockRestore();
      await proxy.stop();
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it("gates attributed raw workerd HTTP egress through capability approval", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential({ bindings: [] }), auditLog, {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });
    const target = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("raw-ok");
    });

    try {
      const targetPort = await new Promise<number>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", () => {
          target.off("error", reject);
          resolve((target.address() as AddressInfo).port);
        });
      });
      const proxyPort = await proxy.startForCaller(workerCaller("worker:test"));

      const res = await requestThroughHttpProxy({
        proxyPort,
        targetUrl: `http://127.0.0.1:${targetPort}/raw`,
      });

      expect(res.status).toBe(200);
      expect(res.body).toBe("raw-ok");
      expect(approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "capability",
          capability: "external-network-fetch",
          callerId: "worker:test",
          repoPath: "/repo",
          resource: {
            type: "url-origin",
            label: "Target origin",
            value: `http://127.0.0.1:${targetPort}`,
          },
        })
      );
      expect(auditLog.entries[0]).toMatchObject({
        callerId: "worker:test",
        workerId: "/repo",
        providerId: "passthrough",
        status: 200,
      });
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("reuses raw workerd egress approvals by origin", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const proxy = createProxy(createCredential({ bindings: [] }), new MemoryAuditLog(), {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });
    const target = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    try {
      const targetPort = await new Promise<number>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", () => {
          target.off("error", reject);
          resolve((target.address() as AddressInfo).port);
        });
      });
      const proxyPort = await proxy.startForCaller(workerCaller("worker:test"));
      for (const path of ["/one", "/two"]) {
        const res = await requestThroughHttpProxy({
          proxyPort,
          targetUrl: `http://127.0.0.1:${targetPort}${path}`,
        });
        expect(res.status).toBe(200);
      }
      expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => target.close(() => resolve()));
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
      grants: [
        {
          bindingId: "github-git",
          use: "git-http",
          resource: "https://github.com/acme/project.git",
          action: "read",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
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
      grants: [
        {
          bindingId: "app",
          use: "fetch",
          resource: "https://app.example.test/",
          action: "use",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
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
      grants: [
        {
          bindingId: "github-git",
          use: "git-http",
          resource: "https://github.com/acme/project.git",
          action: "read",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
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

    await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
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

    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
      headers: { authorization: "Bearer attacker" },
    });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("ok");
    expect(response.finalUrl).toBe("https://api.example.test/v1/items");
    expect(Array.isArray(response.headerPairs)).toBe(true);
    expect(auditLog.entries[0]).toMatchObject({
      callerId: "worker:test",
      providerId: "url-bound",
      connectionId: "cred-1",
      status: 200,
      scopesUsed: ["read"],
    });
  });

  it("preserves multiple Set-Cookie headers across the wire", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        headers.append("content-type", "text/plain");
        return new Response("ok", { status: 200, statusText: "OK", headers });
      })
    );
    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/login",
      method: "GET",
    });
    const cookieEntries = response.headerPairs.filter(([k]) => k.toLowerCase() === "set-cookie");
    expect(cookieEntries.map(([, v]) => v)).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("reports the post-redirect final URL on `finalUrl`", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    // We can't easily simulate a redirect through the stub since fetch is
    // stubbed wholesale, so simulate by constructing a Response with a url
    // distinct from the requested one. The proxy's `response.url || requestedUrl`
    // fallback path is what we want to exercise.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = new Response("ok", { status: 200 });
        // Most runtimes set Response.url to "" for synthetically constructed
        // Responses; the proxy must fall back to the requested URL.
        return r;
      })
    );
    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    expect(response.finalUrl).toBe("https://api.example.test/v1/items");
  });

  it("round-trips binary response bodies as bytes", async () => {
    // Verifies parity for web_fetch: a PDF magic-header sequence must
    // come back byte-identical after going through the proxy.
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(pdfMagic, {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/pdf" },
          })
      )
    );
    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/doc.pdf",
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(response.body)).toEqual(Array.from(pdfMagic));
    const contentType = response.headerPairs.find(([k]) => k.toLowerCase() === "content-type")?.[1];
    expect(contentType).toBe("application/pdf");
  });

  it("round-trips binary request bodies as bytes", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    const upload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    let receivedBody: Uint8Array | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const ab = await new Response(init?.body as BodyInit).arrayBuffer();
        receivedBody = new Uint8Array(ab);
        return new Response(null, { status: 204 });
      })
    );
    await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/upload",
      method: "POST",
      body: upload,
    });
    expect(receivedBody).not.toBeNull();
    expect(Array.from(receivedBody!)).toEqual(Array.from(upload));
  });

  it("streams upstream response bytes through forwardProxyFetchStream", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    // Upstream emits the body as three discrete chunks separated by
    // microtask boundaries. The streaming forwarder must surface each
    // chunk as it arrives — not buffer the whole body.
    const chunks = [
      new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]), // "hello"
      new Uint8Array([0x20]), // " "
      new Uint8Array([0x77, 0x6f, 0x72, 0x6c, 0x64]), // "world"
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
              // Yield so the consumer can observe chunks individually.
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        });
      })
    );

    const observed: Array<{ kind: string; size?: number; status?: number; finalUrl?: string }> = [];
    let aggregated = new Uint8Array(0);
    const result = await proxy.forwardProxyFetchStream(
      {
        caller: workerCaller("worker:test"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/stream",
        method: "GET",
      },
      (frame) => {
        if (frame.kind === "head") {
          observed.push({ kind: "head", status: frame.status, finalUrl: frame.finalUrl });
        } else if (frame.kind === "chunk") {
          observed.push({ kind: "chunk", size: frame.bytes.byteLength });
          const next = new Uint8Array(aggregated.byteLength + frame.bytes.byteLength);
          next.set(aggregated, 0);
          next.set(frame.bytes, aggregated.byteLength);
          aggregated = next;
        } else if (frame.kind === "end") {
          observed.push({ kind: "end" });
        }
      }
    );

    expect(result.status).toBe(200);
    expect(result.bytesIn).toBe(11);
    expect(observed[0]).toEqual({
      kind: "head",
      status: 200,
      finalUrl: "https://api.example.test/v1/stream",
    });
    expect(observed.filter((o) => o.kind === "chunk")).toHaveLength(3);
    expect(observed[observed.length - 1]!.kind).toBe("end");
    expect(new TextDecoder().decode(aggregated)).toBe("hello world");
  });

  it("does not retry retryable responses in forwardProxyFetchStream", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("retry", { status: 503, statusText: "Service Unavailable" });
      })
    );

    const frames: string[] = [];
    const result = await proxy.forwardProxyFetchStream(
      {
        caller: workerCaller("worker:test"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/stream",
        method: "GET",
      },
      (frame) => {
        frames.push(frame.kind);
      }
    );

    expect(calls).toBe(1);
    expect(result.status).toBe(503);
    expect(result.bytesIn).toBe(5);
    expect(frames).toEqual(["head", "chunk", "end"]);
    expect(auditLog.entries[0]).toMatchObject({ retries: 0 });
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
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
        return new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(credentialLifecycle.refreshIfNeeded).toHaveBeenCalled();
    expect(store.loadUrlBound("cred-1")?.accessToken).toBe("fresh-token");
  });

  it("force-refreshes OAuth credentials and retries once after upstream 401", async () => {
    const credential = createCredential({
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3_600_000,
      metadata: { clientConfigId: "openai-codex", clientConfigVersion: "v1" },
    });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const credentialLifecycle = {
      refreshIfNeeded: vi.fn(),
      refreshCredential: vi.fn(async (current: Credential & { id: string }) => {
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
      auditLog: new MemoryAuditLog() as never,
      credentialLifecycle: credentialLifecycle as never,
    });
    const seenAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        return seenAuth.length === 1
          ? new Response("expired", { status: 401, statusText: "Unauthorized" })
          : new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(credentialLifecycle.refreshCredential).toHaveBeenCalledOnce();
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  it("force-refreshes OAuth credentials before committing a 401 streaming response", async () => {
    const credential = createCredential({
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3_600_000,
      metadata: { clientConfigId: "openai-codex", clientConfigVersion: "v1" },
    });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const credentialLifecycle = {
      refreshIfNeeded: vi.fn(),
      refreshCredential: vi.fn(async (current: Credential & { id: string }) => {
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
      auditLog: new MemoryAuditLog() as never,
      credentialLifecycle: credentialLifecycle as never,
    });
    const seenAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        return seenAuth.length === 1
          ? new Response("expired", { status: 401, statusText: "Unauthorized" })
          : new Response("stream-ok", { status: 200, statusText: "OK" });
      })
    );
    const frames: string[] = [];

    const result = await proxy.forwardProxyFetchStream(
      {
        caller: workerCaller("worker:test"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      },
      (frame) => {
        frames.push(frame.kind);
      }
    );

    expect(result.status).toBe(200);
    expect(credentialLifecycle.refreshCredential).toHaveBeenCalledOnce();
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(frames).toEqual(["head", "chunk", "end"]);
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
    });
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      proxy.forwardProxyFetch({
        caller: workerCaller("worker:test"),
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
      grants: [
        {
          bindingId: "github-git",
          use: "git-http",
          resource: "https://github.com/acme/project.git",
          action: "read",
          scope: "caller",
          callerId: "worker:test",
          grantedAt: 1,
          grantedBy: "self",
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

    const response = await proxy.forwardGitHttp({
      caller: workerCaller("worker:test"),
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
      grants: [],
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
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(new Map([[credential.id!, credential]])),
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(), { status: 200, statusText: "OK" }))
    );

    await proxy.forwardGitHttp({
      caller: workerCaller("worker:test"),
      credentialId: "cred-1",
      url: "https://github.com/acme/project.git/git-receive-pack",
      method: "POST",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialUse: "git-http",
        gitOperation: {
          action: "write",
          label: "git push",
          remote: "https://github.com/acme/project.git",
          service: "git-receive-pack",
        },
      })
    );
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

    const response = await proxy.forwardProxyFetch({
      caller: workerCaller("worker:test"),
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
      proxy.forwardProxyFetch({
        caller: workerCaller("worker:test"),
        credentialId: "cred-1",
        url: "https://api.example.test/v2/items",
        method: "GET",
      })
    ).rejects.toThrow(/credential-audience-mismatch/);

    await expect(
      proxy.forwardProxyFetch({
        caller: workerCaller("worker:other"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      })
    ).rejects.toThrow(/credential-caller-not-granted/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps caller grants scoped to a concrete DO object key", async () => {
    const credential = createCredential({
      grants: [
        {
          bindingId: "api",
          use: "fetch",
          resource: "https://api.example.test/v1",
          action: "use",
          scope: "caller",
          callerId: "do:workers/agent-worker:AiChatWorker:object-a",
          grantedAt: 1,
          grantedBy: "self",
        },
      ],
    });
    const proxy = createProxy(credential);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
    );

    await proxy.forwardProxyFetch({
      caller: workerCaller("do:workers/agent-worker:AiChatWorker:object-a"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    await expect(
      proxy.forwardProxyFetch({
        caller: workerCaller("do:workers/agent-worker:AiChatWorker:object-b"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      })
    ).rejects.toThrow(/credential-caller-not-granted/);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows repo grants to span concrete DO object keys from the same source", async () => {
    const credential = createCredential({
      grants: [
        {
          bindingId: "api",
          use: "fetch",
          resource: "https://api.example.test/v1",
          action: "use",
          scope: "repo",
          repoPath: "/repo",
          grantedAt: 1,
          grantedBy: "self",
        },
      ],
    });
    const proxy = createProxy(credential);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
    );

    await proxy.forwardProxyFetch({
      caller: workerCaller("do:workers/agent-worker:AiChatWorker:object-a"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await proxy.forwardProxyFetch({
      caller: workerCaller("do:workers/agent-worker:AiChatWorker:object-b"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keys session grants to the concrete caller identity", async () => {
    const credential = createCredential({ grants: [] });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
    );

    await proxy.forwardProxyFetch({
      caller: workerCaller("worker:first"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await proxy.forwardProxyFetch({
      caller: workerCaller("do:worker:first"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(store.loadUrlBound("cred-1")?.grants).toEqual([]);
  });

  it.each(["version", "repo"] as const)(
    "reuses persisted %s grants across callers",
    async (decision) => {
      const credential = createCredential({ grants: [] });
      const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
      const approvalQueue = {
        request: vi.fn(async () => decision),
        resolve: vi.fn(),
        listPending: vi.fn(() => []),
      };
      const proxy = new EgressProxy({
        credentialStore: store,
        auditLog: new MemoryAuditLog() as never,
        approvalQueue: approvalQueue as never,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
      );

      await proxy.forwardProxyFetch({
        caller: workerCaller("worker:first"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      });
      await proxy.forwardProxyFetch({
        caller: workerCaller("do:worker:first"),
        credentialId: "cred-1",
        url: "https://api.example.test/v1/items",
        method: "GET",
      });

      expect(approvalQueue.request).toHaveBeenCalledTimes(1);
      expect(store.loadUrlBound("cred-1")?.grants).toContainEqual(
        expect.objectContaining({
          bindingId: "api",
          resource: "https://api.example.test/v1",
          action: "use",
          scope: decision,
          repoPath: "/repo",
          grantedBy: decision,
        })
      );
    }
  );

  it("resolves queued credential proxy approvals covered by a trusted version grant", async () => {
    const credential = createCredential({ grants: [] });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: new MemoryAuditLog() as never,
      approvalQueue,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }))
    );

    const first = proxy.forwardProxyFetch({
      caller: workerCaller("worker:first"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await vi.waitFor(() => expect(approvalQueue.listPending()).toHaveLength(1));
    const second = proxy.forwardProxyFetch({
      caller: workerCaller("do:worker:first"),
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await vi.waitFor(() => expect(approvalQueue.listPending()).toHaveLength(2));

    approvalQueue.resolve(approvalQueue.listPending()[0]!.approvalId, "version");

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(approvalQueue.listPending()).toEqual([]);
    expect(store.loadUrlBound("cred-1")?.grants).toContainEqual(
      expect.objectContaining({
        bindingId: "api",
        resource: "https://api.example.test/v1",
        action: "use",
        scope: "version",
        repoPath: "/repo",
        effectiveVersion: "hash-1",
      })
    );
  });
});
