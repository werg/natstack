export interface GatewayFetchConfig {
  serverUrl: string;
  token?: string;
}

export type GatewayFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function createGatewayFetch(config: GatewayFetchConfig): GatewayFetch {
  const baseUrl = config.serverUrl.replace(/\/$/, "");
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
    const target = path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    return fetch(target, { ...init, headers });
  };
}
