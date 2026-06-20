import { AuthError } from "./output.js";
import { serverAuthRouteUrl, serverRpcHttpUrl } from "@natstack/shared/connect";

/**
 * HTTP RPC client for a paired NatStack server.
 *
 * Auth flow: the long-lived device credential (deviceId + refreshToken) is
 * exchanged at `/_r/s/auth/refresh-shell` for a short-lived shell token,
 * which authorizes `POST /rpc` Bearer calls. Shell tokens are cached
 * in-process per (url, deviceId); a 401 from `/rpc` triggers exactly one
 * refresh + retry before failing with an AuthError.
 */

export interface DeviceCredential {
  schemaVersion: 1;
  kind: "device";
  url: string;
  hubUrl?: string;
  workspaceName?: string;
  deviceId: string;
  refreshToken: string;
}

/** Response of POST /_r/s/auth/refresh-shell (see authService.ts). */
export interface RefreshShellResponse {
  shellToken: string;
  callerId: string;
  deviceId: string;
  label?: string;
  serverId?: string;
  serverBootId?: string;
  workspaceId?: string | null;
}

/** Server-reported RPC failure (HTTP 200 with an `error` body). */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function remoteErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const message = typeof body["error"] === "string" ? body["error"] : fallback;
  const code = typeof body["code"] === "string" ? body["code"] : undefined;
  return code ? `${message} [${code}]` : message;
}

async function fetchOrAuthError(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new AuthError(
      `cannot reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function refreshShell(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">
): Promise<RefreshShellResponse> {
  const response = await fetchOrAuthError(serverAuthRouteUrl(creds.url, "refresh-shell"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: creds.deviceId, refreshToken: creds.refreshToken }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body["shellToken"] !== "string") {
    throw new AuthError(
      remoteErrorMessage(body, `shell refresh failed (${response.status} ${response.statusText})`)
    );
  }
  return {
    shellToken: body["shellToken"],
    callerId: typeof body["callerId"] === "string" ? body["callerId"] : creds.deviceId,
    deviceId: typeof body["deviceId"] === "string" ? body["deviceId"] : creds.deviceId,
    label: typeof body["label"] === "string" ? body["label"] : undefined,
    serverId: typeof body["serverId"] === "string" ? body["serverId"] : undefined,
    serverBootId: typeof body["serverBootId"] === "string" ? body["serverBootId"] : undefined,
    workspaceId:
      typeof body["workspaceId"] === "string" || body["workspaceId"] === null
        ? body["workspaceId"]
        : undefined,
  };
}

// In-process shell-token cache, keyed per (url, deviceId) so multiple
// RpcClient instances within one CLI invocation share a token.
const shellTokenCache = new Map<string, string>();

function cacheKey(creds: Pick<DeviceCredential, "url" | "deviceId">): string {
  return `${creds.url}#${creds.deviceId}`;
}

/** Test hook: drop all cached shell tokens. */
export function clearShellTokenCache(): void {
  shellTokenCache.clear();
}

export class RpcClient {
  constructor(
    private readonly creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">
  ) {}

  /** Result of the most recent shell refresh, if one occurred. */
  lastRefresh: RefreshShellResponse | null = null;

  /**
   * Ensure a shell token exists (cached or freshly refreshed) and return it.
   * Lets callers that need the raw token (e.g. eval runner handshakes) share
   * the same token subsequent `call`s will use, instead of refreshing twice.
   */
  async getShellToken(): Promise<string> {
    return await this.ensureShellToken();
  }

  private async ensureShellToken(): Promise<string> {
    const cached = shellTokenCache.get(cacheKey(this.creds));
    if (cached) return cached;
    return await this.refreshShellToken();
  }

  private async refreshShellToken(): Promise<string> {
    const refresh = await refreshShell(this.creds);
    this.lastRefresh = refresh;
    shellTokenCache.set(cacheKey(this.creds), refresh.shellToken);
    return refresh.shellToken;
  }

  /** Direct service dispatch: `service.method` on the server dispatcher. */
  async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    return await this.dispatch<T>("main", method, args);
  }

  /** Relay call to a runtime target (worker, DO, panel) by entity/target id. */
  async callTarget<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    return await this.dispatch<T>(targetId, method, args);
  }

  /** Build an `RpcEnvelope` and POST it to the envelope-native `/rpc`. */
  private async dispatch<T>(targetId: string, method: string, args: unknown[]): Promise<T> {
    const requestId =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const caller = { callerId: this.creds.deviceId, callerKind: "shell" as const };
    const envelope = {
      from: caller.callerId,
      target: targetId,
      delivery: { caller },
      provenance: [caller],
      message: { type: "request", requestId, fromId: caller.callerId, method, args },
    };
    return await this.post<T>(envelope);
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    let token = await this.ensureShellToken();
    let response = await this.postRpc(token, body);
    if (response.status === 401) {
      // Shell token expired or server restarted — refresh once and retry.
      shellTokenCache.delete(cacheKey(this.creds));
      token = await this.refreshShellToken();
      response = await this.postRpc(token, body);
      if (response.status === 401) {
        const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new AuthError(remoteErrorMessage(errorBody, "unauthorized after token refresh"));
      }
    }
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new RpcError(
        typeof raw["error"] === "string"
          ? (raw["error"] as string)
          : `rpc failed (${response.status} ${response.statusText})`
      );
    }
    // The server replies with a response envelope { …, message: { result | error } }.
    const responseEnvelope = ("envelope" in raw ? raw["envelope"] : raw) as
      | { message?: { result?: unknown; error?: unknown; errorCode?: unknown } }
      | undefined;
    const message = responseEnvelope?.message;
    if (!message) {
      throw new RpcError("malformed rpc response (non-envelope or proxy response?)");
    }
    if (typeof message.error === "string") {
      throw new RpcError(
        message.error,
        typeof message.errorCode === "string" ? message.errorCode : undefined
      );
    }
    if (!("result" in message)) {
      throw new RpcError("malformed rpc response (no result)");
    }
    return message.result as T;
  }

  private postRpc(token: string, body: Record<string, unknown>): Promise<Response> {
    return fetchOrAuthError(serverRpcHttpUrl(this.creds.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }
}
