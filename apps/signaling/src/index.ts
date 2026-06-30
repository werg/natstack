/**
 * NatStack signaling server (Cloudflare Worker + Durable Object).
 *
 * A deliberately dumb, UUID-addressed WebRTC rendezvous: it blind-relays SDP/ICE
 * between two peers and mints short-lived TURN credentials per session. Security
 * lives in the QR DTLS-fingerprint pin, NOT in this box (plan §2/§6).
 *
 * Routes (all under a per-room Durable Object addressed by `idFromName(roomId)`):
 *   GET  /healthz | /health            → liveness
 *   GET  /room/:roomId/ice-servers     → per-session STUN/TURN config (JSON)
 *   *    /room/:roomId  (Upgrade: ws)  → join the room; relay SDP/ICE
 */

import { SignalingRoom } from "./room";

// Re-exported so Wrangler can bind the Durable Object class (see wrangler.toml).
export { SignalingRoom };

interface Env {
  ENVIRONMENT?: string;
  SIGNALING_ROOM: DurableObjectNamespace;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      return json({ ok: true });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "room" && segments[1]) {
      // One Durable Object per room id; the room id IS the rendezvous secret.
      const id = env.SIGNALING_ROOM.idFromName(segments[1]);
      const stub = env.SIGNALING_ROOM.get(id);
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
};
