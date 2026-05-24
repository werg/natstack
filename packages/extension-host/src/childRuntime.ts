import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHandlerRegistry,
  createRpcBridge,
  type RpcBridge,
  type RpcMessage,
  type RpcTransport,
  type StreamingMethodFrame,
} from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import {
  createExtensionProxy,
  type ExtensionsClient,
  type RegistryEntry,
} from "@natstack/extension";

import type { ExtensionInvocation } from "./types.js";
import {
  isBinaryEnvelope,
  isStreamEnvelope,
  type BinaryEnvelope,
  type BodyEnvelope,
  type StreamChunkEnvelope,
  type StreamEnvelope,
} from "./wireEnvelopes.js";

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
  promptOptions?: "scoped" | "choices";
  options?: Array<{ value: string; label: string; description?: string; tone?: "primary" | "danger" | "neutral" }>;
}

type ExtensionRuntimePhase = "runtime-import" | "activate" | "invoke" | "fetch";

interface FetchResponseBodyStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Uint8Array | null;
  offset: number;
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
const fetchResponseBodies = new Map<string, FetchResponseBodyStream>();
const STREAM_CHUNK_BYTES = 64 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function likelyCauseForExtensionError(error: unknown): string | null {
  const message = errorMessage(error);
  if (message.includes("require is not defined")) {
    return "Code crossed an ESM/CommonJS boundary without an explicit require. Check the stack to identify whether this came from generated extension code, a bundled dependency, or a host/runtime module. For native or WASM CommonJS packages, prefer dependencyMode auto/external and default imports.";
  }
  if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")) {
    return "A runtime dependency was not installed or was externalized without being available in the extension runtime node_modules.";
  }
  if (message.includes("Named export") && message.includes("not found")) {
    return "Generated ESM code used a named import from an external CommonJS package. Use a default import and destructure from it.";
  }
  if (message.includes(".node") || message.includes("invalid ELF") || message.includes("NODE_MODULE_VERSION")) {
    return "A native dependency could not load for this Node/Electron runtime. Reinstall or rebuild the dependency for the active runtime.";
  }
  return null;
}

