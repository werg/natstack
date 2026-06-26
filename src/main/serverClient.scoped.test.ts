import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createServerClient } from "./serverClient.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function startRpcHarness() {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const grantRequests: unknown[][] = [];
  const scopedRequests: Array<{ callerId: string; callerKind: string; method: string }> = [];

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/rpc") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let callerId = "";
      let callerKind = "";
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          token?: string;
          envelope?: {
            message?: {
              type?: string;
              requestId?: string;
              method?: string;
              args?: unknown[];
            };
          };
          message?: {
            type?: string;
            requestId?: string;
            method?: string;
            args?: unknown[];
          };
        };
        if (msg.type === "ws:auth") {
          const shell = msg.token === "shell-token";
          const app = msg.token === "app-grant";
          const panel = msg.token === "panel-grant";
          callerId = shell
            ? "electron-main"
            : app
              ? "@workspace-apps/shell"
              : panel
                ? "panel:nav-current"
                : "";
          callerKind = shell ? "shell" : app ? "app" : panel ? "panel" : "";
          const success = shell || app || panel;
          ws.send(
            JSON.stringify({
              type: "ws:auth-result",
              success,
              callerId,
              callerKind,
              connectionId: "conn",
              serverBootId: "boot",
              sessionDirty: false,
            })
          );
          if (app || panel) {
            ws.send(
              JSON.stringify({
                type: "ws:event",
                event: "workspace:changed",
                payload: { callerId },
              })
            );
          }
          return;
        }
        const message = msg.envelope?.message ?? msg.message;
        if (msg.type !== "ws:rpc" || message?.type !== "request") return;
        const { requestId, method, args = [] } = message;
        if (callerKind === "shell" && method === "auth.grantConnection") {
          grantRequests.push(args);
          const principalId = String(args[0] ?? "");
          ws.send(
            JSON.stringify({
              type: "ws:rpc",
              message: {
                type: "response",
                requestId,
                result: {
                  token: principalId.startsWith("panel:") ? "panel-grant" : "app-grant",
                },
              },
            })
          );
          return;
        }
        if ((callerKind === "app" || callerKind === "panel") && method === "workspace.getInfo") {
          scopedRequests.push({ callerId, callerKind, method });
          ws.send(
            JSON.stringify({
              type: "ws:rpc",
              message: { type: "response", requestId, result: { callerId, callerKind } },
            })
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: "ws:rpc",
            message: { type: "response", requestId, error: `unexpected ${callerKind}:${method}` },
          })
        );
      });
    });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  cleanup.push(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, grantRequests, scopedRequests };
}

describe("ServerClient scoped runtime callers", () => {
  it("creates an app-scoped WS client through a shell-issued connection grant", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const events: unknown[] = [];
    client.addMessageListener(
      { callerId: "@workspace-apps/shell", callerKind: "app" },
      (envelope) => {
        const message = envelope.message;
        if (message.type === "event") events.push(message.payload);
      }
    );

    await expect(
      client.callAs(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "workspace",
        "getInfo",
        []
      )
    ).resolves.toEqual({ callerId: "@workspace-apps/shell", callerKind: "app" });

    expect(harness.grantRequests).toEqual([["@workspace-apps/shell"]]);
    expect(harness.scopedRequests).toEqual([
      {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        method: "workspace.getInfo",
      },
    ]);
    await expect.poll(() => events).toEqual([{ callerId: "@workspace-apps/shell" }]);
  });

  it("fails closed for panel scoped callers", async () => {
    // A panel authenticates its own direct connection, which holds the panel
    // lease; a second host-opened connection for the same panel is rejected by
    // the server's lease gate. So scoped panel RPC is refused up front (no grant
    // request) — panel operations are translated by the trusted host instead.
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());

    await expect(
      client.callAs(
        { callerId: "panel:nav-current", callerKind: "panel" },
        "workspace",
        "getInfo",
        []
      )
    ).rejects.toThrow(/not available for panel/);
    expect(harness.grantRequests).toEqual([]);
  });

  it("fails closed for unsupported scoped caller kinds", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());

    await expect(
      client.callAs({ callerId: "worker-1", callerKind: "worker" }, "workspace", "getInfo", [])
    ).rejects.toThrow(/not available for worker/);
    expect(harness.grantRequests).toEqual([]);
  });
});
