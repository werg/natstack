/**
 * NatStack webhook relay (Cloudflare Worker).
 *
 * This worker is intentionally a thin edge forwarder. Provider-specific
 * verification, lease lookup, subscription ownership, and delivery all live in
 * the NatStack server's credential webhook service.
 */

interface Env {
  ENVIRONMENT?: string;
  NATSTACK_SERVER_BASE_URL?: string;
  NATSTACK_SERVER_BEARER_TOKEN?: string;
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
      segments[0] === "calendar"
    ) {
      const [, leaseId] = segments;
      return forward(env, request, `/_r/s/credentialWebhooks/calendar/${leaseId}`, {
        leaseId,
        delivery: "https-post",
      });
    }

    if (
      request.method === "POST" &&
      segments.length === 2 &&
      segments[0] === "pubsub"
    ) {
      const [, providerId] = segments;
      return forward(env, request, `/_r/s/credentialWebhooks/pubsub/${providerId}`, {
        providerId,
        delivery: "pubsub-push",
      });
    }

    return notFound();
  },
};

async function forward(
  env: Env,
  request: Request,
  path: string,
  metadata: Record<string, unknown>,
): Promise<Response> {
  const baseUrl = normalizeBaseUrl(env.NATSTACK_SERVER_BASE_URL);
  if (!baseUrl) {
    return json({ error: "NATSTACK_SERVER_BASE_URL is not configured", ...metadata }, { status: 500 });
  }

  const headers = new Headers(request.headers);
  if (env.NATSTACK_SERVER_BEARER_TOKEN) {
    headers.set("Authorization", `Bearer ${env.NATSTACK_SERVER_BEARER_TOKEN}`);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: request.method,
    headers,
    body: await request.arrayBuffer(),
  });
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
