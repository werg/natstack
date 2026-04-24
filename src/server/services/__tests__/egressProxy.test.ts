/**
 * EgressProxy strict-mode tests (audit wave-3).
 *
 * Scope (corresponds to audit findings #1, #2, #11, 03-F-03):
 *   - Workers without a matching provider declaration cannot fetch
 *     anything (request returns 403 with capability-violation body).
 *   - Workers WITH a matching provider declaration + consent grant get
 *     credential injection on outbound HTTP.
 *   - Workers WITH a provider declaration but NO consent get a clear
 *     403 message naming the provider.
 *   - CONNECT to AWS / GCP IMDS (169.254.169.254) is rejected post-DNS.
 *   - CONNECT to loopback (127.0.0.1) is rejected post-DNS.
 *   - Bypass-list workers skip provider gating but are still rejected
 *     for forbidden CONNECT targets.
 *   - Per-worker `PROXY_AUTH_TOKEN` is enforced (constant-time compare):
 *     missing token → 407, wrong token → 401, right token → pass.
 *
 * The tests use a real local HTTP listener as the upstream so we exercise
 * the full forward path including header injection, plus a real CONNECT
 * to a stub TCP server (only used for "good" target tests — denied
 * targets are rejected before any TCP socket opens).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createEgressProxy,
  type BypassRegistry,
  type CircuitBreaker,
  type ConsentStore,
  type CredentialStore,
  type EgressProxyDeps,
  type EgressRateLimiter,
  type ProviderRegistry,
  type WorkerTokenStore,
} from "../egressProxy.js";
import type {
  ConsentGrant,
  Credential,
  EndpointDeclaration,
  ProviderManifest,
} from "../../../../packages/shared/src/credentials/types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "example",
    displayName: "Example Provider",
    apiBase: ["https://api.example.test"],
    flows: [],
    ...overrides,
  };
}

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    providerId: "example",
    connectionId: "conn-1",
    connectionLabel: "Test connection",
    accountIdentity: { providerUserId: "user-1" },
    accessToken: "secret-token",
    scopes: ["read"],
    ...overrides,
  };
}

function makeGrant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    workerId: "worker-1",
    providerId: "example",
    connectionId: "conn-1",
    scopes: ["read"],
    grantedAt: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EgressProxyDeps> = {}): EgressProxyDeps {
  const provider = makeProvider();
  const cred = makeCredential();
  const grant = makeGrant();

  const credentialStore: CredentialStore = {
    getCredential: (connectionId) => (connectionId === cred.connectionId ? cred : null),
  };

  const consentStore: ConsentStore = {
    list: () => [grant],
  };

  const providerRegistry: ProviderRegistry = {
    listProviderManifests: () => [provider],
    // For tests we accept any URL inside the provider's apiBase host.
    getCapabilityDeclarations: (): EndpointDeclaration[] => [
      { url: "https://api.example.test/", methods: ["GET", "POST", "PUT", "DELETE"] },
    ],
  };

  const auditLog = { append: async () => undefined };

  const rateLimiter: EgressRateLimiter = {
    getLimiter: () => ({ tryConsume: () => ({ allowed: true as const }) }),
  };

  const circuitBreaker: CircuitBreaker = {
    canRequest: () => true,
    recordSuccess: () => undefined,
    recordFailure: () => undefined,
    getState: () => "closed" as const,
  };

  const workerTokenStore: WorkerTokenStore = {
    getToken: (workerId) => (workerId === "worker-1" ? "good-token" : null),
  };

  return {
    credentialStore,
    consentStore,
    providerRegistry,
    auditLog,
    rateLimiter,
    circuitBreaker,
    workerTokenStore,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

interface Harness {
  proxyPort: number;
  upstream: Server;
  upstreamPort: number;
  stop: () => Promise<void>;
}

async function startProxy(deps: EgressProxyDeps): Promise<{ port: number; stop: () => Promise<void> }> {
  const proxy = createEgressProxy(deps);
  const port = await proxy.start();
  return { port, stop: () => proxy.stop() };
}

async function startUpstream(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function proxyRequest(opts: {
  proxyPort: number;
  targetUrl: string;
  headers?: Record<string, string>;
  method?: string;
}): Promise<{ statusCode: number; body: string; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(opts.targetUrl);
    const req = httpRequest({
      host: "127.0.0.1",
      port: opts.proxyPort,
      method: opts.method ?? "GET",
      // Forward-proxy request: full URL on the request line.
      path: opts.targetUrl,
      headers: { host: target.host, ...(opts.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectRequest(opts: {
  proxyPort: number;
  authority: string;
  headers?: Record<string, string>;
}): Promise<{ statusLine: string; raw: string }> {
  // Use a raw TCP socket: Node's HTTP client surfaces CONNECT non-2xx
  // responses unevenly between minor versions; raw byte parsing is the
  // contract this test cares about anyway.
  return new Promise((resolve, reject) => {
    const { connect } = require("node:net") as typeof import("node:net");
    const sock = connect(opts.proxyPort, "127.0.0.1");
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("error", reject);
    sock.on("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const firstLine = raw.split("\r\n", 1)[0] ?? "";
      const statusMatch = firstLine.match(/^HTTP\/1\.[01] (\d+) (.*)$/);
      const statusLine = statusMatch ? `${statusMatch[1]} ${statusMatch[2]}` : firstLine;
      // Body starts after \r\n\r\n.
      const sep = raw.indexOf("\r\n\r\n");
      const body = sep === -1 ? "" : raw.slice(sep + 4);
      resolve({ statusLine, raw: body });
    });
    sock.on("connect", () => {
      const headerLines = ["host", opts.authority]
        .concat(Object.entries(opts.headers ?? {}).flatMap(([k, v]) => [k, v]));
      let headerStr = "";
      for (let i = 0; i < headerLines.length; i += 2) {
        headerStr += `${headerLines[i]}: ${headerLines[i + 1]}\r\n`;
      }
      sock.write(`CONNECT ${opts.authority} HTTP/1.1\r\n${headerStr}\r\n`);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EgressProxy — strict mode HTTP path", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.stop();
  });

  async function bootHarness(deps: EgressProxyDeps): Promise<void> {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const proxy = await startProxy(deps);
    harness = {
      proxyPort: proxy.port,
      upstream: upstream.server,
      upstreamPort: upstream.port,
      stop: async () => {
        await proxy.stop();
        await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      },
    };
  }

  it("rejects requests with no worker-id header (407)", async () => {
    await bootHarness(makeDeps());
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.example.test/foo",
    });
    expect(res.statusCode).toBe(407);
    expect(res.body).toMatch(/x-natstack-worker-id/i);
  });

  it("rejects requests with unknown worker id (401)", async () => {
    await bootHarness(makeDeps());
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.example.test/foo",
      headers: {
        "X-NatStack-Worker-Id": "ghost",
        "Authorization": "Bearer good-token",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatch(/Unknown worker/i);
  });

  it("rejects requests with wrong proxy auth token (401)", async () => {
    await bootHarness(makeDeps());
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.example.test/foo",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer wrong-token",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatch(/Invalid proxy auth token/);
  });

  it("rejects requests to hosts that match no provider manifest (403)", async () => {
    // The credentialStore / consentStore know about provider "example",
    // but the request targets api.unknown.test which no provider declares.
    await bootHarness(makeDeps());
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.unknown.test/foo",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/no provider/i);
  });

  it("rejects requests with provider-match but no consent grant (403)", async () => {
    // Empty consent store → no grants for any worker → 403 with provider name.
    const deps = makeDeps({
      consentStore: { list: () => [] },
    });
    await bootHarness(deps);
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.example.test/foo",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/No consent grant.*example/);
  });

  it("permits requests with provider-match + consent and injects credential bearer", async () => {
    // Point the provider apiBase at the upstream loopback we control so
    // the proxy actually forwards. Use http to keep the test simple.
    const upstream = await startUpstream((req, res) => {
      // Echo the inbound auth header back so the test can assert it.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`auth:${req.headers["authorization"] ?? ""}`);
    });
    const upstreamPort = upstream.port;
    const provider = makeProvider({
      apiBase: [`http://127.0.0.1:${upstreamPort}`],
    });
    const cred = makeCredential();
    const grant = makeGrant();
    const deps = makeDeps({
      providerRegistry: {
        listProviderManifests: () => [provider],
        getCapabilityDeclarations: () => [
          { url: `http://127.0.0.1:${upstreamPort}/**`, methods: ["GET"] },
        ],
      },
      consentStore: { list: () => [grant] },
      credentialStore: { getCredential: () => cred },
    });
    const proxy = await startProxy(deps);
    harness = {
      proxyPort: proxy.port,
      upstream: upstream.server,
      upstreamPort,
      stop: async () => {
        await proxy.stop();
        await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      },
    };

    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: `http://127.0.0.1:${upstreamPort}/foo`,
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });

    expect(res.statusCode).toBe(200);
    // Auth header on upstream must be the credential's accessToken,
    // NOT the worker's good-token (which only authenticates the proxy hop).
    expect(res.body).toBe(`auth:Bearer ${cred.accessToken}`);
  });

  it("X-NatStack-Proxy-Auth fallback header is also accepted", async () => {
    await bootHarness(makeDeps());
    const res = await proxyRequest({
      proxyPort: harness.proxyPort,
      targetUrl: "http://api.unknown.test/foo",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        // No Authorization header — fall back to legacy header.
        "X-NatStack-Proxy-Auth": "good-token",
      },
    });
    // Auth passes (no 401), but unknown host still 403s.
    expect(res.statusCode).toBe(403);
  });
});

describe("EgressProxy — hardened CONNECT", () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  it("rejects CONNECT to AWS IMDS (169.254.169.254)", async () => {
    const deps = makeDeps();
    const proxy = await startProxy(deps);
    stop = proxy.stop;

    const res = await connectRequest({
      proxyPort: proxy.port,
      authority: "169.254.169.254:443",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });

    // No provider declares 169.254.x — provider routing rejects first
    // (403 "no provider declares this host"). Either way, no tunnel.
    expect(res.statusLine.startsWith("403")).toBe(true);
  });

  it("rejects CONNECT to loopback even with bypass on (post-DNS deny)", async () => {
    // Bypass workers skip provider gating but the IP deny list still applies.
    const bypass: BypassRegistry = { has: (id) => id === "worker-1" };
    const deps = makeDeps({ bypassWorkerIds: bypass, logger: { warn: () => undefined } });
    const proxy = await startProxy(deps);
    stop = proxy.stop;

    const res = await connectRequest({
      proxyPort: proxy.port,
      authority: "127.0.0.1:443",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });

    expect(res.statusLine.startsWith("403")).toBe(true);
    expect(res.raw).toMatch(/denied address/);
  });

  it("rejects CONNECT to non-443 port (port allowlist)", async () => {
    const bypass: BypassRegistry = { has: () => true };
    const deps = makeDeps({ bypassWorkerIds: bypass, logger: { warn: () => undefined } });
    const proxy = await startProxy(deps);
    stop = proxy.stop;

    const res = await connectRequest({
      proxyPort: proxy.port,
      authority: "example.com:22",
      headers: {
        "X-NatStack-Worker-Id": "worker-1",
        "Authorization": "Bearer good-token",
      },
    });

    expect(res.statusLine.startsWith("403")).toBe(true);
    expect(res.raw).toMatch(/port 22.*not allowed/);
  });

  it("rejects CONNECT with no worker-id (407)", async () => {
    const deps = makeDeps();
    const proxy = await startProxy(deps);
    stop = proxy.stop;

    const res = await connectRequest({
      proxyPort: proxy.port,
      authority: "example.com:443",
    });
    expect(res.statusLine.startsWith("407")).toBe(true);
  });
});
