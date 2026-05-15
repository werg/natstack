import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHandlerRegistry,
  createRpcBridge,
  type RpcBridge,
  type RpcMessage,
  type RpcTransport,
} from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";

import type { ExtensionInvocation } from "./types.js";

type ChildMessage =
  | { type: "shutdown" };

interface HealthDetail {
  summary: string;
  reasons?: string[];
  retryAt?: number;
}

interface UserlandApprovalRequest {
  subject: { id: string; label?: string };
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{ label: string; value: string }>;
  options: Array<{ value: string; label: string; description?: string; tone?: "primary" | "danger" | "neutral" }>;
}

interface BinaryEnvelope {
  __bin: true;
  data: string;
}

interface SerializedFileStats {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: string;
  ctime: string;
  mode: number;
}

const invocationStore = new AsyncLocalStorage<ExtensionInvocation>();
const extensionEventCallbacks = new Map<string, Set<(payload: unknown) => void>>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required extension environment variable: ${name}`);
  return value;
}

async function rpcCall<T>(serviceMethod: string, args: unknown[]): Promise<T> {
  const bridge = getRuntimeBridge();
  return bridge.call<T>("main", serviceMethod, ...args);
}

function serviceProxy(service: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args: unknown[]) => rpcCall(`${service}.${prop}`, args);
    },
  });
}

function createExtensionsClient() {
  return {
    use<T extends object>(extensionName: string): T {
      return new Proxy(Object.create(null), {
        get(_target, prop) {
          if (
            typeof prop !== "string"
            || prop === "then"
            || prop === "toJSON"
            || prop === "inspect"
          ) {
            return undefined;
          }
          return (...args: unknown[]) =>
            rpcCall("extensions.invoke", [extensionName, prop, args]);
        },
      }) as T;
    },
    on(targetName: string, event: string, cb: (payload: unknown) => void) {
      const eventName = `extensions:${targetName}::${event}`;
      const channel = `event:${eventName}`;
      let callbacks = extensionEventCallbacks.get(channel);
      if (!callbacks) {
        callbacks = new Set();
        extensionEventCallbacks.set(channel, callbacks);
        void rpcCall("events.subscribe", [eventName]).catch((err) => {
          console.error(`[ExtensionRuntime] Failed to subscribe to ${eventName}:`, err);
        });
      }
      callbacks.add(cb);
      return {
        dispose() {
          const current = extensionEventCallbacks.get(channel);
          current?.delete(cb);
          if (current && current.size === 0) {
            extensionEventCallbacks.delete(channel);
            void rpcCall("events.unsubscribe", [eventName]).catch((err) => {
              console.error(`[ExtensionRuntime] Failed to unsubscribe from ${eventName}:`, err);
            });
          }
        },
      };
    },
    list: () => rpcCall("extensions.list", []),
    install: (spec: unknown) => rpcCall("extensions.install", [spec]),
    uninstall: (name: string, opts?: { purge?: boolean }) => rpcCall("extensions.uninstall", [name, opts]),
    setEnabled: (name: string, enabled: boolean) => rpcCall("extensions.setEnabled", [name, enabled]),
    update: (name: string) => rpcCall("extensions.update", [name]),
    reload: (name: string) => rpcCall("extensions.reload", [name]),
  };
}

function requestHostApproval(invocation: ExtensionInvocation, req: UserlandApprovalRequest): Promise<unknown> {
  return rpcCall("extensions.approvalForCaller", [invocation, req]);
}

function encodeBinary(data: Uint8Array): BinaryEnvelope {
  return { __bin: true, data: Buffer.from(data).toString("base64") };
}

function isBinaryEnvelope(value: unknown): value is BinaryEnvelope {
  return typeof value === "object"
    && value !== null
    && (value as { __bin?: unknown }).__bin === true
    && typeof (value as { data?: unknown }).data === "string";
}

function toStats(value: SerializedFileStats) {
  return {
    ...value,
    mtime: new Date(value.mtime),
    ctime: new Date(value.ctime),
    isFile: () => value.isFile,
    isDirectory: () => value.isDirectory,
    isSymbolicLink: () => value.isSymbolicLink,
  };
}

function createFsClient() {
  return {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    async readFile(filePath: string, encoding?: BufferEncoding) {
      const result = await rpcCall<unknown>("fs.readFile", [filePath, encoding]);
      return isBinaryEnvelope(result) ? Buffer.from(result.data, "base64") : result;
    },
    async writeFile(filePath: string, data: string | Uint8Array) {
      await rpcCall("fs.writeFile", [
        filePath,
        typeof data === "string" ? data : encodeBinary(data),
      ]);
    },
    async appendFile(filePath: string, data: string | Uint8Array) {
      await rpcCall("fs.appendFile", [
        filePath,
        typeof data === "string" ? data : encodeBinary(data),
      ]);
    },
    async readdir(filePath: string, options?: unknown) {
      return rpcCall("fs.readdir", [filePath, options]);
    },
    async mkdir(filePath: string, options?: unknown) {
      return rpcCall("fs.mkdir", [filePath, options]);
    },
    async rmdir(filePath: string) {
      return rpcCall("fs.rmdir", [filePath]);
    },
    async rm(filePath: string, options?: unknown) {
      return rpcCall("fs.rm", [filePath, options]);
    },
    async stat(filePath: string) {
      return toStats(await rpcCall<SerializedFileStats>("fs.stat", [filePath]));
    },
    async lstat(filePath: string) {
      return toStats(await rpcCall<SerializedFileStats>("fs.lstat", [filePath]));
    },
    async access(filePath: string, mode?: number) {
      await rpcCall("fs.access", [filePath, mode]);
    },
    async exists(filePath: string) {
      return rpcCall("fs.exists", [filePath]);
    },
    async unlink(filePath: string) {
      await rpcCall("fs.unlink", [filePath]);
    },
    async copyFile(src: string, dest: string) {
      await rpcCall("fs.copyFile", [src, dest]);
    },
    async rename(oldPath: string, newPath: string) {
      await rpcCall("fs.rename", [oldPath, newPath]);
    },
    async realpath(filePath: string) {
      return rpcCall("fs.realpath", [filePath]);
    },
    async open(filePath: string, flags?: string, mode?: number) {
      const { handleId } = await rpcCall<{ handleId: number }>("fs.open", [filePath, flags, mode]);
      return {
        fd: handleId,
        async read(buffer: Uint8Array, offset: number, length: number, position: number | null) {
          const result = await rpcCall<{ bytesRead: number; buffer: BinaryEnvelope }>(
            "fs.handleRead",
            [handleId, length, position],
          );
          buffer.set(Buffer.from(result.buffer.data, "base64"), offset);
          return { bytesRead: result.bytesRead, buffer };
        },
        async write(buffer: Uint8Array, offset = 0, length = buffer.length, position: number | null = null) {
          const slice = buffer.subarray(offset, offset + length);
          const result = await rpcCall<{ bytesWritten: number }>(
            "fs.handleWrite",
            [handleId, encodeBinary(slice), position],
          );
          return { bytesWritten: result.bytesWritten, buffer };
        },
        async close() {
          await rpcCall("fs.handleClose", [handleId]);
        },
        async stat() {
          return toStats(await rpcCall<SerializedFileStats>("fs.handleStat", [handleId]));
        },
      };
    },
    async truncate(filePath: string, len?: number) {
      await rpcCall("fs.truncate", [filePath, len]);
    },
    async readlink(filePath: string) {
      return rpcCall("fs.readlink", [filePath]);
    },
    async symlink(target: string, filePath: string) {
      await rpcCall("fs.symlink", [target, filePath]);
    },
    async chmod(filePath: string, mode: number) {
      await rpcCall("fs.chmod", [filePath, mode]);
    },
    async chown(filePath: string, uid: number, gid: number) {
      await rpcCall("fs.chown", [filePath, uid, gid]);
    },
    async utimes(filePath: string, atime: number | Date, mtime: number | Date) {
      await rpcCall("fs.utimes", [filePath, atime, mtime]);
    },
  };
}

function createContext() {
  const name = requiredEnv("NATSTACK_EXTENSION_NAME");
  const version = requiredEnv("NATSTACK_EXTENSION_VERSION");
  const storageRoot = requiredEnv("NATSTACK_EXTENSION_STORAGE_DIR");
  const storagePath = (p: string) => {
    const resolved = path.resolve(storageRoot, p);
    const relative = path.relative(storageRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      const err = new Error(`Storage path escapes extension storage: ${p}`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return resolved;
  };

  const ctx = {
    name,
    version,
    storage: {
      mkdir: (p: string, opts?: { recursive?: boolean }) => nodeFs.mkdir(storagePath(p), { recursive: opts?.recursive ?? true }),
      readFile: (p: string, encoding?: BufferEncoding) => nodeFs.readFile(storagePath(p), encoding),
      writeFile: (p: string, data: string | Uint8Array) => nodeFs.writeFile(storagePath(p), data),
      rm: (p: string, opts?: { recursive?: boolean; force?: boolean }) => nodeFs.rm(storagePath(p), opts),
      readdir: (p = ".") => nodeFs.readdir(storagePath(p)),
    },
    fs: createFsClient(),
    ai: serviceProxy("ai"),
    git: serviceProxy("git"),
    panel: serviceProxy("panel"),
    workspace: serviceProxy("workspace"),
    credentials: serviceProxy("credentials"),
    db: serviceProxy("db"),
    webhooks: serviceProxy("webhookIngress"),
    notifications: serviceProxy("notification"),
    extensions: createExtensionsClient(),
    approvals: {
      async requestForCaller(req: UserlandApprovalRequest) {
        const invocation = invocationStore.getStore();
        if (!invocation?.userlandCaller) {
          const err = new Error("No panel/worker caller is active for this extension invocation") as NodeJS.ErrnoException;
          err.code = "ENOCALLER";
          throw err;
        }
        return requestHostApproval(invocation, req);
      },
    },
    invocation: {
      current: () => invocationStore.getStore() ?? null,
    },
    subscriptions: [] as Array<{ dispose(): void }>,
    log: {
      debug: (message: string, fields?: Record<string, unknown>) => {
        void rpcCall("extensions.log", ["debug", message, fields]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write debug log:", err);
        });
      },
      info: (message: string, fields?: Record<string, unknown>) => {
        void rpcCall("extensions.log", ["info", message, fields]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write info log:", err);
        });
      },
      warn: (message: string, fields?: Record<string, unknown>) => {
        void rpcCall("extensions.log", ["warn", message, fields]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write warn log:", err);
        });
      },
      error: (message: string, fields?: Record<string, unknown>) => {
        void rpcCall("extensions.log", ["error", message, fields]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to write error log:", err);
        });
      },
    },
    health: {
      report: (state: "healthy" | "degraded" | "unhealthy", detail?: HealthDetail) => {
        void rpcCall("extensions.health", [state, detail]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to report health:", err);
        });
      },
      healthy: (detail?: HealthDetail) => {
        void rpcCall("extensions.health", ["healthy", detail]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to report health:", err);
        });
      },
      degraded: (detail: HealthDetail) => {
        void rpcCall("extensions.health", ["degraded", detail]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to report health:", err);
        });
      },
      unhealthy: (detail: HealthDetail) => {
        void rpcCall("extensions.health", ["unhealthy", detail]).catch((err) => {
          console.error("[ExtensionRuntime] Failed to report health:", err);
        });
      },
    },
    emit: (event: string, payload: unknown) => {
      void rpcCall("extensions.emit", [event, payload]).catch((err) => {
        console.error(`[ExtensionRuntime] Failed to emit ${event}:`, err);
      });
    },
  };
  return ctx;
}

let runtimeBridge: RpcBridge | null = null;

function getRuntimeBridge(): RpcBridge {
  if (!runtimeBridge) throw new Error("Extension WebSocket RPC is not connected");
  return runtimeBridge;
}

function gatewayWebSocketUrl(): string {
  const gatewayUrl = new URL(requiredEnv("NATSTACK_EXTENSION_GATEWAY_URL"));
  gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  gatewayUrl.pathname = gatewayUrl.pathname.endsWith("/rpc") ? gatewayUrl.pathname : "/rpc";
  gatewayUrl.search = "";
  gatewayUrl.hash = "";
  return gatewayUrl.toString();
}

async function connectRuntimeBridge(): Promise<RpcBridge> {
  const token = requiredEnv("NATSTACK_EXTENSION_RPC_TOKEN");
  const extensionName = requiredEnv("NATSTACK_EXTENSION_NAME");
  const ws = new WebSocket(gatewayWebSocketUrl());
  const registry = createHandlerRegistry({ context: `extension:${extensionName}` });

  const bridge = createRpcBridge({
    selfId: extensionName,
    transport: {
      async send(_targetId: string, message: RpcMessage): Promise<void> {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("Extension WebSocket RPC is not connected");
        }
        ws.send(JSON.stringify({ type: "ws:rpc", message } satisfies WsClientMessage));
      },
      onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
        return registry.onMessage(sourceId, handler);
      },
      onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
        return registry.onAnyMessage(handler);
      },
    } satisfies RpcTransport,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension WebSocket auth timeout")), 10_000);
    const fail = (err: unknown) => {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    ws.addEventListener("error", fail, { once: true });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "ws:auth",
        token,
        connectionId: `extension:${extensionName}`,
      } satisfies WsClientMessage));
    }, { once: true });
    ws.addEventListener("message", function onAuth(event) {
      const message = JSON.parse(String(event.data)) as WsServerMessage;
      if (message.type !== "ws:auth-result") return;
      ws.removeEventListener("message", onAuth);
      clearTimeout(timeout);
      if (!message.success) {
        reject(new Error(`Extension WebSocket auth failed: ${message.error ?? "unknown error"}`));
        return;
      }
      resolve();
    });
  });

  ws.addEventListener("message", (event) => {
    let message: WsServerMessage;
    try {
      message = JSON.parse(String(event.data)) as WsServerMessage;
    } catch {
      return;
    }
    if (message.type === "ws:rpc") {
      registry.deliver("main", message.message);
    } else if (message.type === "ws:event") {
      const callbacks = extensionEventCallbacks.get(message.event);
      if (!callbacks) return;
      for (const cb of callbacks) {
        try {
          cb(message.payload);
        } catch (err) {
          console.error(`[ExtensionRuntime] Event handler failed for ${message.event}:`, err);
        }
      }
    }
  });

  ws.addEventListener("close", () => {
    console.error("[ExtensionRuntime] WebSocket RPC disconnected");
    process.exit(1);
  });

  return bridge;
}

async function main(): Promise<void> {
  runtimeBridge = await connectRuntimeBridge();
  const bundlePath = requiredEnv("NATSTACK_EXTENSION_BUNDLE_PATH");
  const mod = await import(pathToFileURL(bundlePath).href);
  const ctx = createContext();
  const api = typeof mod.activate === "function" ? await mod.activate(ctx) : undefined;
  const apiObject = api && typeof api === "object" ? api as Record<string, unknown> : {};
  const methods = Object.keys(apiObject).filter((key) => typeof apiObject[key] === "function");
  const fetchHandler = typeof mod.default?.fetch === "function" ? mod.default.fetch.bind(mod.default) : null;

  runtimeBridge.exposeMethod("extension.invoke", async (method: string, args: unknown[], invocation: ExtensionInvocation) => {
    return invocationStore.run(invocation, async () => {
      const fn = Object.prototype.hasOwnProperty.call(apiObject, method)
        ? apiObject[method]
        : undefined;
      if (typeof fn !== "function") {
        const err = new Error(`Extension method not found: ${method}`) as NodeJS.ErrnoException;
        err.code = "ENOMETHOD";
        throw err;
      }
      return fn(...args);
    });
  });

  runtimeBridge.exposeMethod(
    "extension.fetch",
    async (
      requestEnvelope: { url: string; method: string; headers: Record<string, string>; body?: BinaryEnvelope },
      invocation: ExtensionInvocation,
    ) => {
      if (!fetchHandler) {
        const err = new Error(`Extension has no fetch handler: ${ctx.name}`) as NodeJS.ErrnoException;
        err.code = "ENOFETCH";
        throw err;
      }
      return invocationStore.run(invocation, async () => {
        const request = new Request(requestEnvelope.url, {
          method: requestEnvelope.method,
          headers: requestEnvelope.headers,
          body: requestEnvelope.body
            ? Buffer.from(requestEnvelope.body.data, "base64")
            : undefined,
        });
        const waitUntil: Promise<unknown>[] = [];
        const fetchCtx = {
          ...ctx,
          waitUntil(promise: Promise<unknown>) {
            waitUntil.push(promise);
          },
        };
        const response = await fetchHandler(request, fetchCtx);
        await Promise.allSettled(waitUntil);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: {
            __bin: true,
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          } satisfies BinaryEnvelope,
        };
      });
    },
  );

  const disposeSubscriptions = () => {
    while (ctx.subscriptions.length) {
      const subscription = ctx.subscriptions.pop()!;
      try {
        subscription.dispose();
      } catch (err) {
        console.error("[ExtensionRuntime] Subscription dispose failed:", err);
      }
    }
  };

  process.on("message", (message: ChildMessage) => {
    if (message.type === "shutdown") {
      void Promise.resolve(mod.deactivate?.())
        .catch((err) => console.error("[ExtensionRuntime] deactivate threw:", err))
        .finally(() => {
          disposeSubscriptions();
          process.exit(0);
        });
    }
  });

  await rpcCall("extensions.health", ["healthy", { summary: "Activated" }]).catch((err) => {
    console.error("[ExtensionRuntime] Failed to report initial health:", err);
  });
  await rpcCall("extensions.ready", [{ methods, hasFetch: !!fetchHandler }]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
