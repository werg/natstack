/**
 * Integration test — gateway dispatch via RouteRegistry.
 *
 * Boots the Gateway against a real HTTP socket, registers service routes +
 * a stub worker route (via a fake "workerd" HTTP server bound to an
 * ephemeral port) and asserts the gateway rewrites and proxies correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { TokenManager } from "@natstack/shared/tokenManager";
import { Gateway } from "./gateway.js";
import { RouteRegistry } from "./routeRegistry.js";

interface Harness {
  gateway: Gateway;
  gatewayPort: number;
  workerdPort: number;
  registry: RouteRegistry;
  tokenManager: TokenManager;
  workerdServer: HttpServer;
  /** Record of paths workerd received (for rewrite-assertion). */
  workerdPaths: string[];
}

async function startHarness(): Promise<Harness> {
  const registry = new RouteRegistry();
  const tokenManager = new TokenManager();

  // Fake workerd — records the path it was called with and echoes it back.
  const workerdPaths: string[] = [];
  const workerdServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    workerdPaths.push(req.url ?? "(unknown)");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`workerd saw ${req.url}`);
  });
  const workerdPort: number = await new Promise((resolve) => {
    workerdServer.listen(0, "127.0.0.1", () => {
      const addr = workerdServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  const gateway = new Gateway({
    externalHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    workerdPort,
    routeRegistry: registry,
    adminToken: "secret-token",
    tokenManager,
  });
  const gatewayPort = await gateway.start(0);

  return { gateway, gatewayPort, workerdPort, registry, tokenManager, workerdServer, workerdPaths };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.gateway.stop();
  await new Promise<void>((resolve) => h.workerdServer.close(() => resolve()));
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const resp = await fetch(url, init);
  const body = await resp.text();
  return { status: resp.status, body };
}

describe("RouteRegistry × Gateway integration", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await stopHarness(h); });

  it("dispatches a service route in-process", async () => {
    h.registry.registerService([{
      serviceName: "ping",
      path: "/ping",
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
      },
    }]);

    const { status, body } = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/ping/ping`);
    expect(status).toBe(200);
    expect(body).toBe("pong");
  });

  it("rewrites DO routes to /_w/{source}/{class}/{key}/{path}", async () => {
    h.registry.registerDoRoutes("workers/hello-test", "HelloDO", [{
      path: "/callback",
      durableObject: { className: "HelloDO", objectKey: "singleton" },
    }]);

    const before = h.workerdPaths.length;
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/hello-test/callback?q=1`,
    );
    expect(status).toBe(200);
    expect(h.workerdPaths.length).toBe(before + 1);
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe("/_w/workers/hello-test/HelloDO/singleton/callback?q=1");
    expect(body).toContain("/_w/workers/hello-test/HelloDO/singleton/callback");
  });

  it("rewrites regular-worker routes to /<instance>/<path>", async () => {
    h.registry.registerWorkerRoutes("workers/regular-test", "regular-test", [{
      path: "/hello",
    }]);

    const before = h.workerdPaths.length;
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/regular-test/hello`,
    );
    expect(status).toBe(200);
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe("/regular-test/hello");
    expect(h.workerdPaths.length).toBe(before + 1);
  });

  it("returns 404 for unknown /_r/ paths", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/nonexistent-svc/anything`,
    );
    expect(status).toBe(404);
  });

  it("returns 405 when path matches but method does not", async () => {
    h.registry.registerService([{
      serviceName: "only-get",
      path: "/x",
      methods: ["GET"],
      handler: (_req, res) => { res.end("ok"); },
    }]);
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/only-get/x`,
      { method: "POST" },
    );
    expect(status).toBe(405);
  });

  it("rejects admin-token-auth route without token", async () => {
    h.registry.registerService([{
      serviceName: "admin",
      path: "/secret",
      auth: "admin-token",
      handler: (_req, res) => { res.end("allowed"); },
    }]);
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret`,
    );
    expect(status).toBe(401);
  });

  it("accepts admin-token-auth route with correct token via header", async () => {
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret`,
      { headers: { "X-NatStack-Token": "secret-token" } },
    );
    expect(status).toBe(200);
    expect(body).toBe("allowed");
  });

  it("accepts admin-token-auth route with correct token via query", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret?token=secret-token`,
    );
    expect(status).toBe(200);
  });

  it("rejects admin-token-auth route with wrong token", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret?token=wrong`,
    );
    expect(status).toBe(401);
  });

  it("accepts caller-token routes with panel and worker tokens", async () => {
    h.registry.registerService([{
      serviceName: "caller",
      path: "/token",
      auth: "caller-token",
      handler: (_req, res) => { res.end("caller allowed"); },
    }]);

    const panelToken = h.tokenManager.ensureToken("p1", "panel");
    const workerToken = h.tokenManager.ensureToken("w1", "worker");

    await expect(fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/caller/token`,
      { headers: { "X-NatStack-Token": panelToken } },
    )).resolves.toEqual({ status: 200, body: "caller allowed" });

    await expect(fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/caller/token?token=${workerToken}`,
    )).resolves.toEqual({ status: 200, body: "caller allowed" });
  });

  it("rejects admin and unknown tokens for caller-token routes", async () => {
    h.registry.registerService([{
      serviceName: "caller-reject",
      path: "/token",
      auth: "caller-token",
      handler: (_req, res) => { res.end("caller allowed"); },
    }]);

    const admin = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/caller-reject/token`,
      { headers: { "X-NatStack-Token": "secret-token" } },
    );
    expect(admin.status).toBe(401);

    const unknown = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/caller-reject/token`,
      { headers: { "X-NatStack-Token": "unknown" } },
    );
    expect(unknown.status).toBe(401);
  });
});
