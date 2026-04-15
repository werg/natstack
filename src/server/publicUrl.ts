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
}

let state: PublicUrlState | null = null;

export interface ConfigurePublicUrlOptions {
  override?: string;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
}

export function configurePublicUrl(opts: ConfigurePublicUrlOptions): void {
  state = {
    override: normalizeOverride(opts.override),
    protocol: opts.protocol,
    externalHost: opts.externalHost,
    gatewayPort: opts.gatewayPort,
  };
}

/** The base URL with no path component (no trailing slash). */
export function getPublicUrl(): string {
  if (!state) {
    throw new Error(
      "publicUrl not configured — call configurePublicUrl() after the gateway starts",
    );
  }
  if (state.override) return state.override;
  return `${state.protocol}://${state.externalHost}:${state.gatewayPort}`;
}

/** Build an absolute URL from a pathname (must start with "/"). */
export function buildPublicUrl(pathname: string): string {
  const base = getPublicUrl();
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return base + pathname;
}

/** For tests. */
export function resetPublicUrl(): void {
  state = null;
}

function normalizeOverride(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Strip trailing slash so concatenation with "/..." paths is clean.
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
