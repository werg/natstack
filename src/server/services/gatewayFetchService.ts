/**
 * gatewayFetchService — loopback panel-asset bridge for remote shells.
 *
 * In REMOTE mode the desktop has no local gateway: panels still load from a
 * loopback origin (`buildPanelUrl` → `http://127.0.0.1:{port}/{source}/`), but
 * the asset bytes live on the server. This service exposes a single `fetch`
 * method that the remote shell's panel-asset façade calls over the WebRTC pipe;
 * the server does a LOOPBACK fetch to its OWN gateway and returns the full
 * response (status + headers + base64 body).
 *
 * The gateway serves panel HTML/bundles/runtime helpers without auth (see
 * `Gateway` request routing — "Everything else → panel HTTP handler"), so no
 * token is required for the loopback fetch. A caller-supplied `Authorization`
 * header (and any other descriptor headers) is forwarded verbatim for the rare
 * asset path that wants it, but it is never injected here.
 *
 * The Response streams back over the pipe's bulk channel (panel bundles are MB).
 * Callers are the trusted desktop principals (`shell`, Electron-hosted `app`) and
 * panels (the panel runtime tunnels its gateway-relative asset fetches here);
 * workers/DOs are server-co-located and fetch the loopback gateway directly.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError } from "@natstack/shared/serviceDispatcher";

/** Loopback fetch request shape sent by the panel-asset façade. */
export interface GatewayFetchDescriptor {
  /** Absolute request path (must start with "/"), e.g. `/apps/shell/?contextId=…`. */
  path: string;
  /** HTTP method (defaults to GET). */
  method?: string;
  /** Headers to forward to the loopback gateway (e.g. an `Authorization` bearer). */
  headers?: Record<string, string>;
  /** Plain-string request body — e.g. the native bootstrap's JSON manifest POST
   * (`apps/mobile/index.js`), which sends `body: JSON.stringify(...)`. */
  body?: string;
  /** Base64-encoded request body for binary payloads — the panel's runtime
   * gatewayFetch base64-encodes its bytes. Mutually exclusive with `body`. */
  bodyBase64?: string;
  /** Gzip the response on the wire; the caller decompresses (see schema comment). */
  gzip?: boolean;
}

const fetchDescriptorSchema = z.object({
  path: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  bodyBase64: z.string().optional(),
  // Gzip the response on the wire. react-native-webrtc serializes its bulk-channel
  // receive (one message per round-trip), so a multi-MB asset streams too slowly
  // over a relay; gzip (~4×) keeps it inside the pipe window. The caller is
  // responsible for decompressing (the mobile native host does, before verifying
  // the *uncompressed* integrity). Signaled back via `x-natstack-content-gzip`.
  gzip: z.boolean().optional(),
});

export function createGatewayFetchService(deps: {
  /** Resolved loopback gateway port (lazy — finalized only after gateway start). */
  getGatewayPort: () => number;
}): ServiceDefinition {
  const serviceName = "gateway";

  return {
    name: serviceName,
    description: "Loopback panel-asset fetch bridge (remote shells)",
    // Reachable by the trusted desktop principals (remote shells call as `shell`
    // via the WebRtcServerClient main session; Electron-hosted runtimes call as
    // `app`) AND by panels — the panel runtime's gatewayFetch tunnels here as the
    // panel principal to load gateway-relative workspace assets. The path is forced
    // absolute and appended to the loopback gateway (no external origin), and a
    // panel already has fs access to the same workspace, so this grants nothing new.
    // (Workers/DOs are server-co-located and fetch the loopback gateway directly.)
    policy: { allowed: ["shell", "app", "panel"] },
    methods: {
      fetch: {
        description:
          "Loopback-fetch a panel asset from the server's own gateway and stream the " +
          "Response back over the pipe's bulk channel (a streaming method).",
        args: z.tuple([fetchDescriptorSchema]),
        // Streaming method: the handler returns a Response whose body is chunked
        // over the bulk channel by handleWsStreamRequest. Node callers use `.stream`
        // (Response); RN callers use `.streamReadable` (the raw ReadableStream).
        returns: z.instanceof(Response),
        access: { sensitivity: "read" },
      },
    },
    handler: async (_ctx, method, args) => {
      if (method !== "fetch") {
        throw new ServiceError(serviceName, method, `Unknown gateway method: ${method}`, "ENOSYS");
      }

      const descriptor = args[0] as GatewayFetchDescriptor;
      // Defense-in-depth: the path is concatenated after the loopback authority,
      // so a value not starting with "/" (e.g. "@evil.example") could re-point
      // the request at another host. Require an absolute path.
      if (!descriptor.path.startsWith("/")) {
        throw new ServiceError(
          serviceName,
          method,
          `gateway.fetch path must be absolute (start with "/"): ${descriptor.path}`,
          "EINVAL"
        );
      }

      const port = deps.getGatewayPort();
      const url = `http://127.0.0.1:${port}${descriptor.path}`;

      // STREAMING (via the pipe's stream path, handleWsStreamRequest): the body
      // rides the bulk channel chunked under the data-channel message-size limit.
      // A buffered base64 return would exceed that limit for real bundles (MB).
      const response = await fetch(url, {
        method: descriptor.method ?? "GET",
        headers: descriptor.headers,
        // bodyBase64 (binary, the panel path) takes precedence; body (a plain
        // string, the native bootstrap path) is the fallback. Either may be absent.
        ...(descriptor.bodyBase64 !== undefined
          ? { body: Buffer.from(descriptor.bodyBase64, "base64") }
          : descriptor.body !== undefined
            ? { body: descriptor.body }
            : {}),
      });

      if (descriptor.gzip && response.ok && response.body) {
        // Compress on the wire (see schema). The body is re-streamed through a gzip
        // transform; the caller decompresses. Drop content-length — the recompressed
        // length differs and the stream carries no length anyway.
        const headers = new Headers(response.headers);
        headers.set("x-natstack-content-gzip", "1");
        headers.delete("content-length");
        return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return response;
    },
  };
}
