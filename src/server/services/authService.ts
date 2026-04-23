/**
 * authTokens service — server-side OAuth/API-key store for AI providers.
 *
 * After the auth refactor, the server owns token storage and refresh. The
 * interactive browser/callback transport still runs on the client.
 *
 *   - persist tokens delivered by a client or auth flow service;
 *   - silently refresh expiring tokens (refresh-token grant — no browser);
 *   - hand fresh tokens to in-process AI workers on demand;
 *   - park `waitForProvider` callers until a token becomes available.
 *
 * Browser-opening and callback capture run on the client. The core auth flow
 * can still be orchestrated server-side via `authFlowService`.
 *
 * Credentials are persisted at `~/.config/natstack/oauth-tokens.json`
 * (mode 0o600), one entry per provider.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type {
  OAuthCredentials,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { CodexTokenProvider } from "./oauthProviders/codexTokenProvider.js";

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

interface OAuthProviderRegistration {
  displayName: string;
  /** Server-side token-side surface: refresh + getApiKey only. The
   *  acquisition (login) side lives on the client. */
  provider: OAuthProviderInterface;
}

export interface ProviderStatus {
  provider: string;
  kind: "oauth" | "env-var";
  status: "connected" | "disconnected" | "configured" | "missing";
  displayName: string;
  envVar?: string;
}

export interface AuthTokensServiceDeps {
  /** Override the on-disk credentials path. Used by tests. */
  tokensPath?: string;
  /** Injection points for tests — swap the default provider instances. */
  providerOverrides?: Record<string, OAuthProviderInterface>;
}

interface ProviderWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Wire-shape accepted by `authTokens.persist`. Mirrors `AuthFlowCredentials`
 *  in `@natstack/auth-flow` — we deliberately don't import that package
 *  here to keep the server's runtime decoupled from the client's flow lib. */
export interface PersistedCredentialsInput {
  access: string;
  refresh: string;
  expires: number;
  extra?: Record<string, unknown>;
}

const persistInputSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  extra: z.record(z.unknown()).optional(),
});

export class AuthTokensServiceImpl {
  private credentials: StoredCredentials = {};
  private loaded = false;
  private readonly tokensPath: string;
  private readonly oauthProviders: Record<string, OAuthProviderRegistration> = {};
  private readonly waiters = new Map<string, Set<ProviderWaiter>>();
  constructor(private readonly deps: AuthTokensServiceDeps) {
    this.tokensPath = deps.tokensPath ?? OAUTH_TOKENS_PATH;

    this.oauthProviders["openai-codex"] = {
      displayName: "OpenAI Codex (ChatGPT subscription)",
      provider: new CodexTokenProvider(),
    };

    if (deps.providerOverrides) {
      for (const [id, p] of Object.entries(deps.providerOverrides)) {
        this.oauthProviders[id] = {
          displayName: this.oauthProviders[id]?.displayName ?? id,
          provider: p,
        };
      }
    }
  }