function extensionRuntimeError(
  phase: ExtensionRuntimePhase,
  error: unknown,
  fields: Record<string, unknown>,
): Error {
  const likelyCause = likelyCauseForExtensionError(error);
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const message = [
    `[ExtensionRuntime:${phase}] ${detail ? `${detail} ` : ""}${errorMessage(error)}`,
    likelyCause ? `Likely cause: ${likelyCause}` : null,
  ].filter(Boolean).join("\n");
  const wrapped = new Error(message);
  if (error instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string") {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  if (error instanceof Error && error.stack) {
    wrapped.stack = `${wrapped.message}\nCaused by: ${error.stack}`;
  }
  return wrapped;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required extension environment variable: ${name}`);
  return value;
}

async function rpcCall<T>(serviceMethod: string, args: unknown[], targetId = "main"): Promise<T> {
  const bridge = getRuntimeBridge();
  return bridge.call<T>(targetId, serviceMethod, args);
}

function serviceProxy(service: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args: unknown[]) => rpcCall(`${service}.${prop}`, args);
    },
  });
}

function createExtensionsClient(): ExtensionsClient {
  const proxyRpc = {
    call: (_target: string, method: string, args: unknown[]) => rpcCall(method, args),
    streamCall: (_target: string, method: string, args: unknown[]) =>
      getRuntimeBridge().streamCall("main", method, args),
  };
  const streamingCache = new Map<string, Promise<Set<string>>>();
  const declaredStreaming = (name: string): Promise<Set<string>> => {
    let cached = streamingCache.get(name);
    if (!cached) {
      cached = rpcCall<string[] | null>("extensions.streamingMethods", [name])
        .then((methods) => new Set(methods ?? []))
        .catch(() => new Set<string>());
      streamingCache.set(name, cached);
    }
    return cached;
  };
  const client: ExtensionsClient = {
    use(name, options) {
      const override = options?.streamingMethods ? new Set(options.streamingMethods) : null;
      return createExtensionProxy(
        proxyRpc,
        name,
        override ? (method) => override.has(method) : (method) => declaredStreaming(name).then((s) => s.has(method)),
      ) as never;
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
    list: () => rpcCall<RegistryEntry[]>("extensions.list", []),
    reload: (name) => rpcCall<void>("extensions.reload", [name]),
  };
  return client;
}

function encodeBinary(data: Uint8Array): BinaryEnvelope {
  return { __bin: true, data: Buffer.from(data).toString("base64") };
}

async function requestBodyFromEnvelope(body: BodyEnvelope | undefined): Promise<BodyInit | undefined> {
  if (!body) return undefined;
  if (isBinaryEnvelope(body)) return Buffer.from(body.data, "base64");
  if (!isStreamEnvelope(body)) return undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await rpcCall<StreamChunkEnvelope>("extensions.fetchRequestBodyChunk", [body.id]);
      if (next.done) {
        controller.close();
        return;
      }
      if (next.chunk) controller.enqueue(Buffer.from(next.chunk.data, "base64"));
    },
    async cancel() {
      await rpcCall("extensions.fetchRequestBodyClose", [body.id]).catch(() => {});
    },
  });
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
  const normalizedRoot = path.resolve(storageRoot);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  const storagePath = (p: string) => {
    const resolved = path.resolve(normalizedRoot, p);
    // Boundary check: resolved must be the root itself or strictly inside it.
    // Using a prefix check on the normalized form is robust to ".." segments,
    // absolute inputs, and accidental sibling-dir prefixes (e.g. /storage-extra).
    if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
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
    git: serviceProxy("git"),
    workspace: serviceProxy("workspace"),
    rpc: {
      call: <T>(targetId: string, method: string, ...args: unknown[]) =>
        rpcCall<T>(method, args, targetId),
      streamCall: (targetId: string, method: string, args: unknown[], options?: { signal?: AbortSignal }) =>
        getRuntimeBridge().streamCall(targetId, method, args, options),
      onEvent: (eventName: string, cb: (fromId: string, payload: unknown) => void) =>
        getRuntimeBridge().onEvent(eventName, cb),
    },
    workers: {
      listServices: () => rpcCall("workers.listServices", []),
      resolveService: (query: string, objectKey?: string | null) =>
        rpcCall("workers.resolveService", [query, objectKey ?? null]),
      resolveDurableObject: (source: string, className: string, objectKey: string) =>
        rpcCall("workers.resolveDurableObject", [source, className, objectKey]),
    },
    credentials: serviceProxy("credentials"),
    webhooks: serviceProxy("webhookIngress"),
    notifications: serviceProxy("notification"),
    extensions: createExtensionsClient(),
    approvals: {
      async request(req: UserlandApprovalRequest) {
        return rpcCall("userlandApproval.request", [req]);
      },
      revoke: (subjectId: string) => rpcCall("userlandApproval.revoke", [subjectId]),
      list: () => rpcCall("userlandApproval.list", []),
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
        const invocationToken = invocationStore.getStore()?.invocationToken;
        const stamped = invocationToken && (message.type === "request" || message.type === "stream-request")
          ? { ...message, parentInvocationToken: invocationToken }
          : message;
        ws.send(JSON.stringify({ type: "ws:rpc", message: stamped } satisfies WsClientMessage));
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

function responseBodyToEnvelope(response: Response): BodyEnvelope {
  if (!response.body) return { __bin: true, data: "" };
  const id = randomUUID();
  fetchResponseBodies.set(id, {
    reader: response.body.getReader(),
    pending: null,
    offset: 0,
  });
  return { __stream: true, id };
}

function streamChunkFromBytes(bytes: Uint8Array): StreamChunkEnvelope {
  return {
    done: false,
    chunk: { __bin: true, data: Buffer.from(bytes).toString("base64") },
  };
}

async function readNextResponseBodyChunk(id: string): Promise<StreamChunkEnvelope> {
  const stream = fetchResponseBodies.get(id);
  if (!stream) {
    const err = new Error(`Unknown extension fetch response body stream: ${id}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (stream.pending && stream.offset < stream.pending.length) {
    const nextOffset = Math.min(stream.offset + STREAM_CHUNK_BYTES, stream.pending.length);
    const chunk = stream.pending.subarray(stream.offset, nextOffset);
    stream.offset = nextOffset;
    if (stream.offset >= stream.pending.length) {
      stream.pending = null;
      stream.offset = 0;
    }
    return streamChunkFromBytes(chunk);
  }
  const next = await stream.reader.read();
  if (next.done) {
    await closeResponseBodyStream(id);
    return { done: true };
  }
  if (next.value.length <= STREAM_CHUNK_BYTES) return streamChunkFromBytes(next.value);
  stream.pending = next.value;
  stream.offset = 0;
  return readNextResponseBodyChunk(id);
}

async function closeResponseBodyStream(id: string): Promise<void> {
  const stream = fetchResponseBodies.get(id);
  if (!stream) return;
  fetchResponseBodies.delete(id);
  try {
    await stream.reader.cancel();
  } catch {
    // The stream may already be closed; cleanup should stay best-effort.
  } finally {
    stream.reader.releaseLock();
  }
}

async function streamResponse(
  response: Response,
  sink: (frame: StreamingMethodFrame) => Promise<void> | void,
  abortSignal: AbortSignal,
): Promise<void> {
  await sink({
    kind: "head",
    status: response.status,
    statusText: response.statusText,
    headerPairs: Array.from(response.headers.entries()),
    finalUrl: response.url,
  });
  let bytesIn = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    abortSignal.addEventListener("abort", cancel, { once: true });
    try {
      while (!abortSignal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        bytesIn += next.value.byteLength;
        await sink({ kind: "chunk", bytes: next.value });
      }
    } finally {
      abortSignal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  await sink({ kind: "end", bytesIn });
}

function settleWaitUntil(waitUntil: Promise<unknown>[]): void {
  if (waitUntil.length === 0) return;
  void Promise.allSettled(waitUntil).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[ExtensionRuntime] fetch waitUntil rejected:", result.reason);
      }
    }
  });
}

