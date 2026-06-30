/**
 * panelAssetFacade — loopback panel-asset server for REMOTE sessions.
 *
 * Panels always load from a fixed loopback origin
 * (`buildPanelUrl` → `http://127.0.0.1:{gatewayPort}/{source}/?contextId=…`).
 * In LOCAL mode that port is the child server's gateway. In REMOTE mode there
 * is no local gateway — the RPC plane rides the WebRTC pipe — so this façade
 * stands in for it: a tiny loopback HTTP server that proxies every request to
 * the remote server's own gateway via the `gateway.fetch` STREAMING RPC and
 * pipes the response body straight back to the webview. Streaming (not a
 * buffered base64 return) is mandatory: real panel bundles are multiple MB and
 * would exceed the WebRTC control-channel message-size limit; the bulk channel
 * chunks them.
 *
 * It is dependency-free (node `http`/`stream` only), serves non-secret panel
 * assets, and binds 127.0.0.1 only. Panel RPC still rides the pipe (the grant
 * token reaches the panel out-of-band via the shell bridge), so this socket
 * carries no management surface and needs no per-request token.
 */

import * as http from "node:http";
import { Readable } from "node:stream";
import { createDevLogger } from "@natstack/dev-log";
import type { ServerClient } from "./serverClient.js";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
} from "@natstack/shared/panel/assetHeaders";

const log = createDevLogger("PanelAssetFacade");

function collectForwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    // Every forwarded name is a single-value request header (IncomingHttpHeaders
    // types them `string | undefined`), so a plain string check is exhaustive.
    const value = req.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Start the loopback panel-asset façade. Resolves once the ephemeral port is
 * bound; `buildPanelUrl` should then be pointed at the returned `port`.
 */
export function startPanelAssetFacade(
  serverClient: ServerClient
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleRequest(serverClient, req, res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Panel asset façade failed to bind a TCP port"));
        return;
      }
      const { port } = address;
      log.info(`Panel asset façade listening on http://127.0.0.1:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

async function handleRequest(
  serverClient: ServerClient,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const path = req.url ?? "/";
  try {
    const response = await serverClient.stream("gateway", "fetch", [
      {
        path,
        method: req.method ?? "GET",
        headers: collectForwardHeaders(req),
      },
    ]);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Drop the hop headers: the body is re-framed over the pipe and re-sent
      // chunked, so upstream length/encoding/transfer no longer apply.
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });
    res.writeHead(response.status, headers);

    if (!response.body) {
      res.end();
      return;
    }
    // Pipe the streamed body straight to the webview (Node uses chunked transfer
    // since Content-Length was stripped). Tear down on error either way.
    const nodeBody = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeBody.on("error", (err) => {
      log.warn(`Panel asset stream errored for ${path}: ${err.message}`);
      if (!res.writableEnded) res.destroy(err);
    });
    nodeBody.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Panel asset fetch failed for ${path}: ${message}`);
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Panel asset bridge error");
  }
}
