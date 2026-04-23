interface Env {
  ENVIRONMENT: string;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    ...init,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "webhook"
    ) {
      const [, instanceId, providerId] = segments;

      void env;
      void instanceId;
      void providerId;

      return json({ received: true });
    }

    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "ws"
    ) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return json(
          { error: "Expected WebSocket upgrade request" },
          { status: 426 },
        );
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      server.send(JSON.stringify({ type: "connected" }));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return json({ error: "Not found" }, { status: 404 });
  },
};
