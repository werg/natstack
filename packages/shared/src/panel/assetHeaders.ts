/**
 * Shared panel-asset façade header policy. The desktop (Node `http`) and mobile
 * (`react-native-tcp-socket`) façades both proxy webview asset requests over the
 * host pipe to `gateway.fetch`, so they MUST forward + strip the SAME headers.
 * These lists had drifted — mobile silently dropped `authorization`, so auth'd
 * asset routes loaded on desktop but 401'd on mobile. Single-sourced here so the
 * policy can't diverge again; the per-transport streaming/parsing plumbing stays
 * in each façade (only the policy is shared).
 */

/**
 * Request headers forwarded to the gateway. `host`, `cookie`, and
 * `accept-encoding` are intentionally NOT forwarded — they describe the façade hop,
 * not the upstream asset request (and the gateway serves assets uncompressed).
 */
export const FORWARD_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "accept",
  "accept-language",
  "cache-control",
  "range",
  "if-none-match",
  "if-modified-since",
  "user-agent",
];

/**
 * Response headers that describe the buffered / re-framed hop and must NOT be
 * echoed to the webview: the body is fully re-sent, so length is recomputed and
 * any upstream content/transfer encoding no longer applies.
 */
export const STRIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

/**
 * Set (value `"1"`) by `gateway.fetch` when it gzipped the body on the wire, so a
 * façade can re-derive `Content-Encoding: gzip` for the webview after stripping the
 * upstream encoding header.
 */
export const GZIP_MARKER_HEADER = "x-natstack-content-gzip";
