/**
 * panelAssetFacade — loopback panel-asset HTTP/1.1 server for React Native.
 *
 * The mobile sibling of `src/main/panelAssetFacade.ts`. Panels load from a fixed
 * loopback origin (`buildPanelUrl` → `http://127.0.0.1:<facadePort>/{source}/…`).
 * On mobile there is no local gateway — the RPC plane rides the WebRTC pipe — so
 * this tiny loopback TCP server stands in for it: it parses each webview asset
 * request, proxies it to the remote gateway over the pipe via the STREAMING
 * `gateway.fetch` RPC, and streams the response back chunked.
 *
 * Panel bundles are multiple MB. Requesting `gzip` on the wire + chunked transfer
 * keeps each payload inside react-native-webrtc's serialized-receive throughput
 * (the same constraint that forced gzip on the Part A native bundle stream). The
 * gateway marks a gzipped body with `x-natstack-content-gzip` (NOT
 * `Content-Encoding`, so the pipe's fetch never auto-inflates it); we translate
 * that to a real `Content-Encoding: gzip` and the webview inflates natively — the
 * façade never touches the bytes.
 *
 * The only client is the in-app webview (loopback, one request per connection),
 * so the HTTP/1.1 handling is deliberately minimal. Panel RPC still rides the
 * postMessage shell bridge, so this socket carries no management surface and
 * needs no per-request auth.
 */

import TcpSocket from "react-native-tcp-socket";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  GZIP_MARKER_HEADER,
} from "@natstack/shared/panel/assetHeaders";
import type { MobileRpcClient } from "./mobileTransport";

// The connected-socket type — `Socket` is a member of the default export's
// namespace, not a top-level named export, so derive the instance type from it.
type TcpSocketConn = InstanceType<typeof TcpSocket.Socket>;

const MAX_REQUEST_HEAD_BYTES = 64 * 1024;

export interface PanelAssetFacade {
  port: number;
  close(): Promise<void>;
}

/**
 * Start the loopback panel-asset façade. Resolves once the ephemeral port is
 * bound; point `buildPanelUrl` (via `hostConfig.port`) at the returned `port`.
 */
export function startPanelAssetFacade(transport: MobileRpcClient): Promise<PanelAssetFacade> {
  const server = TcpSocket.createServer((socket) => {
    handleConnection(transport, socket);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address !== "object" || typeof address.port !== "number") {
        reject(new Error("Panel asset façade failed to bind a TCP port"));
        return;
      }
      const { port } = address;
      console.log(`[NatStackMobileSmoke] phase=workspace-panel-facade-listening ${JSON.stringify({ port })}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            try {
              server.close(() => resolveClose());
            } catch {
              resolveClose();
            }
          }),
      });
    });
  });
}

function handleConnection(transport: MobileRpcClient, socket: TcpSocketConn): void {
  let head = "";
  let dispatched = false;
  try {
    socket.setNoDelay(true);
  } catch {
    // best-effort
  }
  socket.on("data", (data: string | Buffer) => {
    if (dispatched) return;
    head += typeof data === "string" ? data : data.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_REQUEST_HEAD_BYTES) {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      return;
    }
    dispatched = true;
    void handleRequest(transport, socket, head.slice(0, end));
  });
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  });
}

async function handleRequest(
  transport: MobileRpcClient,
  socket: TcpSocketConn,
  rawHead: string
): Promise<void> {
  const lines = rawHead.split("\r\n");
  const [method = "GET", target = "/"] = (lines[0] ?? "").split(" ");
  let headSent = false;
  try {
    // Target the server "main" with the fully-qualified method (the bootstrap's
    // proven bundle-stream call). NOT ("gateway","fetch") — that routes to the
    // streaming endpoint's proxyFetch-only fast path and is rejected.
    const result = await transport.streamReadable("main", "gateway.fetch", [
      { path: target, method, headers: collectForwardHeaders(lines.slice(1)), gzip: true },
    ]);

    const statusText = result.statusText || "OK";
    const out: string[] = [`HTTP/1.1 ${result.status} ${statusText}`];
    let gzipped = false;
    for (const [key, value] of result.headers) {
      const lower = key.toLowerCase();
      if (lower === GZIP_MARKER_HEADER) {
        gzipped = value === "1";
        continue;
      }
      if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
      out.push(`${key}: ${value}`);
    }
    if (gzipped) out.push("Content-Encoding: gzip");
    // No Content-Length (the body is streamed) — chunked framing lets the webview
    // detect a complete vs truncated response. One request per connection.
    out.push("Transfer-Encoding: chunked");
    out.push("Connection: close");
    out.push("", "");
    await writeToSocket(socket, out.join("\r\n"));
    headSent = true;

    const reader = result.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await writeToSocket(socket, `${value.byteLength.toString(16)}\r\n`);
          await writeToSocket(socket, value);
          await writeToSocket(socket, "\r\n");
        }
      }
      await writeToSocket(socket, "0\r\n\r\n");
    } finally {
      reader.releaseLock();
    }
    socket.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[panel-facade] asset fetch failed for ${target}: ${message}`);
    if (!headSent && !socket.destroyed) {
      try {
        socket.write(
          "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        );
        socket.end();
        return;
      } catch {
        // fall through to destroy
      }
    }
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  }
}

function collectForwardHeaders(headerLines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!FORWARD_REQUEST_HEADERS.includes(name)) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * Write with backpressure: `socket.write` returns false when the kernel buffer is
 * full, so wait for `drain` before the next write (a multi-MB bundle would
 * otherwise balloon JS memory). Rejects if the socket closes mid-write so the
 * streaming loop tears down instead of hanging on a `drain` that never comes.
 */
function writeToSocket(socket: TcpSocketConn, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error("socket closed"));
      return;
    }
    // Resolve only when the write is CONFIRMED written (the native "written"
    // callback), not merely queued. `socket.end()` closes immediately without
    // draining (Socket.end → NativeModules.TcpSockets.end), so resolving on the
    // queued `write()` return value lets end() truncate small still-queued
    // responses — which is why small assets (e.g. __transport.js) intermittently
    // failed to load while large (drain-gated) ones succeeded. Confirming each
    // write also serializes them, which gives implicit backpressure.
    socket.write(data, undefined, (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
