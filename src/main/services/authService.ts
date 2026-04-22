/**
 * auth service (Electron main) — client adapter for the interactive OAuth flow.
 *
 * Panels call `auth.startOAuthLogin('openai-codex')`. With `auth` removed
 * from `SERVER_SERVICE_NAMES`, the routing bridge sends the call here
 * (Electron main) instead of the remote server. We:
 *
 *   1. Bind a loopback callback listener on the client machine.
 *   2. Ask the server to prepare the OAuth flow and return an auth URL.
 *   3. `shell.openExternal` the URL — opens in the user's default browser.
 *   4. Wait for the redirect on localhost and forward the callback URL back
 *      to the server.
 *   5. The server validates state, exchanges the code, and persists tokens.
 *
 * Status / list / logout queries proxy straight through to the server's
 * `auth` service — the server is the source of truth for what's
 * currently stored.
 */

import { z } from "zod";
import * as http from "node:http";
import { URL } from "node:url";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createDevLogger } from "@natstack/dev-log";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("auth");

/** 10 minutes — long enough for the user to click through a sign-in. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * OpenAI's Codex OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`, shared with
 * pi-ai's CLI) registers exactly one loopback redirect URI:
 * `http://localhost:1455/auth/callback`. They do NOT honor RFC 8252 §7.3
 * port flexibility for this client, so we must bind this exact host+port
 * — anything else gets an `AuthApiFailure / unknown_error` at the
 * authorize endpoint. If we ever ship our own OpenAI OAuth client we
 * can revisit (and remove this constraint along with the singleton
 * port-busy failure mode).
 */
const CODEX_LOOPBACK_HOST = "localhost";
const CODEX_LOOPBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";

export interface AuthServiceDeps {
  serverClient: ServerClient;
  /** Override `shell.openExternal` for tests. */
  openBrowser?: (url: string) => Promise<void>;
}

interface ServerAuthProvider {
  provider: string;
  displayName: string;
  kind: "oauth" | "env-var";
  status: "connected" | "disconnected" | "configured" | "missing";
  envVar?: string;
}

interface ClientAuthProvider {
  id: string;
  name: string;
  kind: "oauth" | "env";
  status: "connected" | "disconnected" | "configured" | "unconfigured";
  envVar?: string;
}

function mapProviderStatus(provider: ServerAuthProvider): ClientAuthProvider {
  return {
    id: provider.provider,
    name: provider.displayName,
    kind: provider.kind === "env-var" ? "env" : "oauth",
    status: provider.status === "missing" ? "unconfigured" : provider.status,
    envVar: provider.envVar,
  };
}

export function createAuthService(deps: AuthServiceDeps): ServiceDefinition {
  const inFlight = new Map<string, Promise<void>>();

  async function startOAuthLogin(providerId: string): Promise<void> {
    // Concurrent calls for the same provider share one flow — clicking the
    // Connect card twice shouldn't open two browser tabs.
    const existing = inFlight.get(providerId);
    if (existing) return existing;

    const promise = runFlow(providerId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`OAuth flow for ${providerId} failed: ${message}`);
      throw err;
    }).finally(() => {
      inFlight.delete(providerId);
    });

    inFlight.set(providerId, promise);
    return promise;
  }

  async function listProviders(): Promise<ClientAuthProvider[]> {
    const providers = await deps.serverClient.call("auth", "listProviders", []) as ServerAuthProvider[];
    return providers.map(mapProviderStatus);
  }

  async function runFlow(providerId: string): Promise<void> {
    const { server, callbackPromise, redirectUri } = await bindLoopbackCallback();
    try {
      const { authUrl, flowId } = await deps.serverClient.call(
        "auth",
        "startOAuthLogin",
        [providerId, redirectUri],
      ) as { authUrl: string; flowId: string };

      const open = deps.openBrowser ?? (async (url: string) => {
        const { shell } = await import("electron");
        await shell.openExternal(url);
      });
      await open(authUrl);

      const callbackUrl = await callbackPromise();
      await deps.serverClient.call("auth", "completeOAuthLogin", [flowId, { callbackUrl }]);
    } finally {
      try { server.close(); } catch { /* noop */ }
    }
  }

  return {
    name: "auth",
    description: "Interactive OAuth login flow (client-owned)",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      startOAuthLogin: { args: z.tuple([z.string()]) },
      listProviders: { args: z.tuple([]) },
      logout: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "startOAuthLogin":
          return startOAuthLogin(args[0] as string);
        case "listProviders":
          return listProviders();
        case "logout":
          return deps.serverClient.call("auth", "logout", [args[0] as string]);
        default:
          throw new Error(`Unknown auth method: ${method}`);
      }
    },
  };
}

/**
 * Bind an ephemeral loopback HTTP server. Returns the listen port plus a
 * function that, given an `AuthFlowSession`, awaits the matching redirect
 * (validates `state`, extracts `code`, renders a tiny success/error page,
 * shuts the server down).
 */
async function bindLoopbackCallback(): Promise<{
  server: http.Server;
  redirectUri: string;
  callbackPromise: () => Promise<string>;
}> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(CODEX_LOOPBACK_PORT, CODEX_LOOPBACK_HOST, () => resolve());
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE") {
      throw new Error(
        `OAuth callback port ${CODEX_LOOPBACK_PORT} is already in use. ` +
        `Close the other process (or another NatStack/pi-ai sign-in flow) and retry.`,
      );
    }
    throw err;
  }
  const port = CODEX_LOOPBACK_PORT;
  const redirectUri = `http://${CODEX_LOOPBACK_HOST}:${port}${CODEX_CALLBACK_PATH}`;

  function callbackPromise(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth flow timed out after 10 minutes"));
      }, FLOW_TIMEOUT_MS);

      const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== CODEX_CALLBACK_PATH) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const error = url.searchParams.get("error");

        if (error) {
          respondHtml(res, 400, errorPage(`Provider returned an error: ${error}`));
          cleanup();
          reject(new Error(`OAuth provider error: ${error}`));
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
