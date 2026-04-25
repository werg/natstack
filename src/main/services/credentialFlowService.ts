/**
 * credential flow service (Electron main) — client-owned browser callback flow
 * for providers whose consent must be completed on the client machine.
 */

import { z } from "zod";
import * as http from "node:http";
import { URL } from "node:url";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ProviderManifest } from "@natstack/shared/credentials/types";
import { createDevLogger } from "@natstack/dev-log";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("credential-flow");

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";

export interface CredentialFlowServiceDeps {
  serverClient: ServerClient;
  openBrowser?: (url: string) => Promise<void>;
}

interface LoopbackBinding {
  host: string;
  port: number;
  callbackPath: string;
}

export function createCredentialFlowService(deps: CredentialFlowServiceDeps): ServiceDefinition {
  const inFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();

  async function connect(provider: ProviderManifest): Promise<{ success: boolean; error?: string }> {
    const providerId = provider.id;
    const existing = inFlight.get(providerId);
    if (existing) {
      return existing;
    }

    const promise = runFlow(provider).then(() => ({ success: true } as const)).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Credential flow for ${providerId} failed: ${message}`);
      return { success: false, error: message };
    }).finally(() => {
      inFlight.delete(providerId);
    });

    inFlight.set(providerId, promise);
    return promise;
  }

  async function disconnect(providerId: string): Promise<void> {
    await deps.serverClient.call("credentials", "revokeConsent", [{ providerId }]);
  }

  async function runFlow(provider: ProviderManifest): Promise<void> {
    const providerId = provider.id;
    const { server, callbackPromise, redirectUri } = await bindLoopbackCallback(
      provider,
    );
    try {
      const { authorizeUrl, nonce } = await deps.serverClient.call(
        "credentials",
        "beginConsent",
        [{ provider, scopes: [], redirect: "client-loopback", redirectUri }],
      ) as { authorizeUrl: string; nonce: string };

      const waitForCallback = callbackPromise();
      const open = deps.openBrowser ?? (async (url: string) => {
        const { shell } = await import("electron");
        await shell.openExternal(url);
      });
      await open(authorizeUrl);

      const callbackUrl = await waitForCallback;
      const callback = new URL(callbackUrl);
      const code = callback.searchParams.get("code");
      if (!code) {
        throw new Error("OAuth callback missing code");
      }
      await deps.serverClient.call("credentials", "completeConsent", [{ nonce, code }]);
    } finally {
      try { server.close(); } catch { /* noop */ }
    }
  }

  return {
    name: "credentialFlow",
    description: "Client-owned browser callback flow for provider credentials",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      connect: { args: z.tuple([z.object({ id: z.string() }).passthrough()]) },
      disconnect: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "connect":
          return connect(args[0] as ProviderManifest);
        case "disconnect":
          return disconnect(args[0] as string);
        default:
          throw new Error(`Unknown credentialFlow method: ${method}`);
      }
    },
  };
}

async function bindLoopbackCallback(
  provider: ProviderManifest,
): Promise<{
  server: http.Server;
  redirectUri: string;
  callbackPromise: () => Promise<string>;
}> {
  const server = http.createServer();
  const binding = getProviderLoopbackBinding(provider);
  const { host, port, callbackPath } = binding;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `OAuth callback port ${port} is already in use. ` +
        `Close the other process (or another NatStack/pi-ai sign-in flow) and retry.`,
      );
    }
    throw err;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind loopback OAuth callback server");
  }
  const redirectUri = `http://${host}:${address.port}${callbackPath}`;

  function callbackPromise(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth flow timed out after 10 minutes"));
      }, FLOW_TIMEOUT_MS);

      const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== callbackPath) {
          res.statusCode = 404;
          res.end("not found");
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
        if (!url.searchParams.get("code")) {
          respondHtml(res, 400, errorPage("Missing authorization code."));
          cleanup();
          reject(new Error("OAuth callback missing code"));
          return;
        }

        respondHtml(res, 200, successPage());
        cleanup();
        resolve(url.toString());
      };

      function cleanup() {
        clearTimeout(timer);
        server.off("request", onRequest);
      }

      server.on("request", onRequest);
    });
  }

  return { server, redirectUri, callbackPromise };
}

function getProviderLoopbackBinding(provider: ProviderManifest): LoopbackBinding {
  const loopback = provider?.flows.find((flow) => flow.type === "loopback-pkce")?.loopback;
  return {
    host: loopback?.host ?? DEFAULT_LOOPBACK_HOST,
    port: loopback?.port ?? 0,
    callbackPath: loopback?.callbackPath ?? DEFAULT_CALLBACK_PATH,
  };
}

function respondHtml(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in complete</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d10;color:#e6e8ec}main{max-width:24rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9aa3ad}</style>
</head><body><main><h1>Sign-in complete</h1><p>You can close this window and return to NatStack.</p></main></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d10;color:#e6e8ec}main{max-width:28rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem;color:#ef6868}p{margin:0;color:#9aa3ad}</style>
</head><body><main><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
