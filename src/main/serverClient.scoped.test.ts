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
  const appRequests: string[] = [];

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
          callerId = shell ? "electron-main" : app ? "@workspace-apps/shell" : "";
          callerKind = shell ? "shell" : app ? "app" : "";
          ws.send(
            JSON.stringify({
              type: "ws:auth-result",
              success: shell || app,
              callerId,
              callerKind,
              connectionId: "conn",
              serverBootId: "boot",
              sessionDirty: false,
            })
          );
          if (app) {
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
        if (msg.type !== "ws:rpc" || msg.message?.type !== "request") return;
        const { requestId, method, args = [] } = msg.message;
        if (callerKind === "shell" && method === "auth.grantConnection") {
          grantRequests.push(args);
          ws.send(
            JSON.stringify({
              type: "ws:rpc",
              message: { type: "response", requestId, result: { token: "app-grant" } },
            })
          );
          return;
        }
        if (callerKind === "app" && method === "workspace.getInfo") {
          appRequests.push(method);
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
  return { port, grantRequests, appRequests };
}

describe("ServerClient scoped runtime callers", () => {
  it("creates an app-scoped WS client through a shell-issued connection grant", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const events: unknown[] = [];
    client.addMessageListener(
      { callerId: "@workspace-apps/shell", callerKind: "app" },
      (_fromId, message) => {
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
    expect(harness.appRequests).toEqual(["workspace.getInfo"]);
    await expect.poll(() => events).toEqual([{ callerId: "@workspace-apps/shell" }]);
  });

  it("fails closed for unsupported scoped caller kinds", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());

    await expect(
      client.callAs({ callerId: "panel-1", callerKind: "panel" }, "workspace", "getInfo", [])
    ).rejects.toThrow(/not available for panel/);
    expect(harness.grantRequests).toEqual([]);
  });
});
