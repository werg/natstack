import { app, dialog } from "electron";
import { z } from "zod";
import * as fs from "fs";
import * as tls from "tls";
import { request as httpsRequest, type RequestOptions } from "https";
import { request as httpRequest } from "http";
import { createHash } from "crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { StartupMode } from "../startupMode.js";
import {
  loadRemoteCredentials,
  saveRemoteCredentials,
  clearRemoteCredentials,
} from "../remoteCredentialStore.js";
import { createServerClient } from "../serverClient.js";

export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  url?: string;
  caPath?: string;
  fingerprint?: string;
  /** Redacted preview — the full token is never returned to the renderer. */
  tokenPreview?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  /** Error category for UI rendering. Undefined on success. */
  error?:
    | "invalid-url"
    | "unreachable"
    | "tls-mismatch"
    | "unauthorized"
    | "unknown";
  /** Human-readable error detail. */
  message?: string;
  /** Peer cert SHA-256 captured from the TLS handshake during the `/healthz`
   *  probe, iff (a) URL is wss/https, and (b) the server is reachable. Used
   *  for trust-on-first-use: the dialog displays this to the user for
   *  confirmation when no fingerprint has been saved yet. */
  observedFingerprint?: string;
  /** Server version from the `/healthz` body, when reachable. */
  serverVersion?: string;
}

const TEST_CONNECT_TIMEOUT_MS = 7_000;

/** Compute SHA-256 fingerprint of a DER cert buffer as uppercase colon hex. */
function sha256Fingerprint(der: Buffer): string {
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return hex.match(/.{2}/g)!.join(":");
}

/** TLS-connect to host:port and grab the peer leaf-cert fingerprint without
 *  CA validation. Used for "fetch fingerprint" UX and for trust-on-first-use
 *  inside `testConnection`. */
async function probePeerFingerprint(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$|:/.test(host);
    const sock = tls.connect({
      host,
      port,
      ...(isIpLiteral ? {} : { servername: host }),
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      timeout: TEST_CONNECT_TIMEOUT_MS,
    });
    const cleanup = () => { try { sock.destroy(); } catch { /* ignore */ } };
    sock.once("secureConnect", () => {
      const cert = sock.getPeerCertificate(false);
      if (!cert || !cert.raw) {
        cleanup();
        reject(new Error("Peer presented no certificate"));
        return;
      }
      const fp = sha256Fingerprint(cert.raw);
      cleanup();
      resolve(fp);
    });
    sock.once("error", (err) => { cleanup(); reject(err); });
    sock.once("timeout", () => { cleanup(); reject(new Error("TLS probe timed out")); });
  });
}

/** Issue a `GET /healthz` with the requested TLS options. Returns status,
 *  body (when available), and the peer fingerprint (when TLS). */
async function healthProbe(
  parsed: URL,
  tlsOpts: { caPath?: string; fingerprint?: string; allowUnpinned: boolean },
): Promise<{ status: number; body: string; fingerprint?: string }> {
  const isTls = parsed.protocol === "https:";
  const port = parseInt(parsed.port, 10) || (isTls ? 443 : 80);
  const opts: RequestOptions = {
    method: "GET",
    host: parsed.hostname,
    port,
    path: "/healthz",
    timeout: TEST_CONNECT_TIMEOUT_MS,
  };

  let fingerprint: string | undefined;

  if (isTls) {
    if (tlsOpts.caPath) {
      (opts as RequestOptions & { ca?: Buffer }).ca = fs.readFileSync(tlsOpts.caPath);
    } else if (tlsOpts.allowUnpinned) {
      // Trust-on-first-use probe: no fingerprint known yet, so we bypass CA
      // verification to get to `secureConnect` and grab the cert hash. The
      // body is only consumed if the user subsequently confirms the hash.
      (opts as RequestOptions & { rejectUnauthorized?: boolean }).rejectUnauthorized = false;
      (opts as RequestOptions & { checkServerIdentity?: () => undefined }).checkServerIdentity =
        () => undefined;
    }
  }

  return new Promise((resolve, reject) => {
    const req = (isTls ? httpsRequest : httpRequest)(opts, (res) => {
      // Capture cert on TLS sockets BEFORE body is consumed.
      if (isTls) {
        const sock = res.socket as tls.TLSSocket;
        const cert = sock.getPeerCertificate?.(false);
        if (cert && cert.raw) fingerprint = sha256Fingerprint(cert.raw);
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          fingerprint,
        });
      });
    });
    req.once("error", reject);
    req.once("timeout", () => { req.destroy(new Error("health probe timed out")); });
    req.end();
  });
}

