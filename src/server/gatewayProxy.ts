/**
 * Simple HTTP reverse proxy for gateway routing.
 */

import { request, type IncomingMessage, type ServerResponse } from "http";

/**
 * Proxy an HTTP request to a local service port.
 */
export function createProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  targetPath: string,
  hostHeader?: string,
): void {
  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        ...(hostHeader ? { host: hostHeader } : {}),
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end(`Gateway proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
}
