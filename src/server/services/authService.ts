/**
 * Auth service — unified auth tokens for AI providers.
 *
 * - OAuth providers (e.g. OpenAI Codex ChatGPT subscription): full login flow,
 *   persistence, and refresh handled via pi-ai helpers.
 * - Raw API key providers (anthropic, openai, google, groq, mistral, openrouter):
 *   fall back to `process.env.<PROVIDER>_API_KEY`.
 *
 * Credentials are persisted at `~/.config/natstack/oauth-tokens.json` (mode 0o600).
 *
 * The server opens the OAuth browser itself via `deps.openBrowser(url)`. In
 * Electron mode this is wired to `shell.openExternal` via the parent-port
 * message router (see src/main/serverProcessManager.ts). In standalone mode
 * it logs the URL for manual opening. The panel UI never sees the URL.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import {
  NatstackCodexProvider,
  CODEX_CALLBACK_PATH,
} from "./oauthProviders/natstackCodexProvider.js";

const OAUTH_TOKENS_PATH = path.join(homedir(), ".config", "natstack", "oauth-tokens.json");

interface StoredCredentials {
  [providerId: string]: OAuthCredentials & { storedAt: number };
}

const ENV_API_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Providers that go through OAuth. Each entry carries both the UI-facing
// display name AND a live `OAuthProviderInterface` instance. openai-codex
// now uses `NatstackCodexProvider` — our own implementation that works with
// a remote server (pi-ai's implementation hardcodes `localhost:1455` as the
// redirect URI, which fails when the browser lives on a different machine
// than the server; see `natstackCodexProvider.ts`).
interface OAuthProviderRegistration {
  displayName: string;
  provider: OAuthProviderInterface;
  /** Routes to register on the gateway for this provider's callback flow.
   *  Service-routes are keyed by serviceName (always "auth" here) so the
   *  final URL is `/_r/s/auth${path}`. */
  routes?: ServiceRouteDecl[];
}

export interface ProviderStatus {
  provider: string;
  kind: "oauth" | "env-var";
  status: "connected" | "disconnected" | "configured" | "missing";
  displayName: string;
  envVar?: string;
}

export interface AuthServiceDeps {
  /**
   * Open a URL in the user's default browser. In Electron IPC mode, wires to
   * `shell.openExternal` via a parent-port message. In standalone mode this
   * is typically a console.log fallback — remote clients receive the URL via
   * `emitOpenExternalTo` instead and open it on the machine they run on.
   */
  openBrowser: (url: string) => void;
  /**
   * Send a URL-open request to exactly ONE connected client (the initiator
   * of the flow), identified by its callerId. Returns `true` if the target
   * is alive and the event was delivered, `false` if the target is missing
   * (client disconnected since starting the flow). Callers must NOT fall
   * back to a broadcast on `false` — that would fan the URL out to other
   * connected clients, causing every open app to spawn its own browser tab.
   */
  emitOpenExternalTo?: (url: string, initiatorCallerId: string) => boolean;
  /** Externally-reachable base URL. Used to build OAuth redirect URIs.
   *  The gateway now runs in both IPC and standalone modes, so this is
   *  always available — required, not optional. */
  getPublicUrl: () => string;
  /** Override the on-disk credentials path. Used by tests. */
  tokensPath?: string;
  /** Injection points for tests — swap the default provider instances. */
  providerOverrides?: Record<string, OAuthProviderInterface>;
}

/** A waiter parked on `waitForProvider`. Resolved when an OAuth completes
 *  for `providerId`, OR when an env-var becomes available, OR rejected on
 *  caller-supplied timeout. */
