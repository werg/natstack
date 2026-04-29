/**
 * NatStack webhook relay (Cloudflare Worker).
 *
 * This worker is intentionally a thin edge forwarder. Provider-specific
 * verification, subscription ownership, and delivery all live in the NatStack
 * server's webhook ingress service.
 */

import { sha256Hex, signRelayEnvelope } from "./envelope";

interface Env {
  ENVIRONMENT?: string;
  NATSTACK_SERVER_BASE_URL?: string;
  NATSTACK_RELAY_SIGNING_SECRET?: string;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

function notFound(): Response {
  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      return json({ ok: true });
    }

    if (
      request.method === "POST" &&
      segments.length === 2 &&
      segments[0] === "i"
    ) {
      const [, subscriptionId] = segments;
      return forwardSignedIngress(env, request, subscriptionId!);
    }

    return notFound();
  },
};

async function forwardSignedIngress(
  env: Env,
  request: Request,
  subscriptionId: string,
): Promise<Response> {
  const baseUrl = normalizeBaseUrl(env.NATSTACK_SERVER_BASE_URL);
  if (!baseUrl) {
    return json({ error: "NATSTACK_SERVER_BASE_URL is not configured", subscriptionId }, { status: 500 });
  }
  if (!env.NATSTACK_RELAY_SIGNING_SECRET) {
    return json({ error: "NATSTACK_RELAY_SIGNING_SECRET is not configured", subscriptionId }, { status: 500 });
  }

  const url = new URL(request.url);
  const rawBody = await request.arrayBuffer();
  const bodySha256 = await sha256Hex(rawBody);
  const timestamp = Date.now().toString();
  const publicPath = url.pathname;
  const publicQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const signature = await signRelayEnvelope(env.NATSTACK_RELAY_SIGNING_SECRET, {
    method: request.method,
    path: publicPath,
    query: publicQuery,
    timestamp,
    bodySha256,
  });

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.set("X-NatStack-Relay-Timestamp", timestamp);
  headers.set("X-NatStack-Relay-Body-SHA256", bodySha256);
  headers.set("X-NatStack-Relay-Method", request.method.toUpperCase());
  headers.set("X-NatStack-Relay-Path", publicPath);
  headers.set("X-NatStack-Relay-Query", publicQuery);
  headers.set("X-NatStack-Relay-Signature", signature);

  const response = await fetch(`${baseUrl}/_r/s/webhookIngress/${encodeURIComponent(subscriptionId)}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  return copyResponse(response);
}

async function copyResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeBaseUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
