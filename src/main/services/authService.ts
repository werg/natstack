/**
 * auth service (Electron main) — owns the interactive OAuth flow.
 *
 * Panels call `auth.startOAuthLogin('openai-codex')`. With `auth` removed
 * from `SERVER_SERVICE_NAMES`, the routing bridge sends the call here
 * (Electron main) instead of the remote server. We:
 *
 *   1. Bind a one-shot loopback HTTP server on `127.0.0.1:0` (RFC 8252
 *      §7.3 native-app loopback redirect).
 *   2. Build the provider's authorize URL via `@natstack/auth-flow` with
 *      `redirect_uri = http://127.0.0.1:<port>/cb`, PKCE challenge, state.
 *   3. `shell.openExternal` the URL — opens in the user's default browser.
 *   4. Wait for the redirect; validate state; exchange the code for tokens
 *      via `@natstack/auth-flow` (PKCE verifier travels with us, never
 *      leaves the client).
 *   5. Forward the resulting credentials to the server's `authTokens.persist`.
 *      Server-side workers parked on `authTokens.waitForProvider` unblock
 *      and the chat agent retries its turn.
 *
 * Status / list / logout queries proxy straight through to the server's
 * `authTokens` service — the server is the source of truth for what's
 * currently stored.
 */

import { z } from "zod";
import * as http from "node:http";
import { URL } from "node:url";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createDevLogger } from "@natstack/dev-log";
import { openaiCodex, type AuthFlowCredentials, type AuthFlowSession } from "@natstack/auth-flow";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("auth");

/** 10 minutes — long enough for the user to click through a sign-in. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingFlow {
  session: AuthFlowSession;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  server: http.Server;
}

interface ProviderHandle {
  buildAuthUrl(redirectUri: string): Promise<{ authUrl: string; session: AuthFlowSession }>;
  exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<AuthFlowCredentials>;
}

const PROVIDERS: Record<string, ProviderHandle> = {
  "openai-codex": {
    buildAuthUrl: (redirectUri) => openaiCodex.buildAuthorizeUrl({ redirectUri }),
    exchangeCode: (opts) => openaiCodex.exchangeCode(opts),
  },
};

export interface AuthServiceDeps {
  serverClient: ServerClient;
  /** Override `shell.openExternal` for tests. */
  openBrowser?: (url: string) => Promise<void>;
}

export function createAuthService(deps: AuthServiceDeps): ServiceDefinition {
  const inFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();

  async function startOAuthLogin(providerId: string): Promise<{ success: boolean; error?: string }> {
    const handle = PROVIDERS[providerId];
    if (!handle) return { success: false, error: `OAuth not supported for ${providerId}` };

    // Concurrent calls for the same provider share one flow — clicking the
    // Connect card twice shouldn't open two browser tabs.
    const existing = inFlight.get(providerId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const credentials = await runFlow(providerId, handle);
        await deps.serverClient.call("authTokens", "persist", [providerId, credentials]);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`OAuth flow for ${providerId} failed: ${message}`);
        return { success: false, error: message };
      }
    })().finally(() => {
      inFlight.delete(providerId);
    });

    inFlight.set(providerId, promise);
    return promise;
  }

  async function runFlow(
    providerId: string,
    handle: ProviderHandle,
  ): Promise<AuthFlowCredentials> {
    const { server, port, codePromise, redirectUri } = await bindLoopbackCallback();
    let pending: PendingFlow | null = null;
    try {
      const { authUrl, session } = await handle.buildAuthUrl(redirectUri);
      pending = { session, resolve: () => {}, reject: () => {}, server };

      const open = deps.openBrowser ?? (async (url: string) => {
        const { shell } = await import("electron");
        await shell.openExternal(url);
      });
      await open(authUrl);

      const code = await codePromise(session);
      return await handle.exchangeCode({
        code,
        verifier: session.verifier,
        redirectUri: session.redirectUri,
      });
    } finally {
      try { server.close(); } catch { /* noop */ }
      void pending; // suppress unused warning
      void providerId;
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
          return deps.serverClient.call("authTokens", "listProviders", []);
        case "logout":
          return deps.serverClient.call("authTokens", "logout", [args[0] as string]);
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
  port: number;
  redirectUri: string;
  codePromise: (session: AuthFlowSession) => Promise<string>;
}> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("loopback callback server bound to an unexpected address");
  }
  const port = address.port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  function codePromise(session: AuthFlowSession): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth flow timed out after 10 minutes"));
      }, FLOW_TIMEOUT_MS);

      const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/cb") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const error = url.searchParams.get("error");

        if (error) {
          respondHtml(res, 400, errorPage(`Provider returned an error: ${error}`));
          cleanup();
          reject(new Error(`OAuth provider error: ${error}`));
          return;
        }
        if (state !== session.state) {
          respondHtml(res, 400, errorPage("State mismatch — possible CSRF; sign-in aborted."));
          cleanup();
          reject(new Error("OAuth state mismatch"));
          return;
        }
        if (!code) {
          respondHtml(res, 400, errorPage("Missing authorization code."));
          cleanup();
          reject(new Error("OAuth callback missing code"));
          return;
        }

        respondHtml(res, 200, successPage());
        cleanup();
        resolve(code);
      };

      function cleanup() {
        clearTimeout(timer);
        server.off("request", onRequest);
      }

      server.on("request", onRequest);
    });
  }

  return { server, port, redirectUri, codePromise };
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
