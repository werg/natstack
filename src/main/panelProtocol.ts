import { protocol, session } from "electron";
import * as path from "path";
import type { ProtocolBuildArtifacts } from "../shared/ipc/types.js";
import { randomBytes } from "crypto";

type PanelAssets = NonNullable<ProtocolBuildArtifacts["assets"]>;

/** MIME types for serving panel assets */
const ASSET_MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Protocol-served panel content storage
 * Maps panelId -> { html, bundle, css }
 * This is the runtime serving cache for natstack-panel:// protocol
 */
const protocolPanels = new Map<
  string,
  {
    html: string;
    bundle: string;
    css?: string;
    assets?: PanelAssets;
  }
>();

/**
 * Per-panel access tokens for natstack-panel:// resources.
 * These prevent other webContents from fetching a panel's HTML/JS by guessing its panelId.
 *
 * Note: tokens are intentionally embedded into natstack-panel URLs as a query param,
 * so the panel can fetch its own resources. Tokens are high-entropy and per-panel.
 */
const protocolPanelTokens = new Map<string, string>();

/**
 * Track which partitions have had the protocol handler registered
 */
const registeredPartitions = new Set<string>();

/**
 * Track in-progress registrations to prevent race conditions
 */
const registrationLocks = new Map<string, Promise<void>>();

/**
 * Register the natstack-panel:// protocol for serving panel content
 * Must be called before app.ready
 */
export function registerPanelProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "natstack-panel",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: "natstack-child",
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
}

/**
 * Handle a protocol request for natstack-panel://
 * This is the shared handler logic used by all sessions.
 * Exported for use by ViewManager when registering protocol on partition sessions.
 */
export function handleProtocolRequest(request: Request): Response {
  const url = new URL(request.url);

  // The panelId is encoded in the URL. Since panelIds contain '/', we encode them as the path
  // URL format: natstack-panel://panel/{encodedPanelId}/resource
  const pathParts = url.pathname.split("/").filter(Boolean);
  const panelId = decodeURIComponent(pathParts[0] || "");
  const pathname = "/" + pathParts.slice(1).join("/") || "/";

  const panelContent = protocolPanels.get(panelId);
  if (!panelContent) {
    console.error(`[PanelProtocol] Panel not found: ${panelId}`);
    return new Response(`Panel not found: ${panelId}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const expectedToken = protocolPanelTokens.get(panelId);
  const providedToken = url.searchParams.get("token") ?? "";
  const isCorePath =
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/bundle.js" ||
    pathname === "/bundle.css";
  const hasValidToken = Boolean(expectedToken && providedToken === expectedToken);
  const hasValidRefererToken = !isCorePath && Boolean(expectedToken && isAuthorizedByReferer(request, expectedToken));

  if (!hasValidToken && !hasValidRefererToken) {
    return new Response("Unauthorized", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Route based on pathname
  if (pathname === "/" || pathname === "/index.html") {
    const htmlWithBundle = injectBundleIntoHtml(panelContent.html, panelId, expectedToken ?? "");
    return new Response(htmlWithBundle, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (pathname === "/bundle.js") {
    return new Response(panelContent.bundle, {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }

  if (pathname === "/bundle.css" && panelContent.css) {
    return new Response(panelContent.css, {
      status: 200,
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  }

  const assetContent = getAssetContent(panelContent.assets, pathname);
  if (assetContent) {
    return new Response(assetContent.content, {
      status: 200,
      headers: { "Content-Type": assetContent.contentType },
    });
  }

  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Set up the protocol handler for the default session
 * Must be called after app.ready
 */
export function setupPanelProtocol(): void {
  console.log("[PanelProtocol] Setting up protocol handler for default session");
  protocol.handle("natstack-panel", handleProtocolRequest);
  registeredPartitions.add("default");
}

/**
 * Register the protocol handler for a specific partition's session
 * This must be called for each webview partition that needs to load natstack-panel:// URLs
 *
 * Thread-safe: prevents race conditions when multiple panels try to register the same partition
 */
export async function registerProtocolForPartition(partition: string): Promise<void> {
  // Already registered - fast path
  if (registeredPartitions.has(partition)) {
    return;
  }

  // Check if registration is in progress
  const existingLock = registrationLocks.get(partition);
  if (existingLock) {
    await existingLock;
    // Double-check after awaiting lock (another caller may have completed registration)
    return;
  }

  // Create registration promise
  const registrationPromise = (async () => {
    try {
      // Double-check pattern: verify not registered after acquiring lock
      // This prevents race where multiple callers create locks before any complete
      if (registeredPartitions.has(partition)) {
        return;
      }

      console.log(`[PanelProtocol] Registering protocol for partition: ${partition}`);
      const ses = session.fromPartition(partition);
      ses.protocol.handle("natstack-panel", handleProtocolRequest);
      registeredPartitions.add(partition);
    } finally {
      // Clean up lock after registration completes
      registrationLocks.delete(partition);
    }
  })();

  // Set lock BEFORE awaiting to prevent other callers from starting duplicate registration
  registrationLocks.set(partition, registrationPromise);
  await registrationPromise;
}

/**
 * Inject bundle script into HTML
 * Replaces placeholder or appends before </body>
 */
function injectBundleIntoHtml(html: string, panelId: string, token: string): string {
  const encodedPanelId = encodeURIComponent(panelId);
  const encodedToken = encodeURIComponent(token);
  const bundleUrl = `natstack-panel://panel/${encodedPanelId}/bundle.js?token=${encodedToken}`;
  const cssUrl = `natstack-panel://panel/${encodedPanelId}/bundle.css?token=${encodedToken}`;
  const bundleScript = `<script type="module" src="${bundleUrl}"></script>`;

  let result = html;

  // Check if there's a placeholder script tag to replace
  if (result.includes("<!-- BUNDLE_PLACEHOLDER -->")) {
    result = result.replace("<!-- BUNDLE_PLACEHOLDER -->", bundleScript);
  } else if (result.includes('src="./bundle.js"')) {
    // Replace relative bundle reference
    result = result.replace(/src="\.\/bundle\.js"/g, `src="${bundleUrl}"`);
  } else if (!result.includes("bundle.js")) {
    // Append before </body> if no bundle reference exists
    result = result.replace("</body>", `${bundleScript}\n</body>`);
  }

  // Handle CSS similarly
  if (result.includes('href="./bundle.css"')) {
    result = result.replace(/href="\.\/bundle\.css"/g, `href="${cssUrl}"`);
  }

  return result;
}

function isAuthorizedByReferer(request: Request, expectedToken: string): boolean {
  const referer = request.headers.get("referer") ?? request.headers.get("referrer");
  if (!referer) return false;
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.protocol !== "natstack-panel:" && refererUrl.protocol !== "natstack-child:") {
      return false;
    }
    return refererUrl.searchParams.get("token") === expectedToken;
  } catch {
    return false;
  }
}

