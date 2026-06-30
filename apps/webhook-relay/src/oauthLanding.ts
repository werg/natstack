/**
 * NatStack callback relay — OAuth profile (dumb, ephemeral landing +
 * universal-link host). Plan §7.
 *
 * The relay is deliberately harmless here: PKCE keeps the `codeVerifier` on the
 * home server, so even on the desktop path where the relay sees the `code`, the
 * code is useless to the relay. `state` is the CSRF token — relayed VERBATIM,
 * never re-signed. Lookup is by the explicit `transactionId` carried through the
 * landing URL (NOT a state-scan).
 *
 * EXACTLY ONE path per platform, and each fails loud:
 *   - mobile  -> deep-link. The relay only HOSTS the Apple App Site Association
 *     / Android assetlinks (see build* below). When that works the OS hands the
 *     URL straight into the already-connected app, which forwards {state,code}
 *     over the WebRTC pipe — this landing HTML never runs. If we DO reach this
 *     handler for a mobile transaction the deep-link failed (app missing /
 *     association broken): we render an error and refuse to forward. We never
 *     fall back to the desktop backhaul — a silent second path is exactly what
 *     the fail-loud rule forbids.
 *   - desktop -> backhaul-forward. Push {state,code} down the owning server's
 *     persistent backhaul. If that backhaul is down, fail loud (the user
 *     retries); there is no buffering.
 */

export type OAuthPlatform = "mobile" | "desktop";

export interface OAuthRegistration {
  platform: OAuthPlatform;
  serverId: string;
  expiresAt: number;
}

export interface OAuthLandingDeps {
  /** Resolve a registered transaction (expiry-checked) by explicit id. */
  lookup: (transactionId: string) => OAuthRegistration | undefined;
  /** Single-use: drop the transaction after a desktop handoff. */
  consume: (transactionId: string) => void;
  /** Send a frame down the owning server's backhaul; false if none connected. */
  deliverToBackhaul: (serverId: string, frame: unknown) => boolean;
}

/**
 * The transactionId is carried in the path (`/oauth/callback/<transactionId>`,
 * which the App-Links / App-Site-Association `*` component matches so the OS
 * can deep-link), with `?transactionId=` accepted as a fallback for IdPs that
 * drop redirect-URI path segments.
 */
function parseTransactionId(url: URL): string | undefined {
  const prefix = "/oauth/callback/";
  if (url.pathname.startsWith(prefix)) {
    const segment = url.pathname.slice(prefix.length).split("/")[0];
    if (segment) return decodeURIComponent(segment);
  }
  return url.searchParams.get("transactionId") ?? undefined;
}

export function handleOAuthLanding(url: URL, now: number, deps: OAuthLandingDeps): Response {
  const transactionId = parseTransactionId(url);
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;

  if (!transactionId) {
    return htmlError(400, "Invalid callback", "This OAuth callback is missing its transaction id.");
  }

  const registration = deps.lookup(transactionId);
  if (!registration || now > registration.expiresAt) {
    // Unknown or expired transaction — fail loud (covers replayed / stale links).
    return htmlError(404, "Unknown sign-in", "This sign-in link is unknown or has expired. Start the connection again from NatStack.");
  }

  if (registration.platform === "mobile") {
    // Reaching the landing HTML means the OS deep-link did not fire. Refuse to
    // forward — the mobile path is the app forwarding over the pipe, not the
    // relay backhaul. (Fail loud, no silent second path.)
    return htmlError(
      200,
      "Open the NatStack app",
      "This sign-in should have opened the NatStack app automatically. Make sure the app is installed, then start the connection again.",
    );
  }

  // desktop: forward {state, code} verbatim down the owning server's backhaul.
  const delivered = deps.deliverToBackhaul(registration.serverId, {
    t: "oauth-callback",
    transactionId,
    state,
    code,
    error,
  });
  if (!delivered) {
    return htmlError(503, "Server offline", "Could not reach your NatStack server to finish signing in. Make sure it is running, then start the connection again.");
  }
  deps.consume(transactionId);
  return htmlPage(200, "Sign-in complete", "You can close this window and return to NatStack.");
}

// ---- Universal-link host (Apple App Site Association / Android assetlinks) ---

export interface UniversalLinkConfig {
  /** `<teamId>.<bundleId>` app IDs that may claim the relay's links. */
  appleAppIds: string[];
  androidPackageName?: string;
  /** Uppercase colon-separated SHA-256 signing-cert fingerprints. */
  androidFingerprints: string[];
}

export function universalLinkConfigFromEnv(env: {
  NATSTACK_APPLE_APP_ID?: string;
  NATSTACK_ANDROID_PACKAGE_NAME?: string;
  NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS?: string;
}): UniversalLinkConfig {
  return {
    appleAppIds: splitList(env.NATSTACK_APPLE_APP_ID),
    androidPackageName: env.NATSTACK_ANDROID_PACKAGE_NAME?.trim() || undefined,
    androidFingerprints: splitList(env.NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS).map((f) => f.toUpperCase()),
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Apple App Site Association. The `*` component lets the OS hand
 * `/oauth/callback/<transactionId>?code&state` straight into the app. Returns
 * null when no Apple app id is configured (the route fails loud rather than
 * serving a broken association that breaks universal links on every device).
 */
export function buildAppleAppSiteAssociation(config: UniversalLinkConfig): unknown | null {
  if (config.appleAppIds.length === 0) return null;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: config.appleAppIds,
          components: [{ "/": "/oauth/callback/*", comment: "OAuth provider callbacks" }],
        },
      ],
    },
    webcredentials: { apps: config.appleAppIds },
  };
}

/** Android App Links assetlinks. Returns null when unconfigured. */
export function buildAssetlinks(config: UniversalLinkConfig): unknown | null {
  if (!config.androidPackageName || config.androidFingerprints.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.androidPackageName,
        sha256_cert_fingerprints: config.androidFingerprints,
      },
    },
  ];
}

// ---- Minimal landing pages --------------------------------------------------

function htmlPage(status: number, title: string, body: string): Response {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${safeTitle}</h1><p>${safeBody}</p></body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

function htmlError(status: number, title: string, body: string): Response {
  return htmlPage(status, title, body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
