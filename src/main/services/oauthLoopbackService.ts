import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";

interface LoopbackCallback {
  redirectUri: string;
  wait: Promise<{ code: string; state: string; url: string }>;
}

interface PendingLoopbackCallback extends LoopbackCallback {
  expectedState?: string;
  resolve: (value: { code: string; state: string; url: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LoopbackListener {
  server: http.Server;
  host: string;
  port: number;
  callbackPath: string;
  redirectUri: string;
  pending: Map<string, PendingLoopbackCallback>;
}

const createLoopbackCallbackParamsSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  callbackPath: z.string().optional(),
}).strict();

const expectLoopbackCallbackStateParamsSchema = z.object({
  callbackId: z.string(),
  state: z.string().min(1),
}).strict();

export function createOAuthLoopbackService(): ServiceDefinition {
  const callbacks = new Map<string, LoopbackCallback>();
  const listeners = new Map<string, LoopbackListener>();

  async function createLoopbackCallback(opts: z.infer<typeof createLoopbackCallbackParamsSchema>) {
    const callbackId = randomUUID();
    const listener = await ensureLoopbackListener(listeners, {
      host: opts.host ?? DEFAULT_LOOPBACK_HOST,
      port: opts.port ?? 0,
      callbackPath: normalizeCallbackPath(opts.callbackPath ?? DEFAULT_CALLBACK_PATH),
    });
    let resolve!: PendingLoopbackCallback["resolve"];
    let reject!: PendingLoopbackCallback["reject"];
    const wait = new Promise<{ code: string; state: string; url: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const callback: PendingLoopbackCallback = {
      redirectUri: listener.redirectUri,
      wait,
      resolve,
      reject,
      timer: setTimeout(() => {
        closeCallback(callbacks, listeners, callbackId);
        reject(new Error("OAuth flow timed out after 10 minutes"));
      }, FLOW_TIMEOUT_MS),
    };
    listener.pending.set(callbackId, callback);
    callbacks.set(callbackId, callback);
    callback.wait.finally(() => {
      closeCallback(callbacks, listeners, callbackId);
    }).catch(() => undefined);
    return { callbackId, redirectUri: callback.redirectUri };
  }

  async function waitForLoopbackCallback(callbackId: string) {
    const callback = callbacks.get(callbackId);
    if (!callback) {
      throw new Error("Unknown OAuth loopback callback");
    }
    return callback.wait;
  }

  async function expectLoopbackCallbackState(params: z.infer<typeof expectLoopbackCallbackStateParamsSchema>): Promise<void> {
    const callback = callbacks.get(params.callbackId);
    if (!callback) {
      throw new Error("Unknown OAuth loopback callback");
    }
    (callback as PendingLoopbackCallback).expectedState = params.state;
  }

  async function closeLoopbackCallback(callbackId: string): Promise<void> {
    closeCallback(callbacks, listeners, callbackId);
  }

  return {
    name: "oauthLoopback",
    description: "Local OAuth loopback callback helper",
    policy: { allowed: ["panel", "shell"] },
    methods: {
      createLoopbackCallback: { args: z.tuple([createLoopbackCallbackParamsSchema]) },
      expectLoopbackCallbackState: { args: z.tuple([expectLoopbackCallbackStateParamsSchema]) },
      waitForLoopbackCallback: { args: z.tuple([z.string()]) },
      closeLoopbackCallback: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "createLoopbackCallback":
          return createLoopbackCallback((args as [z.infer<typeof createLoopbackCallbackParamsSchema>])[0]);
        case "expectLoopbackCallbackState":
          return expectLoopbackCallbackState((args as [z.infer<typeof expectLoopbackCallbackStateParamsSchema>])[0]);
        case "waitForLoopbackCallback":
          return waitForLoopbackCallback((args as [string])[0]);
        case "closeLoopbackCallback":
          return closeLoopbackCallback((args as [string])[0]);
        default:
          throw new Error(`Unknown oauthLoopback method: ${method}`);
      }
    },
  };
}

async function ensureLoopbackListener(
  listeners: Map<string, LoopbackListener>,
  binding: {
  host: string;
  port: number;
  callbackPath: string;
  },
): Promise<LoopbackListener> {
  const requestedKey = listenerKey(binding.host, binding.port, binding.callbackPath);
  const existing = listeners.get(requestedKey);
  if (existing) return existing;

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `OAuth loopback port ${binding.host}:${binding.port} is already in use. ` +
          "Stop the other NatStack instance or complete/cancel the existing sign-in first.",
        ));
        return;
      }
      reject(err);
    });
    server.listen(binding.port, binding.host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind loopback OAuth callback server");
  }

  const redirectUri = `http://${binding.host}:${address.port}${binding.callbackPath}`;
  const listener: LoopbackListener = {
    server,
    host: binding.host,
    port: address.port,
    callbackPath: binding.callbackPath,
    redirectUri,
    pending: new Map(),
  };

  const actualKey = listenerKey(binding.host, address.port, binding.callbackPath);
  listeners.set(requestedKey, listener);
  listeners.set(actualKey, listener);

  server.on("request", (req, res) => handleLoopbackRequest(listener, req, res));
  server.on("close", () => {
    listeners.delete(requestedKey);
    listeners.delete(actualKey);
  });

  return listener;
}

function handleLoopbackRequest(
  listener: LoopbackListener,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? "/", listener.redirectUri);
  if (url.pathname !== listener.callbackPath) {
    respondHtml(res, 404, "not found");
    return;
  }

  const state = url.searchParams.get("state");
  const callback = findPendingCallbackForState(listener, state);
  if (!callback) {
    respondHtml(res, 400, errorPage("No matching OAuth sign-in is waiting for this callback."));
    return;
  }

  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (error) {
    const message = errorDescription
      ? `Provider returned an error: ${error} (${errorDescription})`
      : `Provider returned an error: ${error}`;
    respondHtml(res, 400, errorPage(message));
    callback.reject(new Error(message));
    return;
  }

  const code = url.searchParams.get("code");
  if (!code || !state) {
    respondHtml(res, 400, errorPage("Missing authorization code or state."));
    callback.reject(new Error("OAuth callback missing code or state"));
    return;
  }

  respondHtml(res, 200, successPage());
  callback.resolve({ code, state, url: url.toString() });
}

function findPendingCallbackForState(listener: LoopbackListener, state: string | null): PendingLoopbackCallback | undefined {
  if (state) {
    for (const callback of listener.pending.values()) {
      if (callback.expectedState === state) return callback;
    }
  }
  for (const callback of listener.pending.values()) {
    if (!callback.expectedState) return callback;
  }
  return undefined;
}

function closeCallback(
  callbacks: Map<string, LoopbackCallback>,
  listeners: Map<string, LoopbackListener>,
  callbackId: string,
): void {
  const callback = callbacks.get(callbackId);
  callbacks.delete(callbackId);
  if (callback) {
    clearTimeout((callback as PendingLoopbackCallback).timer);
    for (const listener of new Set(listeners.values())) {
      listener.pending.delete(callbackId);
      if (listener.pending.size === 0) {
        listener.server.close();
      }
    }
  }
}

function listenerKey(host: string, port: number, callbackPath: string): string {
  return `${host}:${port}${callbackPath}`;
}

function normalizeCallbackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function respondHtml(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in complete</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d10;color:#e6e8ec}main{max-width:24rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9aa3ad}</style></head><body><main><h1>Sign-in complete</h1><p>You can close this window and return to NatStack.</p></main></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d10;color:#e6e8ec}main{max-width:28rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem;color:#ef6868}p{margin:0;color:#9aa3ad}</style></head><body><main><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
