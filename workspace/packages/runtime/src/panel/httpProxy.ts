/**
 * Panel-side HTTP proxy client.
 *
 * Routes fetch requests through the server to avoid CORS restrictions
 * when panels need to call external APIs (e.g., Gmail, Calendar).
 */

import type { RpcBridge } from "@natstack/rpc";

export interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpProxyClient {
  /** Proxy a fetch request through the server. */
  fetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpProxyResponse>;
}

export function createHttpProxyClient(rpc: RpcBridge): HttpProxyClient {
  return {
    async fetch(url, init) {
      return rpc.call<HttpProxyResponse>("main", "http-proxy.fetch", url, init);
    },
  };
}
