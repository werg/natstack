import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createNodeProcessAdapter, type ProcessAdapter } from "@natstack/process-adapter";
import type { RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-runtime-"));
}

function waitForMessage<T>(subscribe: (resolve: (value: T) => void, reject: (err: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    subscribe(resolve, reject);
  });
}

describe("extension child runtime process", () => {
  let root: string | null = null;
  let proc: ProcessAdapter | null = null;
  let server: WebSocketServer | null = null;

  afterEach(async () => {
    proc?.kill();
    proc = null;
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("starts through the process adapter, reports ready, and handles invoke", async () => {
    root = tempDir();
    const childRuntimePath = path.join(root, "childRuntime.mjs");
    const extensionDir = path.join(root, "extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, "package.json"), '{"type":"module"}');
    const bundlePath = path.join(extensionDir, "bundle.js");
    fs.writeFileSync(
      bundlePath,
      [
        "export async function activate(ctx) {",
        "  ctx.log.info('activated');",
        "  return {",
        "    ping(value) { return `pong:${value}`; },",
        "    callerContext() {",
        "      const invocation = ctx.invocation.current();",
        "      return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId ?? null;",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    await esbuild.build({
      entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: childRuntimePath,
      external: ["@natstack/process-adapter"],
      logLevel: "silent",
    });

    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("WebSocket server did not bind");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;

    const readyPromise = waitForMessage<{ ws: import("ws").WebSocket; message: RpcRequest }>((resolve, reject) => {
      server!.once("connection", (ws) => {
        ws.on("message", (raw) => {
          try {
            const message = JSON.parse(String(raw)) as WsClientMessage;
            if (message.type === "ws:auth") {
              ws.send(JSON.stringify({ type: "ws:auth-result", success: true } satisfies WsServerMessage));
              return;
            }
            if (message.type !== "ws:rpc") return;
            const rpc = message.message as RpcMessage;
            if (rpc.type !== "request") return;
            ws.send(JSON.stringify({
              type: "ws:rpc",
              message: {
                type: "response",
                requestId: rpc.requestId,
                result: null,
              } satisfies RpcResponse,
            } satisfies WsServerMessage));
            if (rpc.method === "extensions.ready") {
              resolve({ ws, message: rpc });
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
    });

    proc = createNodeProcessAdapter(childRuntimePath, {
      ...process.env,
      NATSTACK_EXTENSION_NAME: "@workspace-extensions/process-test",
      NATSTACK_EXTENSION_VERSION: "0.0.0",
      NATSTACK_EXTENSION_BUNDLE_PATH: bundlePath,
      NATSTACK_EXTENSION_STORAGE_DIR: path.join(root, "storage"),
      NATSTACK_EXTENSION_GATEWAY_URL: gatewayUrl,
      NATSTACK_EXTENSION_RPC_TOKEN: "test-token",
    });

    const ready = await readyPromise;
    expect(ready.message.args[0]).toEqual({ methods: ["ping", "callerContext"], hasFetch: false });

    const requestId = randomUUID();
    const response = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.message as RpcMessage;
          if (rpc.type === "response" && rpc.requestId === requestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(JSON.stringify({
        type: "ws:rpc",
        message: {
          type: "request",
          requestId,
          fromId: "main",
          method: "extension.invoke",
          args: [
            "ping",
            ["ok"],
            {
              requestId,
              extensionName: "@workspace-extensions/process-test",
              method: "ping",
              caller: { callerId: "test", callerKind: "shell" },
            },
          ],
        } satisfies RpcRequest,
      } satisfies WsServerMessage));
    });

    expect(response).toEqual({
      type: "response",
      requestId,
      result: "pong:ok",
    });

    const contextRequestId = randomUUID();
    const contextResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.message as RpcMessage;
          if (rpc.type === "response" && rpc.requestId === contextRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(JSON.stringify({
        type: "ws:rpc",
        message: {
          type: "request",
          requestId: contextRequestId,
          fromId: "main",
          method: "extension.invoke",
          args: [
            "callerContext",
            [],
            {
              requestId: contextRequestId,
              extensionName: "@workspace-extensions/process-test",
              method: "callerContext",
              caller: { callerId: "panel-1", callerKind: "panel", contextId: "ctx-panel" },
              chainCaller: {
                callerId: "panel-1",
                callerKind: "panel",
                repoPath: "panels/test",
                effectiveVersion: "ev-test",
                contextId: "ctx-panel",
              },
            },
          ],
        } satisfies RpcRequest,
      } satisfies WsServerMessage));
    });

    expect(contextResponse).toEqual({
      type: "response",
      requestId: contextRequestId,
      result: "ctx-panel",
    });
  });
});
