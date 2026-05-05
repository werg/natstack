import type { Credential } from "../../../packages/shared/src/credentials/types.js";
import type { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import type { ClientConfigStore } from "../../../packages/shared/src/credentials/clientConfigStore.js";
import type { OAuthConnectionErrorCode } from "../../../packages/shared/src/credentials/types.js";

export class CredentialLifecycleError extends Error {
  constructor(public readonly code: OAuthConnectionErrorCode, message: string = code) {
    super(message);
  }
}

export interface CredentialLifecycleDeps {
  credentialStore: Pick<CredentialStore, "saveUrlBound">;
  clientConfigStore: Pick<ClientConfigStore, "load" | "loadVersion">;
}

export class CredentialLifecycle {
  constructor(private readonly deps: CredentialLifecycleDeps) {}

  async refreshIfNeeded(credential: Credential & { id: string }, options: { skewMs?: number } = {}): Promise<Credential & { id: string }> {
    const skewMs = options.skewMs ?? 30_000;
    if (!credential.expiresAt || credential.expiresAt > Date.now() + skewMs) {
      return credential;
    }
    if (!credential.refreshToken) {
      throw new CredentialLifecycleError("client_not_authorized", "OAuth credential is expired and has no refresh token");
    }
    return this.refreshCredential(credential);
  }

  async refreshCredential(credential: Credential & { id: string }): Promise<Credential & { id: string }> {
    const configId = credential.metadata?.["clientConfigId"];
    const configVersion = credential.metadata?.["clientConfigVersion"];
    const refreshToken = credential.refreshToken;
    if (!configId || !refreshToken) {
      throw new CredentialLifecycleError("client_not_authorized");
    }

    const config = configVersion
      ? await this.deps.clientConfigStore.loadVersion(configId, configVersion)
      : await this.deps.clientConfigStore.load(configId);
    if (!config) {
      throw new CredentialLifecycleError("client_not_authorized", "client config version is unavailable");
    }
    if (config.status === "deleted" || (config.status === "disabled" && !config.allowRefreshWhenDisabled)) {
      throw new CredentialLifecycleError("client_config_unavailable", "client config is unavailable for refresh");
    }

    const clientId = config.fields["clientId"]?.value;
    const clientSecret = config.fields["clientSecret"]?.value;
    if (!clientId) {
      throw new CredentialLifecycleError("client_not_authorized");
    }

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    body.set("client_id", clientId);
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw new CredentialLifecycleError("token_exchange_failed", formatOAuthTokenExchangeError(response.status, data, text));
    }

    const accessToken = data?.["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new CredentialLifecycleError("invalid_token_response");
    }
    const tokenType = data?.["token_type"];
    if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
      throw new CredentialLifecycleError("invalid_token_response", "OAuth refresh did not return bearer token_type");
    }

    const expiresIn = readNumericField(data?.["expires_in"]);
    const nextRefreshToken = data?.["refresh_token"];
    const updated = {
      ...credential,
      accessToken,
      refreshToken: typeof nextRefreshToken === "string" && nextRefreshToken ? nextRefreshToken : refreshToken,
      expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : credential.expiresAt,
      metadata: {
        ...(credential.metadata ?? {}),
        oauthTokenUpdatedAt: String(Date.now()),
      },
    } as Credential & { id: string };
    await this.deps.credentialStore.saveUrlBound(updated);
    return updated;
  }
}

function parseJsonObject(text: string, options: { strict: boolean }): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    if (options.strict) {
      throw new CredentialLifecycleError("invalid_token_response", "OAuth token endpoint returned invalid JSON");
    }
    return null;
  }
}

function readNumericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function formatOAuthTokenExchangeError(status: number, data: Record<string, unknown> | null, text: string): string {
  const error = typeof data?.["error"] === "string" ? data["error"] : undefined;
  const description = typeof data?.["error_description"] === "string" ? data["error_description"] : undefined;
  const suffix = error
    ? `${error}${description ? `: ${description}` : ""}`
    : sanitizeOAuthErrorText(text);
  return `OAuth token exchange failed: ${status}${suffix ? ` ${suffix}` : ""}`;
}

function sanitizeOAuthErrorText(text: string): string {
  return text
    .replace(/("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}
