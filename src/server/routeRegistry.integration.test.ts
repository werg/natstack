/**
 * Integration test — gateway dispatch via RouteRegistry.
 *
 * Boots the Gateway against a real HTTP socket, registers service routes +
 * a stub worker route (via a fake "workerd" HTTP server bound to an
 * ephemeral port) and asserts the gateway rewrites and proxies correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { randomBytes } from "crypto";
import { mintCallerAssertion } from "@natstack/shared/identity/callerAssertion";
import { Gateway } from "./gateway.js";
import { RouteRegistry } from "./routeRegistry.js";

interface Harness {
  gateway: Gateway;
  gatewayPort: number;
  assertedGatewayPort: number;
  workerdPort: number;
  registry: RouteRegistry;
  assertionSecret: Buffer;
  workerdServer: HttpServer;
  assertedGatewayServer: HttpServer;
  /** Record of paths workerd received (for rewrite-assertion). */
  workerdPaths: string[];
}

async function startHarness(): Promise<Harness> {
  const registry = new RouteRegistry();
  const assertionSecret = randomBytes(32);

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
    assertionSecret,
  });
  const gatewayPort = await gateway.start(0);
  const assertedGatewayServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const callerId =
      typeof req.headers["x-test-caller-id"] === "string" ? req.headers["x-test-caller-id"] : "p1";
    const callerKind =
      req.headers["x-test-caller-kind"] === "worker" ||
      req.headers["x-test-caller-kind"] === "shell" ||
      req.headers["x-test-caller-kind"] === "server"
        ? req.headers["x-test-caller-kind"]
        : "panel";
    req.natstackCaller = { callerId, callerKind };
    gateway.handleHttpRequest(req, res);
  });
  const assertedGatewayPort: number = await new Promise((resolve) => {
    assertedGatewayServer.listen(0, "127.0.0.1", () => {
      const addr = assertedGatewayServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    gateway,
    gatewayPort,
    assertedGatewayPort,
    workerdPort,
    registry,
    assertionSecret,
    workerdServer,
    assertedGatewayServer,
    workerdPaths,
  };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.gateway.stop();
  await new Promise<void>((resolve) => h.assertedGatewayServer.close(() => resolve()));
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
    h.registry.registerService([
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

  it("rewrites DO routes to /_w/{source}/{class}/{key}/{path}", async () => {
    h.registry.registerDoRoutes("workers/hello-test", "HelloDO", [
      {
        path: "/callback",
        durableObject: { className: "HelloDO", objectKey: "singleton" },
      },
    ]);

    const before = h.workerdPaths.length;
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/hello-test/callback?q=1`
    );
    expect(status).toBe(200);
    expect(h.workerdPaths.length).toBe(before + 1);
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe("/_w/workers/hello-test/HelloDO/singleton/callback?q=1");
    expect(body).toContain("/_w/workers/hello-test/HelloDO/singleton/callback");
  });

  it("rewrites regular-worker routes to /_w/{instance}/{path}", async () => {
    h.registry.registerWorkerRoutes("workers/regular-test", "regular-test", [
      {
        path: "/hello",
      },
    ]);

    const before = h.workerdPaths.length;
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/w/workers/regular-test/hello`
    );
    expect(status).toBe(200);
    const seen = h.workerdPaths[h.workerdPaths.length - 1]!;
    expect(seen).toBe("/_w/regular-test/hello");
    expect(h.workerdPaths.length).toBe(before + 1);
  });

  it("returns 404 for unknown /_r/ paths", async () => {
    const { status } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/nonexistent-svc/anything`
    );
    expect(status).toBe(404);
  });

  it("returns 405 when path matches but method does not", async () => {
    h.registry.registerService([
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
    h.registry.registerService([
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

  it("accepts caller-token routes with verified panel and worker callers", async () => {
    h.registry.registerService([
      {
        serviceName: "caller",
        path: "/token",
        auth: "caller-token",
        handler: (_req, res) => {
          res.end("caller allowed");
        },
      },
    ]);

    await expect(
      fetchText(`http://127.0.0.1:${h.assertedGatewayPort}/_r/s/caller/token`, {
        headers: { "x-test-caller-id": "p1", "x-test-caller-kind": "panel" },
      })
    ).resolves.toEqual({ status: 200, body: "caller allowed" });

    await expect(
      fetchText(`http://127.0.0.1:${h.assertedGatewayPort}/_r/s/caller/token`, {
        headers: { "x-test-caller-id": "w1", "x-test-caller-kind": "worker" },
      })
    ).resolves.toEqual({ status: 200, body: "caller allowed" });
  });

  it("rejects bearer tokens for caller-token routes without verified caller identity", async () => {
    h.registry.registerService([
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

  it("accepts caller assertions on direct local gateway connections", async () => {
    h.registry.registerService([
      {
        serviceName: "caller-assertion",
        path: "/token",
        auth: "caller-token",
        handler: (req, res) => {
          res.end(req.natstackCaller?.callerId ?? "missing");
        },
      },
    ]);

    const assertion = mintCallerAssertion(h.assertionSecret, {
      callerId: "electron-main",
      callerKind: "shell",
      audience: "egress-proxy",
    });
    const basic = Buffer.from(`natstack:${assertion}`, "utf8").toString("base64");
    const { status, body } = await fetchText(
      `http://127.0.0.1:${h.gatewayPort}/_r/s/caller-assertion/token`,
      { headers: { "Proxy-Authorization": `Basic ${basic}` } }
    );

    expect(status).toBe(200);
    expect(body).toBe("electron-main");
  });
});
