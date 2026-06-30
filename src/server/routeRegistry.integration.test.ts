/**
 * Integration test — gateway dispatch via RouteRegistry.
 *
 * Boots the Gateway against a real HTTP socket, registers service routes +
 * a stub worker route (via a fake "workerd" HTTP server bound to an
 * ephemeral port) and asserts the gateway rewrites and proxies correctly.
 */

import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from "vitest";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "http";
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
  workerdDispatchSecrets: Array<string | undefined>;
  ensureDORoute: Mock<(source: string, className: string, objectKey: string) => Promise<void>>;
  events: string[];
}

async function startHarness(): Promise<Harness> {
  const registry = new RouteRegistry();
  const tokenManager = new TokenManager();

  // Fake workerd — records the path it was called with and echoes it back.
  const workerdPaths: string[] = [];
  const workerdDispatchSecrets: Array<string | undefined> = [];
  const events: string[] = [];
  const ensureDORoute = vi.fn<
    (source: string, className: string, objectKey: string) => Promise<void>
  >(async (source, className, objectKey) => {
    events.push(`ensure:${source}:${className}:${objectKey}`);
  });
  const workerdServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    workerdPaths.push(req.url ?? "(unknown)");
    events.push(`proxy:${req.url ?? "(unknown)"}`);
    const dispatchSecret = req.headers["x-natstack-dispatch-secret"];
    workerdDispatchSecrets.push(Array.isArray(dispatchSecret) ? dispatchSecret[0] : dispatchSecret);
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
    getWorkerdDispatchSecret: () => "workerd-dispatch-secret",
    ensureDORoute,
    routeRegistry: registry,
    adminToken: "secret-token",
    tokenManager,
  });
  const gatewayPort = await gateway.start(0);

  return {
    gateway,
    gatewayPort,
    workerdPort,
    registry,
    tokenManager,
    workerdServer,
    workerdPaths,
    workerdDispatchSecrets,
    ensureDORoute,
    events,
  };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.gateway.stop();
  await new Promise<void>((resolve) => h.workerdServer.close(() => resolve()));
}

async function fetchText(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: string }> {
  const resp = await fetch(url, init);
  const body = await resp.text();
  return { status: resp.status, body };
}

