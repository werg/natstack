/**
 * Auto-configure `tailscale serve` so the MagicDNS hostname forwards HTTPS
 * traffic to the local gateway.
 *
 * Tailscale issues real Let's Encrypt certs for `*.ts.net` MagicDNS names.
 * When the operator has the HTTPS feature enabled in their tailnet admin
 * console, `tailscale serve --bg <port>` is a one-shot command that makes
 * `https://<host>.<tailnet>.ts.net` route to `http://127.0.0.1:<port>` —
 * persistently, surviving reboots. That gives us one URL that works for QR
 * pairing, panel chrome, OAuth callbacks, and webhooks.
 *
 * This module:
 *   1. Inspects current serve config to decide if we already have a working
 *      forwarder.
 *   2. Sets one up if absent.
 *   3. Refuses to overwrite a non-empty config that points elsewhere — we
 *      don't want to clobber a user's existing static site or service.
 */

import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export type ServeProvisionResult =
  | { kind: "already-configured"; cli: string }
  | { kind: "configured"; cli: string }
  | { kind: "skipped-conflict"; reason: string }
  | { kind: "permission-denied"; hint: string }
  | { kind: "https-feature-disabled"; hint: string }
  /** The Serve feature itself isn't enabled on the tailnet — the daemon
   *  prints an activation URL that takes the operator straight to the
   *  one-click enable page; we surface it verbatim in `hint`. */
  | { kind: "serve-feature-disabled"; hint: string; activationUrl?: string }
  | { kind: "tailscale-unavailable" }
  | { kind: "error"; message: string };

export interface EnsureHttpsServeOptions {
  /** Local gateway port to forward to. */
  port: number;
  /** MagicDNS hostname expected to terminate TLS (e.g., host.tailnet.ts.net). */
  hostname: string;
  /** Total budget for the entire ensure operation. */
  timeoutMs?: number;
}

/**
 * Make `https://<hostname>` forward to `http://127.0.0.1:<port>` via
 * `tailscale serve`. Idempotent on success.
 */
export async function ensureHttpsServe(
  opts: EnsureHttpsServeOptions
): Promise<ServeProvisionResult> {
  // Tailscale CLI calls can be slow when LocalAPI rountrips through the
  // daemon to query account state. The "Serve is not enabled" response in
  // particular has been observed at 6–8 s; a 4 s budget was hitting the
  // timeout branch and surfacing as a generic error instead of the
  // actionable "enable Serve at <link>" hint the daemon prints. 12 s gives
  // every code path room while still bounding the readiness banner.
  const timeoutMs = opts.timeoutMs ?? 12000;
  const deadline = Date.now() + timeoutMs;

  const cli = await locateTailscale(deadline);
  if (!cli) return { kind: "tailscale-unavailable" };

  const status = await runServeStatusJson(cli, deadline);
  if (status === null) {
    // Status command failed; bail rather than pile on with `serve add`.
    return { kind: "tailscale-unavailable" };
  }

  const existing = classifyServeStatus(status, opts);
  if (existing === "matches") return { kind: "already-configured", cli };
  if (existing === "conflict") {
    return {
      kind: "skipped-conflict",
      reason:
        "tailscale serve already has a configuration that points somewhere " +
        "else; refusing to overwrite. Run `tailscale serve reset` if you " +
        "want natstack to manage it.",
    };
  }

  // existing === "empty" → safe to install.
  const serveResult = await runServeAdd(cli, opts.port, deadline);
  if (serveResult.kind === "ok") {
    return { kind: "configured", cli };
  }
  return classifyServeError(serveResult.stderr, serveResult.exitCode);
}

/**
 * Verify that an HTTPS URL is forwarding to *our* gateway (and not, say, a
 * stale tailscale serve config left over from a previous natstack run that
 * pointed at a different port).
 *
 * Hits `/healthz` — a public-auth route the gateway always serves — and
 * checks for the `{ ok: true }` marker. Reaching any other server (or a
 * dangling tailscaled forwarder returning 502) counts as "not reachable".
 */
export interface HttpsReachabilityResult {
  ok: boolean;
  reason?: string;
}

