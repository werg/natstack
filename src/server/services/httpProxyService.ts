/**
 * HTTP Proxy Service — server-side fetch proxy for panels.
 *
 * Enables panels to call external APIs without CORS restrictions.
 * Requests are proxied through the server process which has
 * unrestricted network access.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

export function createHttpProxyService(): ServiceDefinition {
  return {
    name: "http-proxy",
    description: "Proxied HTTP requests for panels (bypasses CORS)",
    policy: { allowed: ["panel", "worker", "server"] },
    methods: {
      fetch: {
        args: z.tuple([
          z.string(), // url
          z.object({
            method: z.string().optional(),
            headers: z.record(z.string()).optional(),
            body: z.string().optional(),
          }).optional(),
        ]),
      },
    },
    handler: async (_ctx, method, args) => {
      if (method !== "fetch") {
        throw new Error(`Unknown http-proxy method: ${method}`);
      }

      const [url, init] = args as [string, { method?: string; headers?: Record<string, string>; body?: string } | undefined];

      // Validate URL
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      // Only allow http/https
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${parsed.protocol}`);
      }

      const res = await fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body,
      });

      // Check response size via Content-Length header
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        throw new Error(
          `Response too large (${contentLength} bytes, max ${MAX_RESPONSE_SIZE}). ` +
          `Consider using pagination or streaming.`,
        );
      }

      const body = await res.text();
      if (body.length > MAX_RESPONSE_SIZE) {
        throw new Error(
          `Response body too large (${body.length} bytes, max ${MAX_RESPONSE_SIZE}).`,
        );
      }

      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });

      return {
        status: res.status,
        headers: respHeaders,
        body,
      };
    },
  };
}