interface ProviderWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class AuthServiceImpl {
  private credentials: StoredCredentials = {};
  private loaded = false;
  private readonly tokensPath: string;
  /** Provider instances keyed by providerId. `NatstackCodexProvider` for
   *  openai-codex, plus any test overrides. */
  private readonly oauthProviders: Record<string, OAuthProviderRegistration> = {};
  /** Reference to the codex provider — kept alongside its `OAuthProviderInterface`
   *  registration so the `/oauth/callback` route handler can delegate to it.
   *  `null` only when a test's `providerOverrides` replaces openai-codex with
   *  a non-NatstackCodex instance. */
  private codexProvider: NatstackCodexProvider | null = null;
  /**
   * In-flight `startOAuthLogin` calls keyed by providerId. Concurrent calls
   * for the same provider get the same in-flight Promise back, so two chat
   * panels racing to OAuth never start two flows.
   */
  private readonly inFlightLogins = new Map<
    string,
    Promise<{ success: boolean; error?: string }>
  >();
  /**
   * Callers parked on `waitForProvider`. Notified when an OAuth flow for
   * the providerId completes successfully (regardless of who triggered it),
   * so any pending agent worker DO unblocks even if the user clicked the
   * Connect card in a sibling panel.
   */
  private readonly waiters = new Map<string, Set<ProviderWaiter>>();

  constructor(private readonly deps: AuthServiceDeps) {
    this.tokensPath = deps.tokensPath ?? OAUTH_TOKENS_PATH;

    // openai-codex is always served by our own `NatstackCodexProvider`
    // (gateway-hosted callback route). The gateway runs in both IPC and
    // standalone modes, so `getPublicUrl()` resolves in both: IPC →
    // `http://localhost:<gatewayPort>`, standalone → whatever the operator
    // configured. No mode-specific fallback — one OAuth code path.
    const codex = new NatstackCodexProvider({
      getPublicUrl: deps.getPublicUrl,
    });
    this.codexProvider = codex;
    this.oauthProviders["openai-codex"] = {
      displayName: "OpenAI Codex (ChatGPT subscription)",
      provider: codex,
    };

    // Apply test overrides.
    if (deps.providerOverrides) {
      for (const [id, p] of Object.entries(deps.providerOverrides)) {
        this.oauthProviders[id] = {
          displayName: this.oauthProviders[id]?.displayName ?? id,
          provider: p,
        };
        if (id === "openai-codex") {
          // Override dropped the NatstackCodex path — no callback handler.
          this.codexProvider =
            p instanceof NatstackCodexProvider ? p : null;
        }
      }
    }
  }