export function probeHttpsReachable(
  baseUrl: string,
  timeoutMs = 2500
): Promise<HttpsReachabilityResult> {
  let healthUrl: string;
  try {
    const u = new URL(baseUrl);
    u.pathname = "/healthz";
    u.search = "";
    u.hash = "";
    healthUrl = u.toString();
  } catch {
    return Promise.resolve({ ok: false, reason: "URL is not valid" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const finish = (result: HttpsReachabilityResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const req = httpsRequest(healthUrl, { method: "GET", timeout: timeoutMs }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          // Cap body to avoid runaway memory if the forwarder is hostile.
          if (body.length > 4096) {
            res.destroy();
            finish({ ok: false, reason: "health check response was too large" });
          }
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const summary = body.trim().replace(/\s+/g, " ").slice(0, 160);
            finish({
              ok: false,
              reason: `/healthz returned HTTP ${res.statusCode}${summary ? `: ${summary}` : ""}`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(body) as { ok?: unknown };
            finish(
              parsed.ok === true
                ? { ok: true }
                : { ok: false, reason: '/healthz did not return {"ok":true}' }
            );
          } catch {
            finish({ ok: false, reason: "/healthz body was not JSON" });
          }
        });
        res.on("error", (error: Error) => finish({ ok: false, reason: error.message }));
      });
      req.on("timeout", () => {
        req.destroy(new Error(`health check timed out after ${timeoutMs}ms`));
        finish({ ok: false, reason: `health check timed out after ${timeoutMs}ms` });
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          reason: error.code ? `${error.code}: ${error.message}` : error.message,
        });
      });
      req.end();
    } catch {
      finish({ ok: false, reason: "health check request could not be started" });
    }
  });
}

export function verifyHttpsReachable(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  return probeHttpsReachable(baseUrl, timeoutMs).then((result) => result.ok);
}

// ── helpers ────────────────────────────────────────────────────────────

export interface TailscaleServeStatus {
  Web?: Record<
    string,
    {
      Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }>;
    }
  >;
  // Older versions used `Services` instead of `Web`; accept either.
  Services?: Record<
    string,
    {
      Handlers?: Record<string, { Proxy?: string }>;
    }
  >;
}

export interface DetectedTailscaleServeUrl {
  hostname: string;
  url: string;
}

export async function detectHttpsServePublicUrl(opts: {
  port: number;
  timeoutMs?: number;
}): Promise<DetectedTailscaleServeUrl | null> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const deadline = Date.now() + timeoutMs;
  const cli = await locateTailscale(deadline);
  if (!cli) return null;
  const status = await runServeStatusJson(cli, deadline);
  if (!status) return null;
  return inferHttpsServePublicUrl(status, opts);
}

export function inferHttpsServePublicUrl(
  status: TailscaleServeStatus,
  opts: { port: number }
): DetectedTailscaleServeUrl | null {
  for (const section of [status.Web, status.Services]) {
    if (!section) continue;
    for (const [hostPort, value] of Object.entries(section)) {
      const hostname = parseHttpsServeHostname(hostPort);
      if (!hostname) continue;
      for (const handler of Object.values(value.Handlers ?? {})) {
        if (matchesLocalGatewayPort(handler.Proxy, opts.port)) {
          return { hostname, url: `https://${hostname}` };
        }
      }
    }
  }
  return null;
}

export function classifyServeStatus(
  status: TailscaleServeStatus,
  opts: { port: number; hostname: string }
): "empty" | "matches" | "conflict" {
  const handlers: { proxy: string | undefined }[] = [];
  for (const section of [status.Web, status.Services]) {
    if (!section) continue;
    for (const value of Object.values(section)) {
      for (const handler of Object.values(value.Handlers ?? {})) {
        handlers.push({ proxy: handler.Proxy });
      }
    }
  }
  if (handlers.length === 0) return "empty";
  if (handlers.some((h) => matchesLocalGatewayPort(h.proxy, opts.port))) return "matches";
  return "conflict";
}

