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
import { app, session, type Session } from "electron";

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

// =============================================================================
// Electron session pinning install (audit finding #45)
// =============================================================================

/**
 * Install a pinned `setCertificateVerifyProc` on a single Electron session.
 *
 * For a request to succeed it must:
 *   1. resolve a hostname under `managedHost` (the host or any subdomain),
 *      AND
 *   2. present a leaf certificate whose SHA-256 fingerprint matches
 *      `expectedFingerprintUpper`.
 *
 * For requests to OTHER hostnames the verifier defers to Chromium's
 * default chain validation (callback `-3` is "use Chromium's result"), so
 * browser panels that load arbitrary external sites still work correctly
 * on the persisted browser partition.
 *
 * Note on the `-3` value: Electron's `setCertificateVerifyProc` callback
 * accepts:
 *    `0`  — trust the certificate
 *    `-2` — reject (untrusted)
 *    `-3` — use Chromium's default verification result
 * The previous implementation in `src/main/index.ts` used `-3` to REJECT
 * non-managed hosts, which silently broke browser panels in remote mode.
 * The behaviour here intentionally falls back to Chromium so unrelated
 * hosts are validated normally.
 */
export function installPinnedVerifyProcOnSession(
  targetSession: Session,
  managedHost: string,
  expectedFingerprintUpper: string,
): void {
  targetSession.setCertificateVerifyProc((request, callback) => {
    const sameManagedHost =
      request.hostname === managedHost ||
      request.hostname.endsWith(`.${managedHost}`);

    if (!sameManagedHost) {
      // Not the managed host: defer to Chromium's default chain check so
      // browser-panel sites in `persist:browser` still verify normally.
      callback(-3);
      return;
    }

    try {
      const actualFingerprint = pemFingerprint(request.certificate.data).toUpperCase();
      callback(actualFingerprint === expectedFingerprintUpper ? 0 : -2);
    } catch {
      callback(-2);
    }
  });
}

/**
 * Names of the Electron partitions that need the pinned verify proc in
 * remote mode (audit #45). The default session covers shell/panel webContents
 * that don't override partition; persisted browser/panel partitions are
 * created lazily and were previously uncovered.
 */
const PARTITION_PREFIXES_TO_PIN = ["persist:browser", "persist:panel:"];

function partitionShouldBePinned(partition: string | null): boolean {
  if (partition === null) return true;
  for (const p of PARTITION_PREFIXES_TO_PIN) {
    if (partition === p || partition.startsWith(p)) return true;
  }
  return false;
}

/**
 * Install the pinned verifier on:
 *   - the default session,
 *   - every existing `persist:browser` / `persist:panel:*` partition
 *     session, AND
 *   - every future session created by Electron (`session-created` event)
 *     that matches one of the pinned partitions.
 *
 * Idempotent: replacing a verifier on a session is harmless.
 *
 * Safe to call before `app.whenReady()` — schedules install on ready.
 *
 * Returns a disposer that removes the `session-created` hook (useful in
 * tests; in production the install lives for the app lifetime).
 *
 * TODO(security-audit-agent-3): the production call site lives in
 * `src/main/index.ts:installRemoteCertificateOverride`, which is OUT of
 * this agent's file scope. That function should be replaced with a single
 * call to `installPinnedTlsForAllPartitions(managedHost, fingerprint)`.
 * Until that change lands, only the default session is pinned (the legacy
 * behaviour); this helper is provided so the wiring change is a one-line
 * edit in index.ts.
 */
export function installPinnedTlsForAllPartitions(
  managedHost: string,
  expectedFingerprint: string,
): () => void {
  const upper = expectedFingerprint.toUpperCase();

  const installNow = (): void => {
    // Default session.
    installPinnedVerifyProcOnSession(session.defaultSession, managedHost, upper);
    // Pre-existing partitions: Electron does not expose an enumerator for
    // session-from-partition, but `persist:browser` / `persist:panel:*`
    // are accessed via `session.fromPartition`. We can warm the canonical
    // ones explicitly; lazily-created partitions get covered by the
    // `session-created` listener below.
    for (const p of ["persist:browser"]) {
      try {
        const s = session.fromPartition(p);
        installPinnedVerifyProcOnSession(s, managedHost, upper);
      } catch {
        // Partition not in use yet — `session-created` will cover it.
      }
    }
  };

  const onSessionCreated = (createdSession: Session): void => {
    // Electron does not give us the partition name on `session-created`;
    // we install on every session. The verify proc itself defers to
    // Chromium for non-managed hosts, so installing on every session is
    // safe (it only restricts the managed host).
    installPinnedVerifyProcOnSession(createdSession, managedHost, upper);
  };

  app.on("session-created", onSessionCreated);
  if (app.isReady()) {
    installNow();
  } else {
    void app.whenReady().then(installNow);
  }

  return () => {
    app.removeListener("session-created", onSessionCreated);
  };
}

// Re-export the partition predicate so other modules can decide whether a
// freshly-created partition should also receive the pin.
export { partitionShouldBePinned };
