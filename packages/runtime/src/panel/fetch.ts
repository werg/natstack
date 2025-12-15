import type { RuntimeFetch, FetchOptions, FetchResponse } from "../types.js";

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export const fetch: RuntimeFetch = async (url: string, options?: FetchOptions): Promise<FetchResponse> => {
  const response = await globalThis.fetch(url, {
    method: options?.method,
    headers: options?.headers,
    body: options?.body,
  });
  const body = await response.text();
  const headers = headersToRecord(response.headers);
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    ok: response.ok,
    json<T = unknown>(): T {
      return JSON.parse(body) as T;
    },
    text(): string {
      return body;
    },
  };
};