describe("RouteRegistry × Gateway integration", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await stopHarness(h);
  });

  it("dispatches a service route in-process", async () => {
    h.registry.registerHttpServiceRoutes([
      {
        serviceName: "ping",
        path: "/ping",
        handler: (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("pong");
        },
      },
    ]);

    const { status, body } = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/ping/ping`);
    expect(status).toBe(200);
    expect(body).toBe("pong");
  });

  it("rewrites userland DO routes to /_u/{packedKey}/{path} (UniversalDO facet host)", async () => {
    const { SingletonRegistry } = await import("@natstack/shared/workspace/singletonRegistry");
    const { encodeUniversalKey } = await import("./doDispatch.js");
    const singletons = new SingletonRegistry([
      { source: "workers/hello-test", className: "HelloDO", key: "singleton" },
    ]);
    h.registry.registerDoRoutes(
      "workers/hello-test",
      "HelloDO",
      [
        {
          source: "workers/hello-test",
          path: "/callback",
          durableObject: { className: "HelloDO" },
        },
      ],
      singletons
    );

    const before = h.workerdPaths.length;
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/hello-test/callback?q=1`
    );
    expect(status).toBe(200);
    expect(h.workerdPaths.length).toBe(before + 1);
    const packed = encodeURIComponent(
      encodeUniversalKey({
        source: "workers/hello-test",
        className: "HelloDO",
        objectKey: "singleton",
      })
    );
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe(`/_u/${packed}/callback?q=1`);
    expect(h.workerdDispatchSecrets[h.workerdDispatchSecrets.length - 1]).toBe(
      "workerd-dispatch-secret"
    );
    expect(body).toContain(`/_u/${packed}/callback`);
  });

  it("ensures a DO-backed route before proxying the first request", async () => {
    const { SingletonRegistry } = await import("@natstack/shared/workspace/singletonRegistry");
    const singletons = new SingletonRegistry([
      { source: "workers/lazy-route", className: "LazyDO", key: "lazy-singleton" },
    ]);
    h.registry.registerDoRoutes(
      "workers/lazy-route",
      "LazyDO",
      [
        {
          source: "workers/lazy-route",
          path: "/first",
          durableObject: { className: "LazyDO" },
        },
      ],
      singletons
    );
    h.ensureDORoute.mockClear();
    h.events.length = 0;

    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/lazy-route/first`
    );

    expect(status).toBe(200);
    expect(h.ensureDORoute).toHaveBeenCalledWith("workers/lazy-route", "LazyDO", "lazy-singleton");
    expect(h.events[0]).toBe("ensure:workers/lazy-route:LazyDO:lazy-singleton");
    expect(h.events[1]).toMatch(/^proxy:\/_u\//);
  });

  it("does not proxy a DO-backed route when lazy ensure fails", async () => {
    const { SingletonRegistry } = await import("@natstack/shared/workspace/singletonRegistry");
    const singletons = new SingletonRegistry([
      { source: "workers/failing-route", className: "FailingDO", key: "failing-singleton" },
    ]);
    h.registry.registerDoRoutes(
      "workers/failing-route",
      "FailingDO",
      [
        {
          source: "workers/failing-route",
          path: "/first",
          durableObject: { className: "FailingDO" },
        },
      ],
      singletons
    );
    h.ensureDORoute.mockRejectedValueOnce(
      Object.assign(new Error("still building"), { code: "RUNTIME_IMAGE_WARMING" })
    );
    const before = h.workerdPaths.length;

    const response = await fetch(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/failing-route/first`
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.text()).toBe("DO route warming");
    expect(h.workerdPaths.length).toBe(before);
  });

  it("rewrites regular-worker routes to /<instance>/<path>", async () => {
    h.registry.registerWorkerRoutes("workers/regular-test", "regular-test", [
      {
        source: "workers/regular-test",
        path: "/hello",
        worker: true,
      },
    ]);

    const before = h.workerdPaths.length;
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/regular-test/hello`
    );
    expect(status).toBe(200);
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe("/regular-test/hello");
    expect(h.workerdDispatchSecrets[h.workerdDispatchSecrets.length - 1]).toBeUndefined();
    expect(h.workerdPaths.length).toBe(before + 1);
  });

  it("rejects direct /_w/ dispatch without the internal dispatch secret", async () => {
    const workerToken = h.tokenManager.ensureToken("w-direct", "worker");
    const before = h.workerdPaths.length;

    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_w/workers/hello-test/HelloDO/singleton/callback`,
      { headers: { Authorization: `Bearer ${workerToken}` } }
    );

    expect(status).toBe(403);
    expect(body).toBe("Forbidden");
    expect(h.workerdPaths.length).toBe(before);
  });

  it("returns 404 for unknown /_r/ paths", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/nonexistent-svc/anything`
    );
    expect(status).toBe(404);
  });

  it("returns 405 when path matches but method does not", async () => {
    h.registry.registerHttpServiceRoutes([
      {
        serviceName: "only-get",
        path: "/x",
        methods: ["GET"],
        handler: (_req, res) => {
          res.end("ok");
        },
      },
    ]);
    const { status } = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/only-get/x`, {
      method: "POST",
    });
    expect(status).toBe(405);
  });

  it("rejects admin-token-auth route without token", async () => {
    h.registry.registerHttpServiceRoutes([
      {
        serviceName: "admin",
        path: "/secret",
        auth: "admin-token",
        handler: (_req, res) => {
          res.end("allowed");
        },
      },
    ]);
    const { status } = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret`);
    expect(status).toBe(401);
  });

  it("accepts admin-token-auth route with correct bearer", async () => {
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret`,
      { headers: { Authorization: "Bearer secret-token" } }
    );
    expect(status).toBe(200);
    expect(body).toBe("allowed");
  });

  it("rejects admin-token-auth route with correct token via query", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret?token=secret-token`
    );
    expect(status).toBe(401);
  });

  it("rejects admin-token-auth route with wrong token", async () => {
    const { status } = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/admin/secret`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(status).toBe(401);
  });

  it("accepts caller-token routes with worker tokens", async () => {
    h.registry.registerHttpServiceRoutes([
      {
        serviceName: "caller",
        path: "/token",
        auth: "caller-token",
        handler: (_req, res) => {
          res.end("caller allowed");
        },
      },
    ]);

    const workerToken = h.tokenManager.ensureToken("w1", "worker");

    await expect(
      fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/caller/token`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      })
    ).resolves.toEqual({ status: 200, body: "caller allowed" });
  });

  it("rejects admin and unknown tokens for caller-token routes", async () => {
    h.registry.registerHttpServiceRoutes([
      {
        serviceName: "caller-reject",
        path: "/token",
        auth: "caller-token",
        handler: (_req, res) => {
          res.end("caller allowed");
        },
      },
    ]);

    const admin = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/caller-reject/token`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(admin.status).toBe(401);

    const unknown = await fetchText(`http://127.0.0.1:${h.gatewayPort}/_r/s/caller-reject/token`, {
      headers: { Authorization: "Bearer unknown" },
    });
    expect(unknown.status).toBe(401);
  });
});