  private resolveApiKey(providerId: string): string | undefined {
    const envVar = ENV_API_KEY_PROVIDERS[providerId];
    if (!envVar) return undefined;
    return process.env[envVar];
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

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });
    await fs.writeFile(this.tokensPath, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
  }

  /**
   * Returns a current auth token for the given provider.
   * - OAuth providers: refreshes silently (refresh-token grant) when
   *   expired; persists the refreshed credentials before returning.
   * - Env-var providers: reads from process.env.
   * Throws if not configured (caller can pair with `waitForProvider` to
   *   block until a client completes a login).
   */
  async getProviderToken(providerId: string): Promise<string> {
    const oauth = this.oauthProviders[providerId];
    if (oauth) {
      await this.load();
      const stored = this.credentials[providerId];
      if (!stored) {
        throw new Error(`Not logged in to ${providerId}. Use the settings panel to connect.`);
      }
      const now = Date.now();
      let current = stored;
      if (now >= stored.expires) {
        const refreshed = await oauth.provider.refreshToken(stored);
        current = { ...refreshed, storedAt: Date.now() };
        this.credentials[providerId] = current;
        await this.write();
      }
      return oauth.provider.getApiKey(current);
    }

    const envVar = ENV_API_KEY_PROVIDERS[providerId];
    if (!envVar) throw new Error(`Unknown provider: ${providerId}`);
    const key = this.resolveApiKey(providerId);
    if (!key) throw new Error(`No API key configured for ${providerId} (set ${envVar})`);
    return key;
  }

  /**
   * Persist credentials produced by a client-side OAuth flow. The client
   * (Electron main / mobile shell) ran the browser, captured the redirect,
   * and exchanged the code for tokens via `@natstack/auth-flow`. We just
   * write them and unblock anyone parked on `waitForProvider`.
   */
  async persist(providerId: string, credentials: PersistedCredentialsInput): Promise<void> {
    if (!this.oauthProviders[providerId]) {
      throw new Error(`OAuth not supported for ${providerId}`);
    }
    await this.load();
    // The on-disk shape is pi-ai's OAuthCredentials. Provider-specific
    // extras (e.g. `accountId` for OpenAI) live at top level there, so we
    // hoist them out of `extra` for storage compatibility with the
    // `getApiKey` / `refreshToken` paths.
    const stored: OAuthCredentials & { storedAt: number } = {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      ...((credentials.extra ?? {}) as Record<string, unknown>),
      storedAt: Date.now(),
    } as OAuthCredentials & { storedAt: number };
    this.credentials[providerId] = stored;
    await this.write();
    this.notifyWaiters(providerId);
  }

  /**
   * Wait until credentials become available for `providerId`. Returns
   * immediately if a valid token already exists; otherwise blocks until a
   * client completes login and `persist` lands. Used by agent worker DOs.
   *
   * Rejects with a Timeout error after `timeoutMs` (default 10 minutes).
   */
  async waitForProvider(providerId: string, timeoutMs = 600_000): Promise<void> {
    try {
      await this.getProviderToken(providerId);
      return;
    } catch {
      // Fall through and park.
    }

    return new Promise<void>((resolve, reject) => {
      const set = this.waiters.get(providerId) ?? new Set<ProviderWaiter>();
      this.waiters.set(providerId, set);

      const entry: ProviderWaiter = { resolve: () => {}, reject: () => {} };
      const timer = setTimeout(() => {
        set.delete(entry);
        reject(new Error(`Timed out waiting for ${providerId} OAuth after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.resolve = () => { clearTimeout(timer); set.delete(entry); resolve(); };
      entry.reject = (err) => { clearTimeout(timer); set.delete(entry); reject(err); };
      set.add(entry);
    });
  }

  private notifyWaiters(providerId: string): void {
    const set = this.waiters.get(providerId);
    if (!set || set.size === 0) return;
    for (const entry of [...set]) entry.resolve();
  }

  async logout(providerId: string): Promise<void> {
    await this.load();
    delete this.credentials[providerId];
    await this.write();
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
        status: this.resolveApiKey(providerId) ? "configured" : "missing",
        displayName: providerId,
        envVar,
      });
    }
    return all;
  }
}

/**
 * Factory. The service no longer owns any OAuth callback route — the
 * gateway's `/_r/s/auth/oauth/callback` route was removed when login moved
 * to the clients.
 */
export function createAuthTokensService(deps: { authTokens: AuthTokensServiceImpl }): ServiceDefinition {
  return {
    name: "authTokens",
    description: "Persist and serve OAuth/API-key tokens for AI providers",
    // Workers fetch tokens for outbound API calls; panels list provider
    // status; clients (Electron / mobile) call persist + logout after the
    // flow they own completes. Server callers (background refresh) too.
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      getProviderToken: { args: z.tuple([z.string()]) },
      persist: { args: z.tuple([z.string(), persistInputSchema]) },
      logout: { args: z.tuple([z.string()]) },
      listProviders: { args: z.tuple([]) },
      waitForProvider: { args: z.tuple([z.string(), z.number().optional()]) },
    },
    handler: async (_ctx, method, args) => {
      const svc = deps.authTokens;
      switch (method) {
        case "getProviderToken":
          return svc.getProviderToken(args[0] as string);
        case "persist":
          return svc.persist(args[0] as string, args[1] as PersistedCredentialsInput);
        case "logout":
          return svc.logout(args[0] as string);
        case "listProviders":
          return svc.listProviders();
        case "waitForProvider":
          return svc.waitForProvider(args[0] as string, args[1] as number | undefined);
        default:
          throw new Error(`Unknown authTokens method: ${method}`);
      }
    },
  };
}
