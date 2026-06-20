export interface GatewayFetchConfig {
  serverUrl: string;
  token: string;
  /**
   * Constrain the helper to gateway-relative paths only: reject any path that
   * resolves to a different origin (absolute `http(s)://`, protocol-relative
   * `//host`, or `..`-escapes). This keeps the bearer token from ever reaching a
   * non-gateway host — used by the EvalDO, whose `gatewayFetch` is exposed to
   * arbitrary (prompt-injectable) eval code; external requests must go through
   * `credentials.fetch` (the egress proxy) instead.
   */
  relativeOnly?: boolean;
}

export type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function createGatewayFetch(config: GatewayFetchConfig): GatewayFetch {
  const baseUrl = config.serverUrl.replace(/\/$/, "");
  const baseOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.token}`);
    let target: string;
    if (config.relativeOnly) {
      if (!baseOrigin) {
        throw new Error("gatewayFetch: gateway origin is not configured");
      }
      // Resolve against the gateway base; reject anything that escapes its origin.
      const resolved = new URL(path, `${baseUrl}/`);
      if (resolved.origin !== baseOrigin) {
        throw new Error(
          `gatewayFetch: only gateway-relative paths are allowed (got "${path}"). ` +
            `Use credentials.fetch for external requests.`,
        );
      }
      target = resolved.toString();
    } else {
      target =
        path.startsWith("http://") || path.startsWith("https://")
          ? path
          : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    }
    return fetch(target, { ...init, headers });
  };
}
