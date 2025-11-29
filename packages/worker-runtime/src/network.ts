/**
 * Network proxy for workers.
 *
 * This module uses the unified __serviceCall global for network requests.
 * Workers have full network access - the main process proxies fetch calls.
 */

import type { WorkerFetch, FetchResponse, FetchOptions } from "./types.js";

// Declare the unified service call global
declare const __serviceCall: (
  service: string,
  method: string,
  ...args: unknown[]
) => Promise<unknown>;

interface RawFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Create a FetchResponse object from the raw response.
 */
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

/**
 * Fetch function for workers.
 * Proxies requests through the main process.
 */
export const fetch: WorkerFetch = async (
  url: string,
  options?: FetchOptions
): Promise<FetchResponse> => {
  const raw = (await __serviceCall("network", "fetch", url, options)) as RawFetchResponse;
  return createResponse(raw);
};
