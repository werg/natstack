import type { FetchOptions, FetchResponse, RuntimeFetch } from "../types.js";
import type { RpcBridge } from "@natstack/rpc";

interface RawFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

function createResponse(raw: RawFetchResponse): FetchResponse {
  return {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
    body: raw.body,
    ok: raw.status >= 200 && raw.status < 300,
    json<T = unknown>(): T {
      return JSON.parse(raw.body) as T;
    },
    text(): string {
      return raw.body;
    },
  };
}

export type WorkerFetchFactory = ((rpc: RpcBridge) => RuntimeFetch) & { __natstackProvider: "rpc-factory" };

export const createWorkerFetch: WorkerFetchFactory = Object.assign(
  (rpc: RpcBridge): RuntimeFetch => {
    return async (url: string, options?: FetchOptions): Promise<FetchResponse> => {
      const raw = await rpc.call<RawFetchResponse>("main", "network.fetch", url, options);
      return createResponse(raw);
    };
  },
  { __natstackProvider: "rpc-factory" as const }
);
