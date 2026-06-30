/**
 * NatStack callback relay (Cloudflare Worker) — SHARED two-profile relay.
 *
 * Plan §7: one public edge serving two profiles on one backhaul.
 *
 *   - WEBHOOK (stateful):  POST /i/<subscriptionId>      -> RelayRegistry DO
 *   - OAUTH landing:       GET  /oauth/callback/...       -> RelayRegistry DO
 *   - Universal-link host: GET  /.well-known/apple-app-site-association
 *                          GET  /.well-known/assetlinks.json
 *   - Backhaul:            WS   /backhaul                 -> RelayRegistry DO
 *
 * This entry is a thin router: all multi-tenant state (backhaul sockets,
 * first-writer-wins registration, durable webhook buffer, ephemeral OAuth map)
 * lives in the single global RelayRegistry Durable Object. The well-known
 * universal-link documents are stateless (env-derived) so they are served here.
 */

import { RelayRegistry, type Env } from "./registry";
import {
  buildAppleAppSiteAssociation,
  buildAssetlinks,
  universalLinkConfigFromEnv,
} from "./oauthLanding";

export { RelayRegistry };
export type { Env };

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function notFound(): Response {
  return json({ error: "not found" }, { status: 404 });
}

function relayStub(env: Env): DurableObjectStub {
  // One global registry: every server backhauls into the same instance so
  // first-writer-wins and subscriptionId routing are globally consistent.
  return env.RELAY_REGISTRY.get(env.RELAY_REGISTRY.idFromName("global"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      return json({ ok: true });
    }

    // Universal-link host — anchors the relay's own origin so the mobile OS
    // deep-links /oauth/callback/* into the app. Fails loud when unconfigured
    // rather than serving a broken association.
    if (request.method === "GET" && url.pathname === "/.well-known/apple-app-site-association") {
      const doc = buildAppleAppSiteAssociation(universalLinkConfigFromEnv(env));
      if (!doc) return json({ error: "universal-link host not configured" }, { status: 503 });
      return wellKnownJson(doc);
    }
    if (request.method === "GET" && url.pathname === "/.well-known/assetlinks.json") {
      const doc = buildAssetlinks(universalLinkConfigFromEnv(env));
      if (!doc) return json({ error: "universal-link host not configured" }, { status: 503 });
      return wellKnownJson(doc);
    }

    // Everything stateful is owned by the global RelayRegistry DO.
    if (url.pathname === "/backhaul" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return relayStub(env).fetch(request);
    }
    if (request.method === "POST" && url.pathname.startsWith("/i/")) {
      return relayStub(env).fetch(request);
    }
    if (request.method === "GET" && url.pathname.startsWith("/oauth/callback")) {
      return relayStub(env).fetch(request);
    }

    return notFound();
  },
};

function wellKnownJson(doc: unknown): Response {
  // Apple rejects anything but application/json (silently). nosniff for parity
  // with the dedicated well-known site.
  return new Response(JSON.stringify(doc), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
