import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectNet } from "node:net";
import type { Duplex } from "node:stream";

export interface ProxyRequestOptions {
  targetPort: number;
  targetPath: string;
  hostname?: string;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
  auth: { mode: "passthrough" } | { mode: "replace"; upstreamToken: string };
  errorPrefix?: string;
  onProxySocketOpen?: () => void;
  onProxySocketClose?: () => void;
  logWarning?: (message: string) => void;
}

const STRIP_UPSTREAM_HEADERS = new Set<string>(["authorization", "cookie", "proxy-authorization"]);

function buildProxyHeaders(
  req: IncomingMessage,
  opts: Pick<ProxyRequestOptions, "auth" | "hostHeader" | "extraHeaders">
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (opts.auth.mode === "replace") {
      if (STRIP_UPSTREAM_HEADERS.has(lower)) continue;
      if (lower.startsWith("x-natstack-")) continue;
    }
    out[k] = v as string | string[];
  }
  if (opts.auth.mode === "replace") {
    out["authorization"] = `Bearer ${opts.auth.upstreamToken}`;
  }
  if (opts.hostHeader) out["host"] = opts.hostHeader;
  Object.assign(out, opts.extraHeaders ?? {});
  return out;
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProxyRequestOptions
): void {
  const safeHeaders = buildProxyHeaders(req, opts);
  const proxyReq = request(
    {
      hostname: opts.hostname ?? "127.0.0.1",
      port: opts.targetPort,
      path: opts.targetPath,
      method: req.method,
      headers: safeHeaders,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.on("error", (err) => {
        opts.logWarning?.(`Proxy response stream error: ${err.message}`);
        try {
          res.end();
        } catch {
          /* already closed */
        }
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("socket", () => opts.onProxySocketOpen?.());
  proxyReq.on("close", () => opts.onProxySocketClose?.());

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end(`${opts.errorPrefix ?? "Gateway proxy error"}: ${err.message}`);
  });

  req.pipe(proxyReq);
}

export interface ProxyUpgradeOptions extends Omit<
  ProxyRequestOptions,
  "targetPath" | "hostHeader" | "errorPrefix"
> {
  targetPath?: string;
}

export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: ProxyUpgradeOptions
): void {
  const safeHeaders = buildProxyHeaders(req, opts);
  const targetSocket = connectNet(opts.targetPort, opts.hostname ?? "127.0.0.1", () => {
    opts.onProxySocketOpen?.();
    const path = opts.targetPath ?? req.url ?? "/";
    const headers = Object.entries(safeHeaders)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    const upgradeReq = `${req.method} ${path} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`;

    targetSocket.write(upgradeReq);
    if (head.length > 0) targetSocket.write(head);

    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    opts.onProxySocketClose?.();
  };
  targetSocket.on("close", closeOnce);

  targetSocket.on("error", (err) => {
    opts.logWarning?.(`Gateway WS proxy error: ${err.message}`);
    socket.destroy();
  });

  socket.on("error", () => {
    targetSocket.destroy();
  });
  socket.on("close", () => {
    targetSocket.destroy();
    closeOnce();
  });
}