async function main(): Promise<void> {
  runtimeBridge = await connectRuntimeBridge();
  const bundlePath = requiredEnv("NATSTACK_EXTENSION_BUNDLE_PATH");
  const extensionName = requiredEnv("NATSTACK_EXTENSION_NAME");
  installCommonJsGlobals(bundlePath);
  let mod: Awaited<ReturnType<typeof importExtensionModule>>;
  try {
    mod = await importExtensionModule(bundlePath);
  } catch (err) {
    throw extensionRuntimeError("runtime-import", err, { extension: extensionName, bundlePath });
  }
  const ctx = createContext();
  let api: unknown;
  try {
    api = typeof mod["activate"] === "function" ? await mod["activate"](ctx) : undefined;
  } catch (err) {
    throw extensionRuntimeError("activate", err, { extension: extensionName, bundlePath });
  }
  const apiObject = api && typeof api === "object" ? api as Record<string, unknown> : {};
  const methods = Object.keys(apiObject).filter((key) => typeof apiObject[key] === "function");
  const defaultExport = mod["default"] as { fetch?: unknown } | undefined;
  const fetchHandler = typeof defaultExport?.fetch === "function"
    ? defaultExport.fetch.bind(defaultExport)
    : null;

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
      try {
        return await fn(...args);
      } catch (err) {
        throw extensionRuntimeError("invoke", err, {
          extension: extensionName,
          method,
          caller: invocation.caller.callerId,
        });
      }
    });
  });

  runtimeBridge.exposeStreamingMethod("extension.invokeStream", async (args, sink, abortSignal) => {
    const [method, methodArgs, invocation] = args as [string, unknown[], ExtensionInvocation];
    await invocationStore.run(invocation, async () => {
      const fn = Object.prototype.hasOwnProperty.call(apiObject, method)
        ? apiObject[method]
        : undefined;
      if (typeof fn !== "function") {
        const err = new Error(`Extension method not found: ${method}`) as NodeJS.ErrnoException;
        err.code = "ENOMETHOD";
        throw err;
      }
      const result = await fn(...methodArgs);
      if (result instanceof Response) {
        await streamResponse(result, sink, abortSignal);
        return;
      }
      if (result instanceof ReadableStream) {
        await streamResponse(new Response(result), sink, abortSignal);
        return;
      }
      throw new Error(`Extension method ${method} did not return a Response or ReadableStream`);
    });
  });

  runtimeBridge.exposeMethod("extension.fetchResponseBodyChunk", async (streamId: string) => {
    return readNextResponseBodyChunk(streamId);
  });

  runtimeBridge.exposeMethod("extension.fetchResponseBodyClose", async (streamId: string) => {
    await closeResponseBodyStream(streamId);
    return null;
  });

  runtimeBridge.exposeMethod(
    "extension.fetch",
    async (
      requestEnvelope: { url: string; method: string; headers: Record<string, string>; body?: BodyEnvelope },
      invocation: ExtensionInvocation,
    ) => {
      if (!fetchHandler) {
        const err = new Error(`Extension has no fetch handler: ${ctx.name}`) as NodeJS.ErrnoException;
        err.code = "ENOFETCH";
        throw err;
      }
      return invocationStore.run(invocation, async () => {
        const body = await requestBodyFromEnvelope(requestEnvelope.body);
        const request = new Request(requestEnvelope.url, {
          method: requestEnvelope.method,
          headers: requestEnvelope.headers,
          ...(body ? { body, duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half" });
        const waitUntil: Promise<unknown>[] = [];
        const fetchCtx = {
          ...ctx,
          waitUntil(promise: Promise<unknown>) {
            waitUntil.push(promise);
          },
        };
        try {
          let response: Response;
          try {
            response = await fetchHandler(request, fetchCtx);
          } catch (err) {
            throw extensionRuntimeError("fetch", err, {
              extension: extensionName,
              method: requestEnvelope.method,
              url: requestEnvelope.url,
            });
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBodyToEnvelope(response),
          };
        } finally {
          settleWaitUntil(waitUntil);
        }
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
      const deactivate = mod["deactivate"];
      void Promise.resolve(typeof deactivate === "function" ? deactivate() : undefined)
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

function importExtensionModule(bundlePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(bundlePath).href) as Promise<Record<string, any>>;
}

function installCommonJsGlobals(bundlePath: string): void {
  const globals = globalThis as typeof globalThis & {
    require?: NodeRequire;
    __filename?: string;
    __dirname?: string;
  };
  globals.require = createRequire(pathToFileURL(bundlePath).href);
  globals.__filename = bundlePath;
  globals.__dirname = path.dirname(bundlePath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
