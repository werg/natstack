/**
 * Public URL provider — the externally-reachable base URL for this server.
 *
 * Resolution order:
 *   1. Explicit override passed to `configurePublicUrl()` (from
 *      `--public-url` / `NATSTACK_PUBLIC_URL`).
 *   2. Fallback derived from `${protocol}://${externalHost}:${gatewayPort}`.
 *
 * The server bootstrap calls `configurePublicUrl()` once the gateway port is
 * known; callers read via `getPublicUrl()` / `buildPublicUrl(pathname)`.
 *
 * Consumers: OAuth callback URL construction (Phase 2), webhook URL
 * advertisement, anything that needs a user-reachable link.
 */

interface PublicUrlState {
  /** Explicit override; wins if set. */
  override?: string;
  /** Fallback components. */
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
  publicBasePath: string;
}

let state: PublicUrlState | null = null;
let verified = false;

export interface ConfigurePublicUrlOptions {
  override?: string;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
  publicBasePath?: string;
}

export function configurePublicUrl(opts: ConfigurePublicUrlOptions): void {
  const override = normalizeOverride(opts.override);
  state = {
    override,
    protocol: opts.protocol,
    externalHost: opts.externalHost,
    gatewayPort: opts.gatewayPort,
    publicBasePath: normalizeBasePath(
      opts.publicBasePath ?? process.env["NATSTACK_PUBLIC_BASE_PATH"] ?? pathFromOverride(override)
    ),
  };
}

/** The base URL with no path component (no trailing slash). */
export function getPublicUrl(): string {
  if (!state) {
    throw new Error(
      "publicUrl not configured — call configurePublicUrl() after the gateway starts"
    );
  }
  if (state.override) return state.override;
  return `${state.protocol}://${state.externalHost}:${state.gatewayPort}`;
}

/**
 * Whether the public URL was supplied explicitly (via --public-url or
 * NATSTACK_PUBLIC_URL) rather than auto-derived from bind host + port.
 */
export function isPublicUrlExplicit(): boolean {
  return !!state?.override;
}

/**
 * Whether the public URL is known to actually be reachable. This is true
 * when the user supplied --public-url (they vouch for it) or when the auto-
 * detected URL passed a reachability check. False when auto-detection
 * proposed a URL but provisioning failed — e.g., tailscale serve isn't yet
 * configured.
 *
 * Used to gate "default OAuth redirect to public" — without this check,
 * desktop panels that worked fine on loopback would silently break when
 * detection ran but provisioning didn't.
 */
export function isPublicUrlVerified(): boolean {
  return verified;
}

export function markPublicUrlVerified(value: boolean): void {
  verified = value;
}

/** Build an absolute URL from a pathname (must start with "/"). */
export function buildPublicUrl(pathname: string): string {
  const base = getPublicUrl();
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return base + pathname;
}

export function getPublicBasePath(): string {
  if (state) return state.publicBasePath;
  return normalizeBasePath(process.env["NATSTACK_PUBLIC_BASE_PATH"]);
}

/** For tests. */
export function resetPublicUrl(): void {
  state = null;
  verified = false;
}

function normalizeOverride(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Strip trailing slash so concatenation with "/..." paths is clean.
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function pathFromOverride(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}