function matchesLocalGatewayPort(proxy: string | undefined, port: number): boolean {
  if (!proxy) return false;
  try {
    const url = new URL(proxy);
    const host = url.hostname.toLowerCase();
    return (
      Number(url.port) === port &&
      (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1")
    );
  } catch {
    return false;
  }
}

function parseHttpsServeHostname(hostPort: string): string | null {
  const withoutScheme = hostPort.replace(/^https:\/\//, "");
  const hostname = withoutScheme.endsWith(":443")
    ? withoutScheme.slice(0, -":443".length)
    : withoutScheme;
  if (!hostname || hostname.includes("/") || hostname.includes(":")) return null;
  return hostname.replace(/\.$/, "");
}

async function locateTailscale(deadline: number): Promise<string | null> {
  for (const cmd of TAILSCALE_CANDIDATES) {
    if (Date.now() >= deadline) return null;
    const ok = await runOnce(cmd, ["version"], deadline);
    if (ok && ok.exitCode === 0) return cmd;
  }
  return null;
}

async function runServeStatusJson(
  cli: string,
  deadline: number
): Promise<TailscaleServeStatus | null> {
  const result = await runOnce(cli, ["serve", "status", "--json"], deadline);
  if (!result || result.exitCode !== 0) return null;
  try {
    return JSON.parse(result.stdout) as TailscaleServeStatus;
  } catch {
    return null;
  }
}

async function runServeAdd(
  cli: string,
  port: number,
  deadline: number
): Promise<{ kind: "ok" } | { kind: "fail"; stderr: string; exitCode: number | null }> {
  const result = await runOnce(cli, ["serve", "--bg", String(port)], deadline);
  if (!result) return { kind: "fail", stderr: "(timed out)", exitCode: null };
  if (result.exitCode === 0) return { kind: "ok" };
  // On timeout the CLI may have emitted a useful diagnostic before hanging —
  // the "Serve is not enabled" message is the canonical example, observed in
  // the wild keeping the CLI alive for 30+ seconds after the daemon already
  // responded. Tailscale routes that particular message to **stdout** (not
  // stderr, despite being an error). Combine both streams so the classifier
  // can match regardless of which side the CLI chose.
  const combined = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\n");
  const stderr = combined.length > 0 ? combined : "(timed out)";
  return { kind: "fail", stderr, exitCode: result.exitCode };
}

export function classifyServeError(stderr: string, _exit: number | null): ServeProvisionResult {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("must run as root") ||
    lower.includes("operation not permitted") ||
    lower.includes("permission denied")
  ) {
    return {
      kind: "permission-denied",
      hint:
        "Run `sudo tailscale set --operator=$USER` once (lets you run " +
        "`tailscale serve` without sudo), then restart natstack. " +
        "Or run `sudo tailscale serve --bg <port>` once manually.",
    };
  }
  // "Serve is not enabled on your tailnet. To enable, visit: <url>" — the
  // daemon emits this when the Serve feature itself isn't activated. The
  // activation URL is per-tailnet/per-node, so we extract it from stderr
  // rather than hardcoding a generic admin link.
  if (lower.includes("serve is not enabled")) {
    const activationUrl = extractFirstHttpsUrl(stderr);
    const hint = activationUrl
      ? `Tailscale Serve isn't enabled on your tailnet. Open ${activationUrl} to enable it (one click), then restart natstack.`
      : "Tailscale Serve isn't enabled on your tailnet. Enable it from the Tailscale admin console, then restart natstack.";
    return { kind: "serve-feature-disabled", hint, activationUrl };
  }
  if (lower.includes("https") && (lower.includes("disabled") || lower.includes("not enabled"))) {
    return {
      kind: "https-feature-disabled",
      hint:
        "Enable the HTTPS Certificates feature for your tailnet at " +
        "https://login.tailscale.com/admin/dns and try again.",
    };
  }
  return { kind: "error", message: stderr.trim() || "tailscale serve failed" };
}

function extractFirstHttpsUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/\S+/);
  return match ? match[0].replace(/[.,)\]]+$/, "") : undefined;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runOnce(cmd: string, args: string[], deadline: number): Promise<SpawnResult | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(null);
  return new Promise<SpawnResult | null>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Capture whatever the child has streamed so far. The Tailscale CLI is
      // known to print "Serve is not enabled" to stderr and then hang
      // indefinitely; treating that case as "no output" loses the actionable
      // hint the user needs. SIGKILL because plain `kill` (SIGTERM) leaves
      // the hung CLI alive — observed leaving zombie `tailscale serve`
      // processes around. exitCode=null marks the result as timed-out.
      child.kill("SIGKILL");
      resolve({ exitCode: null, stdout, stderr });
    }, remaining);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
