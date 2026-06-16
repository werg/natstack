import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { CdpBridge } from "./cdpBridge.js";
import type { PanelRuntimeLeaseChangedEvent } from "@natstack/shared/panel/panelLease";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";

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

function waitForError(ws: WebSocket): Promise<Error> {
  return new Promise((resolve) => {
    ws.once("error", (error) => resolve(error));
  });
}

function leaseChangedEvent(
  slotId: string,
  previousHost: string | null,
  nextHost: string | null
): PanelRuntimeLeaseChangedEvent {
  const lease = (hostConnectionId: string) => ({
    slotId: asPanelSlotId(slotId),
    runtimeEntityId: asPanelEntityId(`panel:entity-${slotId}`),
    clientSessionId: `${hostConnectionId}-session`,
    hostConnectionId,
    connectionId: `${hostConnectionId}-connection`,
    holderLabel: hostConnectionId,
    platform: "desktop" as const,
    supportsCdp: true,
    loadOnLeaseAssignment: false,
    acquiredAt: Date.now(),
  });
  return {
    type: "panel:runtimeLeaseChanged",
    version: { epoch: "test", counter: 1 },
    slotId: asPanelSlotId(slotId),
    runtimeEntityId: asPanelEntityId(`panel:entity-${slotId}`),
    previous: previousHost ? lease(previousHost) : null,
    next: nextHost ? lease(nextHost) : null,
    reason: "acquired",
  };
}

async function waitForEndpoint(
  harness: BridgeHarness,
  targetId = "browser-1",
  panelId = "panel-1"
): Promise<NonNullable<ReturnType<CdpBridge["getCdpEndpoint"]>>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const endpoint = harness.bridge.getCdpEndpoint(targetId, panelId);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for CDP endpoint: ${targetId}`);
}

async function waitForTargetRegistered(
  harness: BridgeHarness,
  targetId = "browser-1"
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (harness.bridge.isTargetRegistered(targetId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for target registration: ${targetId}`);
}

async function createHarness(
  options: Partial<ConstructorParameters<typeof CdpBridge>[0]> = {}
): Promise<BridgeHarness> {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const bridge = new CdpBridge({
    adminToken: "admin-token",
    externalHost: "127.0.0.1",
    port,
    ...options,
  });
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req, socket, head, wss));

  const harness = { bridge, panelToken: "", port, server, wss, sockets: [] };
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

async function connectHostProvider(
  harness: BridgeHarness,
  hostConnectionId: string,
  targetId = "browser-1",
  tabId = 123
): Promise<WebSocket> {
  const ws = await connectHostProviderOnly(harness, hostConnectionId);
  ws.send(JSON.stringify({ type: "cdp:register", targetId, tabId }));
  await waitForTargetRegistered(harness, targetId);
  return ws;
}