/**
 * Store panel content for protocol serving
 */
export function storeProtocolPanel(panelId: string, artifacts: ProtocolBuildArtifacts): string {
  protocolPanels.set(panelId, {
    html: artifacts.html,
    bundle: artifacts.bundle,
    css: artifacts.css,
    assets: artifacts.assets,
  });

  // Ensure a stable per-panel token exists.
  if (!protocolPanelTokens.has(panelId)) {
    protocolPanelTokens.set(panelId, randomBytes(32).toString("hex"));
  }

  const assetCount = artifacts.assets ? Object.keys(artifacts.assets).length : 0;
  const assetSuffix = assetCount > 0 ? ` (assets: ${assetCount})` : "";
  console.log(`[PanelProtocol] Stored panel: ${panelId}${assetSuffix}`);

  // Return the URL for this panel
  // Use the new format with encoded panelId to handle '/' in panel IDs
  const encodedPanelId = encodeURIComponent(panelId);
  const token = protocolPanelTokens.get(panelId)!;
  const encodedToken = encodeURIComponent(token);
  return `natstack-panel://panel/${encodedPanelId}/index.html?token=${encodedToken}`;
}

function getAssetContent(
  assets: PanelAssets | undefined,
  pathname: string
): { content: string | ArrayBuffer; contentType: string } | null {
  if (!assets) return null;
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const asset = assets[normalized] ?? assets[normalized.slice(1)];
  if (!asset) return null;

  const ext = path.extname(normalized).toLowerCase();
  const contentType = ASSET_MIME_TYPES[ext] ?? "application/octet-stream";

  const encoding = asset.encoding ?? "utf8";
  const content = encoding === "base64" ? decodeBase64ToArrayBuffer(asset.content) : asset.content;

  return { content, contentType };
}

function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Set (or rotate) the access token for a protocol-served panel.
 * The token must be included as `?token=...` in all natstack-panel:// requests.
 */
/**
 * Remove panel content from protocol serving
 */
export function removeProtocolPanel(panelId: string): void {
  protocolPanels.delete(panelId);
  protocolPanelTokens.delete(panelId);
}

/**
 * Check if a panel is served via protocol
 */
export function isProtocolPanel(panelId: string): boolean {
  return protocolPanels.has(panelId);
}

/**
 * Get the URL for a protocol-served panel
 */
export function getProtocolPanelUrl(panelId: string): string {
  const encodedPanelId = encodeURIComponent(panelId);
  const token = protocolPanelTokens.get(panelId);
  if (!token) {
    throw new Error(`Protocol panel token not found for ${panelId}`);
  }
  const encodedToken = encodeURIComponent(token);
  return `natstack-panel://panel/${encodedPanelId}/index.html?token=${encodedToken}`;
}
