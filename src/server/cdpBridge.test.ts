import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { TokenManager } from "@natstack/shared/tokenManager";
import { CdpBridge } from "./cdpBridge.js";

type BridgeHarness = {
  bridge: CdpBridge;
  panelToken: string;
  port: number;
  server: http.Server;
  wss: WebSocketServer;
  sockets: WebSocket[];
};

const harnesses: BridgeHarness[] = [];

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitForEndpoint(
  harness: BridgeHarness,
  browserId = "browser-1",
  panelId = "panel-1",
): Promise<NonNullable<ReturnType<CdpBridge["getCdpEndpoint"]>>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const endpoint = harness.bridge.getCdpEndpoint(browserId, panelId);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for CDP endpoint: ${browserId}`);
}

async function createHarness(): Promise<BridgeHarness> {
  const tokenManager = new TokenManager();
  const panelToken = tokenManager.createToken("panel-1", "panel");
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const bridge = new CdpBridge({
    tokenManager,
    adminToken: "admin-token",
    canAccessBrowser: (callerId, browserId) => callerId === "panel-1" && browserId === "browser-1",
    panelOwnsBrowser: (callerId, browserId) => callerId === "panel-1" && browserId === "browser-1",
    port,
  });
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req, socket, head, wss));

  const harness = { bridge, panelToken, port, server, wss, sockets: [] };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: BridgeHarness): Promise<void> {
  for (const ws of harness.sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  harness.wss.close();
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
}

async function connectExtension(harness: BridgeHarness): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/api/cdp-bridge`);
  harness.sockets.push(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: "admin-token" }));
  await expect(waitForJson(ws)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });
  ws.send(JSON.stringify({ type: "cdp:register", browserId: "browser-1", tabId: 123 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return ws;
}

describe("CdpBridge authentication", () => {
  afterEach(async () => {
    const pending = harnesses.splice(0);
    await Promise.all(pending.map(closeHarness));
  });

  it("returns token-free CDP endpoints and authenticates with the first WebSocket message", async () => {
    const harness = await createHarness();
    await connectExtension(harness);

    const endpoint = await waitForEndpoint(harness);
    expect(endpoint).toEqual({
      wsEndpoint: `ws://127.0.0.1:${harness.port}/cdp/browser-1`,
      token: harness.panelToken,
    });
    expect(endpoint?.wsEndpoint).not.toContain("token=");

    const client = new WebSocket(endpoint!.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint!.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });
  });

  it("does not accept legacy query-token authentication", async () => {
    const harness = await createHarness();
    await connectExtension(harness);

    const endpoint = await waitForEndpoint(harness);

    const client = new WebSocket(`${endpoint.wsEndpoint}?token=${endpoint.token}`);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(
      JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1 + 1" } })
    );

    await expect(waitForClose(client)).resolves.toMatchObject({
      code: 4001,
      reason: "Invalid CDP token",
    });
  });
});