async function connectHostProviderOnly(
  harness: BridgeHarness,
  hostConnectionId: string
): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${harness.port}/api/cdp-host?hostConnectionId=${hostConnectionId}`
  );
  harness.sockets.push(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: "admin-token" }));
  await expect(waitForJson(ws)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });
  return ws;
}

describe("CdpBridge authentication", () => {
  afterEach(async () => {
    const pending = harnesses.splice(0);
    await Promise.all(pending.map(closeHarness));
  });

  it("returns token-free CDP endpoints and authenticates with the first WebSocket message", async () => {
    const harness = await createHarness();
    await connectHostProvider(harness, "desktop-host");

    const endpoint = await waitForEndpoint(harness);
    expect(endpoint).toMatchObject({
      wsEndpoint: `ws://127.0.0.1:${harness.port}/cdp/browser-1`,
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(endpoint?.wsEndpoint).not.toContain("token=");

    const client = new WebSocket(endpoint!.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint!.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });
  });

  it("builds public wss endpoints from the configured gateway host", async () => {
    const harness = await createHarness({
      protocol: "https",
      externalHost: "natstack.example.com",
      port: 443,
    });
    await connectHostProvider(harness, "desktop-host");

    const endpoint = await waitForEndpoint(harness);

    expect(endpoint.wsEndpoint).toBe("wss://natstack.example.com:443/cdp/browser-1");
  });

  it("does not accept legacy query-token authentication", async () => {
    const harness = await createHarness();
    await connectHostProvider(harness, "desktop-host");

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

  it("routes CDP client traffic to the host provider that registered the target", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");
    expect(harness.bridge.isProviderConnected("desktop-host")).toBe(true);

    const endpoint = await waitForEndpoint(harness);
    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });

    client.send(
      JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression: "2+2" } })
    );

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:command",
      targetId: "browser-1",
      method: "Runtime.evaluate",
      params: { expression: "2+2" },
    });
  });

  it("routes browser Page.navigate as a stable in-target CDP command", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const endpoint = await waitForEndpoint(harness);
    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });

    client.send(
      JSON.stringify({
        id: 9,
        method: "Page.navigate",
        params: { url: "https://example.org/" },
      })
    );

    const command = await waitForJson(provider);
    expect(command).toMatchObject({
      type: "cdp:command",
      targetId: "browser-1",
      method: "Page.navigate",
      params: { url: "https://example.org/" },
      requestId: expect.any(String),
    });

    provider.send(
      JSON.stringify({
        type: "cdp:result",
        targetId: "browser-1",
        requestId: command["requestId"],
        result: { frameId: "frame-1" },
      })
    );

    await expect(waitForJson(client)).resolves.toMatchObject({
      id: 9,
      result: { frameId: "frame-1" },
    });
  });

  it("routes host control commands to the provider that registered the target", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendHostCommand("browser-1", "openDevTools", ["right"]);
    const command = await waitForJson(provider);

    expect(command).toMatchObject({
      type: "host:command",
      targetId: "browser-1",
      action: "openDevTools",
      args: ["right"],
      requestId: expect.any(String),
    });

    provider.send(
      JSON.stringify({
        type: "host:result",
        targetId: "browser-1",
        requestId: command["requestId"],
        result: null,
      })
    );

    await expect(commandPromise).resolves.toBeNull();
  });

  it("lets model-aware navigation resolve after the old target unregisters", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendHostCommand("browser-1", "navigatePanel", [
      "https://example.org",
      {},
    ]);
    const command = await waitForJson(provider);

    expect(command).toMatchObject({
      type: "host:command",
      targetId: "browser-1",
      action: "navigatePanel",
      requestId: expect.any(String),
    });

    provider.send(
      JSON.stringify({
        type: "cdp:unregister",
        targetId: "browser-1",
      })
    );
    provider.send(
      JSON.stringify({
        type: "host:result",
        targetId: "browser-1",
        requestId: command["requestId"],
        result: { id: "browser-1", title: "example.org" },
      })
    );

    await expect(commandPromise).resolves.toEqual({ id: "browser-1", title: "example.org" });
  });

  it("rejects model-aware host commands if the provider disconnects after target unregister", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendHostCommand("browser-1", "navigatePanel", [
      "https://example.org",
      {},
    ]);
    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "host:command",
      targetId: "browser-1",
      action: "navigatePanel",
    });

    provider.send(
      JSON.stringify({
        type: "cdp:unregister",
        targetId: "browser-1",
      })
    );
    provider.close();

    await expect(commandPromise).rejects.toThrow("CDP host provider disconnected");
  });

  it("lets model-aware history traversal resolve after the old target unregisters", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendHostCommand(
      "browser-1",
      "navigatePanelHistory",
      [-1]
    );
    const command = await waitForJson(provider);

    expect(command).toMatchObject({
      type: "host:command",
      targetId: "browser-1",
      action: "navigatePanelHistory",
      args: [-1],
      requestId: expect.any(String),
    });

    provider.send(
      JSON.stringify({
        type: "cdp:unregister",
        targetId: "browser-1",
      })
    );
    provider.send(
      JSON.stringify({
        type: "host:result",
        targetId: "browser-1",
        requestId: command["requestId"],
        result: { id: "browser-1", title: "Previous" },
      })
    );

    await expect(commandPromise).resolves.toEqual({ id: "browser-1", title: "Previous" });
  });

  it("rejects pending host control commands when the provider disconnects", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendHostCommand("browser-1", "openDevTools", ["right"]);
    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "host:command",
      targetId: "browser-1",
      action: "openDevTools",
    });

    provider.close();

    await expect(commandPromise).rejects.toThrow("CDP host provider disconnected");
  });

  it("rejects pending navigation commands when the target lease moves to another host", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    const provider = await connectHostProvider(harness, "desktop-host");

    const commandPromise = harness.bridge.sendTargetCommand("browser-1", "panel-1", "reload", []);
    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "nav:command",
      targetId: "browser-1",
      action: "reload",
    });

    holder = "headless-host";
    harness.bridge.handleRuntimeLeaseChanged(
      leaseChangedEvent("browser-1", "desktop-host", "headless-host")
    );

    await expect(commandPromise).rejects.toThrow("CDP target host changed");
  });

  it("detaches the previous host provider when a registered target lease moves", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    const provider = await connectHostProvider(harness, "desktop-host");

    holder = "headless-host";
    harness.bridge.handleRuntimeLeaseChanged(
      leaseChangedEvent("browser-1", "desktop-host", "headless-host")
    );

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:detach",
      targetId: "browser-1",
      reason: "CDP target host changed",
    });
    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(false);
  });

  it("rejects host provider connections whose stable host id is not authorized", async () => {
    const harness = await createHarness({
      canRegisterHostProvider: (hostId) => hostId === "allowed-host",
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${harness.port}/api/cdp-host?hostConnectionId=other-host`
    );
    harness.sockets.push(ws);

    await expect(waitForError(ws)).resolves.toMatchObject({
      message: "Unexpected server response: 403",
    });
  });

  it("closes active client sockets when the target lease moves to another host", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    await connectHostProvider(harness, "desktop-host");

    const endpoint = await waitForEndpoint(harness);
    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });

    holder = "headless-host";
    harness.bridge.handleRuntimeLeaseChanged(
      leaseChangedEvent("browser-1", "desktop-host", "headless-host")
    );

    await expect(waitForClose(client)).resolves.toMatchObject({
      code: 1000,
      reason: "CDP target host changed",
    });
  });

  it("rejects stale endpoint connections when the lease moved before WebSocket auth completes", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    await connectHostProvider(harness, "desktop-host");
    const endpoint = await waitForEndpoint(harness);

    holder = "headless-host";
    harness.bridge.handleRuntimeLeaseChanged(
      leaseChangedEvent("browser-1", "desktop-host", "headless-host")
    );

    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);

    await expect(waitForError(client)).resolves.toMatchObject({
      message: "Unexpected server response: 404",
    });
  });

  it("keeps active client sockets when a lease refresh stays on the same host", async () => {
    const harness = await createHarness({
      resolveHostForTarget: () => "desktop-host",
    });
    const provider = await connectHostProvider(harness, "desktop-host");

    const endpoint = await waitForEndpoint(harness);
    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });

    harness.bridge.handleRuntimeLeaseChanged(
      leaseChangedEvent("browser-1", "desktop-host", "desktop-host")
    );
    client.send(JSON.stringify({ id: 8, method: "Runtime.evaluate" }));

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:command",
      targetId: "browser-1",
      method: "Runtime.evaluate",
    });
  });

  it("does not mint endpoints for registered targets without the lease holder provider", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    await connectHostProvider(harness, "desktop-host");
    holder = "headless-host";

    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(true);
    expect(harness.bridge.getCdpEndpoint("browser-1", "panel-1")).toBeNull();
  });

  it("does not route registered targets after the lease resolver loses the holder", async () => {
    let holder: string | null = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    await connectHostProvider(harness, "desktop-host");
    holder = null;

    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(true);
    expect(harness.bridge.getCdpEndpoint("browser-1", "panel-1")).toBeNull();
    await expect(
      harness.bridge.sendTargetCommand("browser-1", "panel-1", "reload", [])
    ).rejects.toThrow("CDP provider not connected");
  });

  it("does not mint endpoints until the current lease holder registers the target", async () => {
    let holder = "desktop-host";
    const harness = await createHarness({
      resolveHostForTarget: () => holder,
    });
    await connectHostProvider(harness, "desktop-host");
    holder = "headless-host";
    await connectHostProviderOnly(harness, "headless-host");

    expect(harness.bridge.isProviderConnected("headless-host")).toBe(true);
    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(true);
    expect(harness.bridge.isTargetRegisteredForHost("browser-1", "headless-host")).toBe(false);
    expect(harness.bridge.getCdpEndpoint("browser-1", "panel-1")).toBeNull();
  });

  it("rejects target registration from a provider that does not hold the lease", async () => {
    const harness = await createHarness({
      resolveHostForTarget: () => "headless-host",
    });
    const provider = await connectHostProviderOnly(harness, "desktop-host");

    provider.send(JSON.stringify({ type: "cdp:register", targetId: "browser-1", tabId: 123 }));

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:register-rejected",
      targetId: "browser-1",
      tabId: 123,
      reason: "lease_mismatch",
    });
    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(false);
  });

  it("rejects target registration for panels that are no longer known", async () => {
    const harness = await createHarness({
      isPanelKnown: async (targetId) => targetId !== "stale-panel",
    });
    const provider = await connectHostProviderOnly(harness, "desktop-host");

    provider.send(JSON.stringify({ type: "cdp:register", targetId: "stale-panel", tabId: 123 }));

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:register-rejected",
      targetId: "stale-panel",
      tabId: 123,
      reason: "unknown_panel",
    });
    expect(harness.bridge.isTargetRegistered("stale-panel")).toBe(false);
  });

  it("preserves provider message order while panel-known checks are pending", async () => {
    let resolveKnown: (known: boolean) => void = () => {};
    const known = new Promise<boolean>((resolve) => {
      resolveKnown = resolve;
    });
    const harness = await createHarness({
      isPanelKnown: () => known,
    });
    const provider = await connectHostProviderOnly(harness, "desktop-host");

    provider.send(JSON.stringify({ type: "cdp:register", targetId: "panel-1", tabId: 123 }));
    provider.send(JSON.stringify({ type: "cdp:unregister", targetId: "panel-1" }));

    resolveKnown?.(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.bridge.isTargetRegistered("panel-1")).toBe(false);
  });

  it("does not register targets after the provider closes during panel-known checks", async () => {
    let resolveKnown: (known: boolean) => void = () => {};
    const known = new Promise<boolean>((resolve) => {
      resolveKnown = resolve;
    });
    const harness = await createHarness({
      isPanelKnown: () => known,
    });
    const provider = await connectHostProviderOnly(harness, "desktop-host");

    provider.send(JSON.stringify({ type: "cdp:register", targetId: "panel-1", tabId: 123 }));
    provider.close();
    await waitForClose(provider);
    resolveKnown(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.bridge.isTargetRegistered("panel-1")).toBe(false);
  });

  it("rejects target registration when the lease resolver has no CDP-capable holder", async () => {
    const harness = await createHarness({
      resolveHostForTarget: () => null,
    });
    const provider = await connectHostProviderOnly(harness, "desktop-host");

    provider.send(JSON.stringify({ type: "cdp:register", targetId: "browser-1", tabId: 123 }));

    await expect(waitForJson(provider)).resolves.toMatchObject({
      type: "cdp:register-rejected",
      targetId: "browser-1",
      tabId: 123,
      reason: "no_cdp_capable_lease",
    });
    expect(harness.bridge.isTargetRegistered("browser-1")).toBe(false);
  });

  it("ignores unregister messages from providers that did not register the target", async () => {
    const harness = await createHarness();
    await connectHostProvider(harness, "desktop-host");
    const otherProvider = await connectHostProviderOnly(harness, "headless-host");

    otherProvider.send(JSON.stringify({ type: "cdp:unregister", targetId: "browser-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.bridge.isTargetRegisteredForHost("browser-1", "desktop-host")).toBe(true);
    expect(harness.bridge.getCdpEndpoint("browser-1", "panel-1")).not.toBeNull();
  });

  it("ignores CDP command results from providers that do not own the target", async () => {
    const harness = await createHarness();
    const provider = await connectHostProvider(harness, "desktop-host");
    const otherProvider = await connectHostProviderOnly(harness, "headless-host");

    const endpoint = await waitForEndpoint(harness);
    const client = new WebSocket(endpoint.wsEndpoint);
    harness.sockets.push(client);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
    await expect(waitForJson(client)).resolves.toMatchObject({ type: "natstack:cdp-auth-ok" });

    client.send(JSON.stringify({ id: 42, method: "Runtime.evaluate" }));
    const command = await waitForJson(provider);
    expect(command).toMatchObject({ type: "cdp:command", requestId: expect.any(String) });

    otherProvider.send(
      JSON.stringify({
        type: "cdp:result",
        requestId: command["requestId"],
        result: { value: "wrong-host" },
      })
    );
    await expect(
      Promise.race([
        waitForJson(client).then(() => "received"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 30)),
      ])
    ).resolves.toBe("timeout");

    provider.send(
      JSON.stringify({
        type: "cdp:result",
        requestId: command["requestId"],
        result: { value: "owner-host" },
      })
    );
    await expect(waitForJson(client)).resolves.toMatchObject({
      id: 42,
      result: { value: "owner-host" },
    });
  });
});
