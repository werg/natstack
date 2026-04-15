/**
 * tlsPinning — shared helpers for fingerprint-pinned TLS connections.
 *
 * Both the main RPC client (`serverClient.ts`) and the remote health
 * poller (`remoteHealthPoll.ts`) need the same behavior:
 *
 *   1. Open a TLS connection bypassing normal CA / hostname validation
 *      (the whole point of pinning is for self-signed servers where CA
 *      validation would always fail).
 *   2. Read the peer's leaf-cert SHA-256 hash in the `secureConnect`
 *      event, synchronously.
 *   3. Destroy the socket on mismatch — before any application-layer
 *      byte (HTTP upgrade line, ws:auth frame, GET request line) is
 *      written. `secureConnect` fires between TLS handshake completion
 *      and any user-level write, so this window is the correct hook.
 *
 * Centralizing the logic also means one place handles the SNI-on-IP
 * literal quirk (RFC 6066 forbids IP addresses as SNI values; Node
 * enforces this, so we must skip `servername` when the host is an IP).
 */

import { createHash, X509Certificate } from "crypto";
import * as fs from "fs";
import * as tls from "tls";
import { Agent as HttpsAgent } from "https";

/** SHA-256 fingerprint of a DER cert buffer as uppercase colon-separated hex. */
export function sha256Fingerprint(der: Buffer): string {
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

/** SHA-256 fingerprint of a PEM-encoded certificate string. */
export function pemFingerprint(pem: string | Buffer): string {
  const cert = new X509Certificate(pem);
  return cert.fingerprint256;
}

/** SHA-256 fingerprint of a PEM-encoded certificate on disk. */
export function pemFileFingerprint(pemPath: string): string {
  return pemFingerprint(fs.readFileSync(pemPath));
}

/** True when `host` is an IPv4 or IPv6 literal (SNI-incompatible). */
export function isIpLiteral(host: string): boolean {
  // IPv4: four dot-separated numeric segments. IPv6: contains colons
  // (brackets already stripped by URL parsing).
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Open a TLS socket and attach a synchronous fingerprint check. On
 * mismatch, `socket.destroy(err)` fires before any app-layer byte.
 *
 * Used by ws's `createConnection` option AND by `HttpsAgent.createConnection`
 * via `createPinnedHttpsAgent()` below.
 */
export function createPinnedTlsSocket(
  opts: { host: string; port: number; expectedFingerprint: string },
): tls.TLSSocket {
  const sock = tls.connect({
    host: opts.host,
    port: opts.port,
    ...(isIpLiteral(opts.host) ? {} : { servername: opts.host }),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });
  sock.once("secureConnect", () => {
    const cert = sock.getPeerCertificate(false);
    if (!cert || !cert.raw) {
      sock.destroy(new Error("TLS fingerprint pinning: peer presented no certificate"));
      return;
    }
    const actual = sha256Fingerprint(cert.raw);
    if (actual !== opts.expectedFingerprint) {
      sock.destroy(new Error(
        `TLS fingerprint mismatch: expected ${opts.expectedFingerprint}, got ${actual}`,
      ));
    }
  });
  return sock;
}

/**
 * Build an `HttpsAgent` that pins every connection to `expectedFingerprint`.
 * Reusable across requests so connection pooling works; the fingerprint
 * check fires on each fresh TLS handshake the agent opens.
 *
 * Implementation note: `HttpsAgent` accepts `createConnection` at runtime
 * (inherited from `http.Agent`) even though the public TS surface only
 * types it on the HTTP agent. We set it via an untyped cast to avoid a
 * `@ts-expect-error` directive that would hide future surface changes.
 */
export function createPinnedHttpsAgent(expectedFingerprint: string): HttpsAgent {
  const agent = new HttpsAgent();
  (agent as unknown as {
    createConnection: (opts: tls.ConnectionOptions) => tls.TLSSocket;
  }).createConnection = (opts: tls.ConnectionOptions): tls.TLSSocket => {
    const host = opts.host ?? "127.0.0.1";
    const port = typeof opts.port === "string" ? parseInt(opts.port, 10) : (opts.port ?? 443);
    return createPinnedTlsSocket({ host, port, expectedFingerprint });
  };
  return agent;
}
