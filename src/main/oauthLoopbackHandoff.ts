import * as http from "node:http";

export interface OAuthLoopbackHandoff {
  transactionId: string;
  redirectUri: string;
  host: "localhost" | "127.0.0.1";
  port: number;
  callbackPath: string;
  state: string;
  timeoutMs: number;
}

export interface ExternalOpenPayload {
  url?: string;
  oauthLoopback?: OAuthLoopbackHandoff;
}

export async function handleExternalOpenPayload(
  payload: ExternalOpenPayload,
  deps: {
    openExternal(url: string): Promise<unknown>;
    forwardOAuthCallback(request: {
      transactionId: string;
      url: string;
      state?: string;
    }): Promise<unknown>;
  }
): Promise<void> {
  if (!payload.url) return;
  if (!payload.oauthLoopback) {
    await deps.openExternal(payload.url);
    return;
  }

  const callback = await startOAuthLoopbackCallback(payload.oauthLoopback);
  try {
    await deps.openExternal(payload.url);
    const received = await callback.wait;
    await deps.forwardOAuthCallback({
      transactionId: payload.oauthLoopback.transactionId,
      url: received.url,
      state: received.state,
    });
  } finally {
    callback.close();
  }
}

async function startOAuthLoopbackCallback(loopback: OAuthLoopbackHandoff): Promise<{
  wait: Promise<{ url: string; state?: string }>;
  close(): void;
}> {
  const callbackPath = normalizeCallbackPath(loopback.callbackPath);
  let settled = false;
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveCallback!: (value: { url: string; state?: string }) => void;
  let rejectCallback!: (error: Error) => void;

  const wait = new Promise<{ url: string; state?: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", loopback.redirectUri);
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const state = url.searchParams.get("state") ?? undefined;
    if (state !== loopback.state) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OAuth state mismatch.");
      if (!settled) {
        settled = true;
        rejectCallback(new Error("OAuth state mismatch"));
      }
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><title>Connection complete</title><p>Connection complete. You can close this window.</p>"
    );
    if (!settled) {
      settled = true;
      resolveCallback({ url: url.toString(), state });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      listening = true;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(loopback.port, loopback.host);
  });

  timer = setTimeout(
    () => {
      if (!settled) {
        settled = true;
        rejectCallback(new Error("OAuth callback timed out"));
      }
      closeServer();
    },
    Math.max(1_000, loopback.timeoutMs)
  );

  wait
    .finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    })
    .catch(() => undefined);

  return {
    wait,
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      closeServer();
    },
  };

  function closeServer(): void {
    if (!listening) return;
    listening = false;
    server.close();
  }
}

function normalizeCallbackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
