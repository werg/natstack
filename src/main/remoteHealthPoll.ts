/**
 * remoteHealthPoll — periodic `/healthz` poll against a remote server.
 *
 * Runs in the Electron main process so the admin token stays in trusted
 * node-land (never in a URL / referer / devtools-inspectable renderer
 * request). Emits `server-health` events the badge tooltip renders.
 *
 * Local-mode (child-process server) doesn't need polling: the server is a
 * process we own, its lifecycle is managed by ServerProcessManager, and
 * detailed /healthz data isn't useful for a local indicator.
 */

import { request as httpRequest } from "http";
import { request as httpsRequest, Agent as HttpsAgent } from "https";
import * as fs from "fs";
import { createDevLogger } from "@natstack/dev-log";
import type { EventService } from "@natstack/shared/eventsService";
import { createPinnedHttpsAgent } from "./tlsPinning.js";

const log = createDevLogger("RemoteHealthPoll");

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 7_000;

export interface RemoteHealthPollOptions {
  /** Parsed URL pointing at the remote server base (`/healthz` is appended). */
  baseUrl: URL;
  /** Admin token, sent via `X-NatStack-Token` header (never in the URL). */
  adminToken: string;
  /** Optional TLS CA path to trust for self-signed servers. */
  caPath?: string;
  /** Optional pinned leaf-cert SHA-256 fingerprint (uppercase colon-hex).
   *  When set, the poll uses a `tls.connect` factory that destroys the
   *  socket on mismatch in `secureConnect` before any request bytes are
   *  written — mirroring the main RPC client's pinning in `serverClient.ts`.
   *  Without this, fingerprint-pinned setups with a self-signed cert would
   *  fail every poll under default Node TLS validation. */
  fingerprint?: string;
  /** Event emitter used to push samples to the renderer. */
  eventService: EventService;
  /** Poll interval in ms. Default 60_000. Pass a small value in tests. */
  intervalMs?: number;
}

export interface RemoteHealthPollHandle {
  stop(): void;
}

export function startRemoteHealthPoll(
  opts: RemoteHealthPollOptions,
): RemoteHealthPollHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Build the HTTPS agent once — it's reused across polls so connection
  // pooling works, and the fingerprint check runs per fresh TLS handshake.
  // Fingerprint pinning takes priority over CA path (the fingerprint IS the
  // trust anchor when it's set).
  const fingerprintAgent = opts.fingerprint
    ? createPinnedHttpsAgent(opts.fingerprint)
    : null;
  const caAgent = opts.caPath && !fingerprintAgent
    ? new HttpsAgent({ ca: fs.readFileSync(opts.caPath) })
    : null;

  function schedule(delay: number) {
    if (stopped) return;
    timer = setTimeout(runOnce, delay);
    // unref so the timer doesn't keep the event loop alive if the app quits
    // mid-cycle.
    timer.unref?.();
  }

  function emit(payload: Parameters<EventService["emit"]>[1] & { sampledAt: number }) {
    try {
      opts.eventService.emit("server-health", payload as never);
    } catch (err) {
      log.warn(`emit failed: ${(err as Error).message}`);
    }
  }

  async function runOnce() {
    timer = null;
    const sampledAt = Date.now();
    try {
      const body = await probe();
      emit({
        sampledAt,
        version: typeof body["version"] === "string" ? (body["version"] as string) : undefined,
        uptimeMs: typeof body["uptimeMs"] === "number" ? (body["uptimeMs"] as number) : undefined,
        workerd: typeof body["workerd"] === "string" ? (body["workerd"] as string) : undefined,
      });
    } catch (err) {
      emit({ sampledAt, error: (err as Error).message });
    }
    schedule(intervalMs);
  }

  async function probe(): Promise<Record<string, unknown>> {
    const isTls = opts.baseUrl.protocol === "https:";
    const port = parseInt(opts.baseUrl.port, 10) || (isTls ? 443 : 80);
    const req = (isTls ? httpsRequest : httpRequest)({
      method: "GET",
      host: opts.baseUrl.hostname,
      port,
      path: "/healthz",
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        // Header form keeps the admin token out of any URL / request log.
        "X-NatStack-Token": opts.adminToken,
      },
      ...(isTls && fingerprintAgent ? { agent: fingerprintAgent } : {}),
      ...(isTls && !fingerprintAgent && caAgent ? { agent: caAgent } : {}),
    });

    return new Promise((resolve, reject) => {
      req.once("error", reject);
      req.once("timeout", () => req.destroy(new Error("health poll timed out")));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) !== 200) {
            reject(new Error(`/healthz returned ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
          } catch (err) {
            reject(new Error(`/healthz body not JSON: ${(err as Error).message}`));
          }
        });
      });
      req.end();
    });
  }

  // Kick off the first poll immediately so the badge has data from the
  // first paint rather than waiting `intervalMs`.
  schedule(0);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