  /** HTTP handler for `GET /_r/s/auth/oauth/callback`. Delegates to the
   *  NatstackCodexProvider instance. Returns 404 body if the codex provider
   *  has been overridden out. */
  async handleOAuthCallback(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.codexProvider) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("OAuth callback handler not available");
      return;
    }
    await this.codexProvider.handleCallback(req, res);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await fs.readFile(this.tokensPath, "utf-8");
      this.credentials = JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.credentials = {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });
    await fs.writeFile(this.tokensPath, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
  }

  /**
   * Returns a current auth token for the given provider.
   * - OAuth providers: refreshes if needed via pi-ai's getOAuthApiKey, which
   *   returns `{ newCredentials, apiKey }`. If newCredentials !== stored we
   *   persist the refreshed credentials before returning.
   * - Env-var providers: reads from process.env.
   * Throws if not configured.
   */
  async getProviderToken(providerId: string): Promise<string> {
    const oauth = this.oauthProviders[providerId];
    if (oauth) {
      await this.load();
      const stored = this.credentials[providerId];
      if (!stored) {
        throw new Error(`Not logged in to ${providerId}. Use the settings panel to connect.`);
      }

      // Call the provider directly rather than pi-ai's getOAuthApiKey wrapper:
      // that wrapper hardcodes lookup into pi-ai's own provider registry, so
      // it doesn't know about `NatstackCodexProvider`. Inlining the refresh
      // branch is five lines and keeps the provider contract the source of
      // truth.
      const now = Date.now();
      let current = stored;
      if (now >= stored.expires) {
        const refreshed = await oauth.provider.refreshToken(stored);
        current = { ...refreshed, storedAt: Date.now() };
        this.credentials[providerId] = current;
        await this.persist();
      }
      return oauth.provider.getApiKey(current);
    }

    const envVar = ENV_API_KEY_PROVIDERS[providerId];
    if (!envVar) throw new Error(`Unknown provider: ${providerId}`);
    const key = process.env[envVar];
    if (!key) throw new Error(`No API key configured for ${providerId} (set ${envVar})`);
    return key;
  }

  /**
   * Drive the OAuth login flow for an OAuth provider. Blocks for the duration
   * of the user's browser interaction (seconds-to-minutes). The RPC layer has
   * no per-method timeout so the promise simply resolves when login completes.
   *
   * Idempotent in two layers:
   *   1. Fast path — if credentials are already valid, returns success without
   *      starting a new flow. (Multiple Connect-card clicks after the first
   *      successful login are no-ops.)
   *   2. In-flight dedupe — concurrent calls for the same providerId share the
   *      same Promise, preventing the local OAuth callback server from being
   *      started twice when two chat panels race.
   *
   * The server opens the browser itself via `deps.openBrowser(url)`. The panel
   * UI just shows "Waiting for browser…" and never sees the URL.
   */
  async startOAuthLogin(
    providerId: string,
    initiatorCallerId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const oauth = this.oauthProviders[providerId];
    if (!oauth) return { success: false, error: `OAuth not supported for ${providerId}` };

    // Layer 1: fast path — credentials already exist and resolve cleanly.
    try {
      await this.getProviderToken(providerId);
      return { success: true };
    } catch {
      // Not logged in (or refresh failed) — continue to start a new flow.
    }

    // Layer 2: in-flight dedupe.
    const inflight = this.inFlightLogins.get(providerId);
    if (inflight) return inflight;

    const promise = (async () => {
      const callbacks: OAuthLoginCallbacks = {
        onAuth: (info) => {
          // Server-side open (logs URL in standalone mode; shell.openExternal
          // in Electron-IPC mode when the user IS on the server).
          this.deps.openBrowser(info.url);

          // Dispatch the URL to the initiating client only. Broadcasting
          // would cause every connected app (desktop + mobile) to spawn its
          // own browser tab on its own device. If delivery fails, the flow
          // must abort: there's no safe fallback — another client shouldn't
          // handle somebody else's login.
          if (initiatorCallerId && this.deps.emitOpenExternalTo) {
            const delivered = this.deps.emitOpenExternalTo(info.url, initiatorCallerId);
            if (!delivered) {
              throw new Error(
                "OAuth initiator disconnected before the auth URL was ready; retry from the client",
              );
            }
          }
        },
        onPrompt: async (_prompt) => {
          // NatstackCodexProvider never falls back to manual paste — its
          // gateway callback route catches the code. If this fires, it's a
          // bug in the provider, not user error.
          throw new Error("Manual code prompt is not supported; this indicates an internal error");
        },
        onProgress: (_msg) => {
          // Optional progress messages — could be streamed back to the UI later.
        },
      };

      try {
        const credentials = await oauth.provider.login(callbacks);
        await this.load();
        this.credentials[providerId] = { ...credentials, storedAt: Date.now() };
        await this.persist();
        // Notify any agent workers parked on `waitForProvider` so they can
        // retry their token lookup and resume the user's turn.
        this.notifyWaiters(providerId);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    })().finally(() => {
      this.inFlightLogins.delete(providerId);
    });

    this.inFlightLogins.set(providerId, promise);
    return promise;
  }

  /**
   * Wait until credentials become available for `providerId`. Returns
   * immediately if a valid token already exists; otherwise blocks until
   * `startOAuthLogin` completes for this provider (from any caller — chat
   * panel Connect card, settings dialog, or anywhere else).
   *
   * Used by agent worker DOs from inside `getApiKey` so that all pending
   * workers unblock the moment the user completes OAuth in any one panel.
   *
   * Rejects with a Timeout error after `timeoutMs` (default 10 minutes).
   */
  async waitForProvider(providerId: string, timeoutMs = 600_000): Promise<void> {
    // Fast path: a valid token is already available (env-var or stored OAuth).
    try {
      await this.getProviderToken(providerId);
      return;
    } catch {
      // Not logged in — park.
    }

    return new Promise<void>((resolve, reject) => {
      const set = this.waiters.get(providerId) ?? new Set<ProviderWaiter>();
      this.waiters.set(providerId, set);

      const entry: ProviderWaiter = { resolve: () => {}, reject: () => {} };

      const timer = setTimeout(() => {
        set.delete(entry);
        reject(
          new Error(
            `Timed out waiting for ${providerId} OAuth after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      entry.resolve = () => {
        clearTimeout(timer);
        set.delete(entry);
        resolve();
      };
      entry.reject = (err) => {
        clearTimeout(timer);
        set.delete(entry);
        reject(err);
      };

      set.add(entry);
    });
  }

  private notifyWaiters(providerId: string): void {
    const set = this.waiters.get(providerId);
    if (!set || set.size === 0) return;
    // Snapshot before iterating because resolve() mutates the set.
    const snapshot = [...set];
    for (const entry of snapshot) entry.resolve();
  }

  async logout(providerId: string): Promise<void> {
    await this.load();
    delete this.credentials[providerId];
    await this.persist();
  }

  async listProviders(): Promise<ProviderStatus[]> {
    await this.load();
    const all: ProviderStatus[] = [];
    for (const [providerId, info] of Object.entries(this.oauthProviders)) {
      all.push({
        provider: providerId,
        kind: "oauth",
        status: this.credentials[providerId] ? "connected" : "disconnected",
        displayName: info.displayName,
      });
    }
    for (const [providerId, envVar] of Object.entries(ENV_API_KEY_PROVIDERS)) {
      all.push({
        provider: providerId,
        kind: "env-var",
        status: process.env[envVar] ? "configured" : "missing",
        displayName: providerId,
        envVar,
      });
    }
    return all;
  }
}

/**
 * Factory that produces the auth service's RPC definition plus the HTTP
 * route that receives OAuth callbacks. The gateway wires the route via
 * `RouteRegistry.registerService(routes)` alongside dispatcher registration.
 */
export function createAuthService(deps: {
  authService: AuthServiceImpl;
}): { definition: ServiceDefinition; routes: ServiceRouteDecl[] } {
  const definition: ServiceDefinition = {
    name: "auth",
    description: "Auth tokens for AI providers (OAuth + env-var)",
    // "shell" is included because both src/renderer/components/SettingsDialog.tsx
    // and workspace/about/model-provider-config (which has "shell": true in its
    // package.json) call auth.* via the shell IPC dispatcher with callerKind "shell".
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      getProviderToken: { args: z.tuple([z.string()]) },
      startOAuthLogin: { args: z.tuple([z.string()]) },
      logout: { args: z.tuple([z.string()]) },
      listProviders: { args: z.tuple([]) },
      waitForProvider: { args: z.tuple([z.string(), z.number().optional()]) },
    },
    handler: async (ctx, method, args) => {
      const svc = deps.authService;
      switch (method) {
        case "getProviderToken":
          return svc.getProviderToken(args[0] as string);
        case "startOAuthLogin":
          // Thread the caller's ID so open-external events can be routed
          // back to just the initiating client (see emitOpenExternalTo).
          return svc.startOAuthLogin(args[0] as string, ctx.callerId);
        case "logout":
          return svc.logout(args[0] as string);
        case "listProviders":
          return svc.listProviders();
        case "waitForProvider":
          return svc.waitForProvider(
            args[0] as string,
            args[1] as number | undefined,
          );
        default:
          throw new Error(`Unknown auth method: ${method}`);
      }
    },
  };

  const routes: ServiceRouteDecl[] = [{
    serviceName: "auth",
    path: CODEX_CALLBACK_PATH,
    methods: ["GET"],
    auth: "public",
    handler: (req, res) => deps.authService.handleOAuthCallback(req, res),
  }];

  return { definition, routes };
}