export function createRemoteCredService(deps: { startupMode: StartupMode }): ServiceDefinition {
  return {
    name: "remoteCred",
    description: "Manage the Electron-side remote-server credential store",
    policy: { allowed: ["shell"] },
    methods: {
      getCurrent: { args: z.tuple([]) },
      save: {
        args: z.tuple([
          z.object({
            url: z.string(),
            token: z.string(),
            caPath: z.string().optional(),
            fingerprint: z.string().optional(),
          }),
        ]),
      },
      testConnection: {
        args: z.tuple([
          z.object({
            url: z.string(),
            token: z.string(),
            caPath: z.string().optional(),
            fingerprint: z.string().optional(),
          }),
        ]),
      },
      fetchPeerFingerprint: { args: z.tuple([z.string()]) },
      /** Native file-pick dialog for selecting a CA certificate PEM. */
      pickCaFile: { args: z.tuple([]) },
      clear: { args: z.tuple([]) },
      relaunch: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "getCurrent": {
          const creds = loadRemoteCredentials();
          if (!creds) {
            return {
              configured: false,
              isActive: deps.startupMode.kind === "remote",
            } satisfies RemoteCredCurrent;
          }
          return {
            configured: true,
            isActive: deps.startupMode.kind === "remote",
            url: creds.url,
            caPath: creds.caPath,
            fingerprint: creds.fingerprint,
            tokenPreview: creds.token.slice(0, 4) + "…" + creds.token.slice(-4),
          } satisfies RemoteCredCurrent;
        }
        case "save": {
          const payload = args[0] as {
            url: string;
            token: string;
            caPath?: string;
            fingerprint?: string;
          };
          let parsed: URL;
          try {
            parsed = new URL(payload.url);
          } catch (err) {
            throw new Error(`Invalid URL: ${(err as Error).message}`);
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("URL must be http(s)");
          }
          saveRemoteCredentials({
            url: payload.url,
            token: payload.token,
            caPath: payload.caPath,
            fingerprint: payload.fingerprint,
          });
          return { ok: true };
        }
        case "testConnection": {
          const payload = args[0] as {
            url: string; token: string;
            caPath?: string; fingerprint?: string;
          };
          let parsed: URL;
          try { parsed = new URL(payload.url); }
          catch (err) {
            return {
              ok: false, error: "invalid-url",
              message: (err as Error).message,
            } satisfies TestConnectionResult;
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
              ok: false, error: "invalid-url",
              message: "URL must be http(s)",
            } satisfies TestConnectionResult;
          }
          const isTls = parsed.protocol === "https:";

          // Step A — /healthz. Distinguishes "unreachable" / "tls-mismatch"
          // / "reachable" cleanly. When no fingerprint is set, we still
          // capture the peer fingerprint for trust-on-first-use.
          let probe: Awaited<ReturnType<typeof healthProbe>>;
          try {
            probe = await healthProbe(parsed, {
              caPath: payload.caPath,
              fingerprint: payload.fingerprint,
              allowUnpinned: !payload.fingerprint,
            });
          } catch (err) {
            const msg = (err as Error).message ?? "unreachable";
            // Heuristic: if the error mentions cert / TLS, it's TLS not net.
            const isCert = /certificate|TLS|unable to verify|self[- ]signed/i.test(msg);
            return {
              ok: false,
              error: isCert ? "tls-mismatch" : "unreachable",
              message: msg,
            } satisfies TestConnectionResult;
          }

          // If a fingerprint was provided, enforce it against the observed
          // one — even if /healthz returned 200 (no pinning was done on the
          // probe because we didn't pass the user's pin through).
          if (isTls && payload.fingerprint && probe.fingerprint && probe.fingerprint !== payload.fingerprint) {
            return {
              ok: false, error: "tls-mismatch",
              message: `Fingerprint mismatch: expected ${payload.fingerprint}, got ${probe.fingerprint}`,
              observedFingerprint: probe.fingerprint,
            } satisfies TestConnectionResult;
          }

          // If the probe succeeded but we don't have a stored fingerprint,
          // surface the observed one so the UI can ask the user to trust it.
          if (isTls && !payload.fingerprint && probe.fingerprint) {
            return {
              ok: false, error: "tls-mismatch",
              message: "No fingerprint configured — confirm the one returned in observedFingerprint before saving.",
              observedFingerprint: probe.fingerprint,
            } satisfies TestConnectionResult;
          }

          if (probe.status !== 200) {
            return {
              ok: false, error: "unreachable",
              message: `/healthz returned ${probe.status}`,
            } satisfies TestConnectionResult;
          }

          // Step B — throwaway auth attempt. The real test: do our URL +
          // token actually authenticate, not just "is there an HTTP server
          // there".
          const wsProto = isTls ? "wss" : "ws";
          const rpcPort = parseInt(parsed.port, 10) || (isTls ? 443 : 80);
          const wsUrl = `${wsProto}://${parsed.hostname}:${rpcPort}/rpc`;
          let client: Awaited<ReturnType<typeof createServerClient>> | null = null;
          try {
            client = await createServerClient(rpcPort, payload.token, {
              wsUrl,
              tls: {
                caPath: payload.caPath,
                fingerprint: payload.fingerprint ?? probe.fingerprint,
              },
              reconnect: false,
            });
          } catch (err) {
            const msg = (err as Error).message ?? "auth failed";
            const isAuth = /auth|unauthorized|401|token/i.test(msg);
            return {
              ok: false,
              error: isAuth ? "unauthorized" : "unknown",
              message: msg,
              observedFingerprint: probe.fingerprint,
            } satisfies TestConnectionResult;
          } finally {
            try { await client?.close(); } catch { /* ignore */ }
          }

          // Extract server version from /healthz body when present.
          let serverVersion: string | undefined;
          try {
            const parsedBody = JSON.parse(probe.body) as { version?: unknown };
            if (typeof parsedBody.version === "string") serverVersion = parsedBody.version;
          } catch { /* body not JSON — fine */ }

          return {
            ok: true,
            observedFingerprint: probe.fingerprint,
            serverVersion,
          } satisfies TestConnectionResult;
        }
        case "fetchPeerFingerprint": {
          const urlStr = args[0] as string;
          let parsed: URL;
          try { parsed = new URL(urlStr); }
          catch (err) { throw new Error(`Invalid URL: ${(err as Error).message}`); }
          if (parsed.protocol !== "https:") {
            throw new Error("fetchPeerFingerprint requires an https:// URL");
          }
          const port = parseInt(parsed.port, 10) || 443;
          return await probePeerFingerprint(parsed.hostname, port);
        }
        case "pickCaFile": {
          const result = await dialog.showOpenDialog({
            properties: ["openFile"],
            title: "Select CA certificate",
            filters: [
              { name: "PEM certificate", extensions: ["pem", "crt", "cer"] },
              { name: "All files", extensions: ["*"] },
            ],
          });
          return result.canceled ? null : result.filePaths[0] ?? null;
        }
        case "clear":
          clearRemoteCredentials();
          return { ok: true };
        case "relaunch":
          app.relaunch();
          app.exit(0);
          return { ok: true };
        default:
          throw new Error(`Unknown remoteCred method: ${method}`);
      }
    },
  };
}
