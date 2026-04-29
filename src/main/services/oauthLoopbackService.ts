import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";

interface LoopbackCallback {
  server: http.Server;
  redirectUri: string;
  wait: Promise<{ code: string; state: string; url: string }>;
}

const createLoopbackCallbackParamsSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  callbackPath: z.string().optional(),
}).strict();

export function createOAuthLoopbackService(): ServiceDefinition {
  const callbacks = new Map<string, LoopbackCallback>();

  async function createLoopbackCallback(opts: z.infer<typeof createLoopbackCallbackParamsSchema>) {
    const callbackId = randomUUID();
    const callback = await bindLoopbackCallback({
      host: opts.host ?? DEFAULT_LOOPBACK_HOST,
      port: opts.port ?? 0,
      callbackPath: normalizeCallbackPath(opts.callbackPath ?? DEFAULT_CALLBACK_PATH),
    });
    callbacks.set(callbackId, callback);
    callback.wait.finally(() => {
      closeCallback(callbacks, callbackId);
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

  async function closeLoopbackCallback(callbackId: string): Promise<void> {
    closeCallback(callbacks, callbackId);
  }

  return {
    name: "oauthLoopback",
    description: "Local OAuth loopback callback helper",
    policy: { allowed: ["panel", "shell"] },
    methods: {
      createLoopbackCallback: { args: z.tuple([createLoopbackCallbackParamsSchema]) },
      waitForLoopbackCallback: { args: z.tuple([z.string()]) },
      closeLoopbackCallback: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "createLoopbackCallback":
          return createLoopbackCallback((args as [z.infer<typeof createLoopbackCallbackParamsSchema>])[0]);
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

async function bindLoopbackCallback(binding: {
  host: string;
  port: number;
  callbackPath: string;
}): Promise<LoopbackCallback> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(binding.port, binding.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind loopback OAuth callback server");
  }

  const redirectUri = `http://${binding.host}:${address.port}${binding.callbackPath}`;
  const wait = new Promise<{ code: string; state: string; url: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth flow timed out after 10 minutes"));
    }, FLOW_TIMEOUT_MS);

    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== binding.callbackPath) {
        respondHtml(res, 404, "not found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        const message = errorDescription
          ? `Provider returned an error: ${error} (${errorDescription})`
          : `Provider returned an error: ${error}`;
        respondHtml(res, 400, errorPage(message));
        cleanup();
        reject(new Error(message));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        respondHtml(res, 400, errorPage("Missing authorization code or state."));
        cleanup();
        reject(new Error("OAuth callback missing code or state"));
        return;
      }

      respondHtml(res, 200, successPage());
      cleanup();
      resolve({ code, state, url: url.toString() });
    };

    function cleanup() {
      clearTimeout(timer);
      server.off("request", onRequest);
    }

    server.on("request", onRequest);
  });

  return { server, redirectUri, wait };
}

function closeCallback(callbacks: Map<string, LoopbackCallback>, callbackId: string): void {
  const callback = callbacks.get(callbackId);
  callbacks.delete(callbackId);
  if (callback) {
    callback.server.close();
  }
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
