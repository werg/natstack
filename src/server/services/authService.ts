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

/**
 * pi-ai's runtime OAuth helpers live at the `@mariozechner/pi-ai/oauth` deep
 * subpath (since 0.66). pi-ai is ESM-only and that subpath only declares an
 * `import` condition — no `require`. Our server bundles in CJS format
 * (`dist/server-electron.cjs`) and marks pi-ai as external, so a static
 * `import` would be transpiled to `require("@mariozechner/pi-ai/oauth")` and
 * fail at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * Workaround: lazy-load via dynamic `import()` (preserved verbatim by esbuild
 * for externals; Node's ESM loader handles the deep subpath correctly). The
 * module is loaded once on first use and cached.
 */
type PiAiOauthModule = {
  openaiCodexOAuthProvider: OAuthProviderInterface;
  getOAuthApiKey: (
    providerId: string,
    credentials: Record<string, OAuthCredentials>,
  ) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
};
let _piAiOauthPromise: Promise<PiAiOauthModule> | null = null;
function loadPiAiOauth(): Promise<PiAiOauthModule> {
  if (!_piAiOauthPromise) {
    _piAiOauthPromise = import("@mariozechner/pi-ai/oauth") as Promise<PiAiOauthModule>;
  }
  return _piAiOauthPromise;
}

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

// Providers that go through OAuth. The OAuthProviderInterface instance is
// resolved lazily from `loadPiAiOauth()` because pi-ai is ESM-only and we
// can't statically import its runtime values from our CJS bundle.
// Map shape: providerId → { displayName, key into the loaded module }.
// In v1: just openai-codex. In v2: github-copilot, google-gemini-cli, etc.
const OAUTH_PROVIDERS: Record<
  string,
  { displayName: string; moduleKey: keyof PiAiOauthModule }
> = {
  "openai-codex": {
    displayName: "OpenAI Codex (ChatGPT subscription)",
    moduleKey: "openaiCodexOAuthProvider",
  },
};

async function getOAuthProvider(providerId: string): Promise<OAuthProviderInterface | null> {
  const cfg = OAUTH_PROVIDERS[providerId];
  if (!cfg) return null;
  const mod = await loadPiAiOauth();
  return mod[cfg.moduleKey] as OAuthProviderInterface;
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
   * Open a URL in the user's default browser. In Electron mode, wires to
   * `shell.openExternal` via a parent-port message. In standalone mode,
   * prints the URL to the console for manual opening.
   */
  openBrowser: (url: string) => void;
  /** Override the on-disk credentials path. Used by tests. */
  tokensPath?: string;
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
  /**
   * In-flight `startOAuthLogin` calls keyed by providerId. Concurrent calls
   * for the same provider get the same in-flight Promise back, so two chat
   * panels racing to OAuth never start two local callback servers.
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
    const oauth = OAUTH_PROVIDERS[providerId];
    if (oauth) {
      await this.load();
      const stored = this.credentials[providerId];
      if (!stored) {
        throw new Error(`Not logged in to ${providerId}. Use the settings panel to connect.`);
      }

      // pi-ai's getOAuthApiKey reads credentials[providerId], refreshes locally
      // if Date.now() >= creds.expires, and returns the (possibly new) creds via
      // newCredentials. It does NOT mutate the input map. Verified in
      // node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js:112-132.
      const { getOAuthApiKey } = await loadPiAiOauth();
      const result = await getOAuthApiKey(providerId, { [providerId]: stored });
      if (!result) throw new Error(`No credentials for ${providerId}`);

      // If credentials were refreshed, persist the new ones.
      if (result.newCredentials !== stored) {
        this.credentials[providerId] = { ...result.newCredentials, storedAt: Date.now() };
        await this.persist();
      }
      return result.apiKey;
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
  async startOAuthLogin(providerId: string): Promise<{ success: boolean; error?: string }> {
    const oauth = OAUTH_PROVIDERS[providerId];
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
          // pi-ai's loginOpenAICodex emits the auth URL via this callback after
          // it spins up the local HTTP callback server. Open the browser server-side.
          this.deps.openBrowser(info.url);
        },
        onPrompt: async (_prompt) => {
          // OpenAI Codex flow uses the local callback server, not manual code entry.
          throw new Error("Manual code prompt not supported for openai-codex");
        },
        onProgress: (_msg) => {
          // Optional progress messages — could be streamed back to the UI later.
        },
      };

      try {
        const provider = await getOAuthProvider(providerId);
        if (!provider) {
          return { success: false, error: `OAuth not supported for ${providerId}` };
        }
        const credentials = await provider.login(callbacks);
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
    for (const [providerId, info] of Object.entries(OAUTH_PROVIDERS)) {
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

export function createAuthService(deps: { authService: AuthServiceImpl }): ServiceDefinition {
  return {
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
    handler: async (_ctx, method, args) => {
      const svc = deps.authService;
      switch (method) {
        case "getProviderToken":
          return svc.getProviderToken(args[0] as string);
        case "startOAuthLogin":
          return svc.startOAuthLogin(args[0] as string);
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
}
