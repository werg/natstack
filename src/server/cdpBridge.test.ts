import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { CdpBridge } from "./cdpBridge.js";

type BridgeHarness = {
  bridge: CdpBridge;
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

async function createHarness(): Promise<BridgeHarness> {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const bridge = new CdpBridge({
    adminToken: "admin-token",
    canAccessBrowser: (callerId, browserId) => callerId === "panel-1" && browserId === "browser-1",
    panelOwnsBrowser: (callerId, browserId) => callerId === "panel-1" && browserId === "browser-1",
    port,
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/cdp/")) {
      req.natstackCaller = { callerId: "panel-1", callerKind: "panel" };
    }
    bridge.handleUpgrade(req, socket, head, wss);
  });

  const harness = { bridge, port, server, wss, sockets: [] };
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
  const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/api/cdp-bridge`, {
    headers: { Authorization: "Bearer admin-token" },
  });
  harness.sockets.push(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: "cdp:register", browserId: "browser-1", tabId: 123 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return ws;
}

describe("CdpBridge authentication", () => {
  afterEach(async () => {
    const pending = harnesses.splice(0);
    await Promise.all(pending.map(closeHarness));
  });

  it("returns token-free CDP endpoints and accepts verified caller upgrades", async () => {
    const harness = await createHarness();
    await connectExtension(harness);

    const endpoint = harness.bridge.getCdpEndpoint("browser-1", "panel-1");
    expect(endpoint).toEqual({
      wsEndpoint: `ws://127.0.0.1:${harness.port}/cdp/browser-1`,
    });
    expect(new URL(endpoint!.wsEndpoint).searchParams.has("token")).toBe(false);

    const client = new WebSocket(endpoint!.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
  });

  it("rejects CDP upgrades without verified caller identity", async () => {
    const harness = await createHarness();
    await connectExtension(harness);

    const endpoint = harness.bridge.getCdpEndpoint("browser-1", "panel-1");
    expect(endpoint).not.toBeNull();

    harness.server.removeAllListeners("upgrade");
    harness.server.on("upgrade", (req, socket, head) => {
      harness.bridge.handleUpgrade(req, socket, head, harness.wss);
    });

    const client = new WebSocket(`${endpoint!.wsEndpoint}?unused=1`);
    harness.sockets.push(client);
    await expect(waitForOpen(client)).rejects.toThrow();
  });
});
