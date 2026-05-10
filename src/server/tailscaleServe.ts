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
  opts: EnsureHttpsServeOptions,
): Promise<ServeProvisionResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
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
        "tailscale serve already has a configuration that points somewhere "
        + "else; refusing to overwrite. Run `tailscale serve reset` if you "
        + "want natstack to manage it.",
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
export function verifyHttpsReachable(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  let healthUrl: string;
  try {
    const u = new URL(baseUrl);
    u.pathname = "/healthz";
    u.search = "";
    u.hash = "";
    healthUrl = u.toString();
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = httpsRequest(healthUrl, { method: "GET", timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          // Cap body to avoid runaway memory if the forwarder is hostile.
          if (body.length > 4096) {
            res.destroy();
            finish(false);
          }
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { ok?: unknown };
            finish(parsed.ok === true);
          } catch {
            finish(false);
          }
        });
        res.on("error", () => finish(false));
      });
      req.on("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.on("error", () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

// ── helpers ────────────────────────────────────────────────────────────

interface TailscaleServeStatus {
  Web?: Record<string, {
    Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }>;
  }>;
  // Older versions used `Services` instead of `Web`; accept either.
  Services?: Record<string, {
    Handlers?: Record<string, { Proxy?: string }>;
  }>;
}

export function classifyServeStatus(
  status: TailscaleServeStatus,
  opts: { port: number; hostname: string },
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
  const matchesPort = (proxy: string | undefined): boolean => {
    if (!proxy) return false;
    return proxy.includes(`127.0.0.1:${opts.port}`)
      || proxy.includes(`localhost:${opts.port}`)
      || proxy.includes(`[::1]:${opts.port}`);
  };
  if (handlers.some((h) => matchesPort(h.proxy))) return "matches";
  return "conflict";
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
  deadline: number,
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
  deadline: number,
): Promise<{ kind: "ok" } | { kind: "fail"; stderr: string; exitCode: number | null }> {
  const result = await runOnce(cli, ["serve", "--bg", String(port)], deadline);
  if (!result) return { kind: "fail", stderr: "(timed out)", exitCode: null };
  if (result.exitCode === 0) return { kind: "ok" };
  return { kind: "fail", stderr: result.stderr, exitCode: result.exitCode };
}

function classifyServeError(stderr: string, _exit: number | null): ServeProvisionResult {
  const lower = stderr.toLowerCase();
  if (lower.includes("must run as root") || lower.includes("operation not permitted")
    || lower.includes("permission denied")) {
    return {
      kind: "permission-denied",
      hint:
        "Run `sudo tailscale set --operator=$USER` once (lets you run "
        + "`tailscale serve` without sudo), then restart natstack. "
        + "Or run `sudo tailscale serve --bg <port>` once manually.",
    };
  }
  if (lower.includes("https") && (lower.includes("disabled") || lower.includes("not enabled"))) {
    return {
      kind: "https-feature-disabled",
      hint:
        "Enable the HTTPS Certificates feature for your tailnet at "
        + "https://login.tailscale.com/admin/dns and try again.",
    };
  }
  return { kind: "error", message: stderr.trim() || "tailscale serve failed" };
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
      child.kill();
      resolve(null);
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
