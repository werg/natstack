import { protocol, session } from "electron";
import * as path from "path";
import type { ProtocolBuildArtifacts } from "../shared/types.js";
import { randomBytes } from "crypto";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("PanelProtocol");

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
      scheme: "natstack-about",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    // New navigation protocols
    {
      scheme: "ns",
      privileges: {
        standard: true,
        secure: true,
      },
    },
    {
      scheme: "ns-about",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: "ns-focus",
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
    console.error(`[PanelProtocol] Panel not found: ${panelId}, requested path: ${pathname}`);
    console.error(`[PanelProtocol] Available panels: ${Array.from(protocolPanels.keys()).join(", ")}`);
    console.error(new Error("Panel not found stack trace").stack);
    return new Response(`Panel not found: ${panelId}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const expectedToken = protocolPanelTokens.get(panelId);
  const providedToken = url.searchParams.get("token") ?? "";
  // Core paths must have token in URL. Assets/chunks can use referer-based auth.
  const isCorePath =
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/bundle.js" ||
    pathname === "/bundle.css";
  const hasValidToken = Boolean(expectedToken && providedToken === expectedToken);
  // For non-core paths (assets, chunks), allow if referer is from the same panel.
  // This handles dynamic imports where the browser doesn't pass query params in referer.
  const hasValidReferer = !isCorePath && isAuthorizedByReferer(request, panelId);
  // For non-core assets: allow access if the panel exists and has this asset stored.
  // Electron may not send referer headers for custom protocol dynamic imports.
  // This is safe because: 1) core paths still require token, 2) we only serve stored content.
  const isStoredAsset = !isCorePath && panelContent.assets && (
    panelContent.assets[pathname] !== undefined ||
    panelContent.assets[pathname.slice(1)] !== undefined
  );

  if (!hasValidToken && !hasValidReferer && !isStoredAsset) {
    log.verbose(` 403 for ${request.url}: isCorePath=${isCorePath}, hasValidToken=${hasValidToken}, hasValidReferer=${hasValidReferer}, isStoredAsset=${isStoredAsset}`);
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

  // Log available assets for debugging 404s
  const availableAssets = panelContent.assets ? Object.keys(panelContent.assets).slice(0, 10) : [];
  log.verbose(` 404 for ${pathname}, available assets (first 10): ${availableAssets.join(", ")}`);

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

      log.verbose(` Registering protocol for partition: ${partition}`);
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
 * Inject bundle script into HTML and replace dynamic placeholders.
 * - Replaces bundle/CSS placeholder or appends before </body>
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

function isAuthorizedByReferer(request: Request, panelId: string): boolean {
  // Referer-based auth is a secondary mechanism. Electron often doesn't send
  // referer headers for custom protocol requests (especially dynamic imports),
  // so failures here are expected and handled by the stored asset fallback.
  const referer = request.headers.get("referer") ?? request.headers.get("referrer");
  if (!referer) {
    return false;
  }
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.protocol !== "natstack-panel:") {
      return false;
    }
    // Check that the referer is from the same panel (same panelId in the path)
    const refererPathParts = refererUrl.pathname.split("/").filter(Boolean);
    const refererPanelId = decodeURIComponent(refererPathParts[0] || "");
    return refererPanelId === panelId;
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
  const assetKeys = artifacts.assets ? Object.keys(artifacts.assets) : [];
  const monacoKeys = assetKeys.filter(k => k.includes("monaco"));
  const assetSuffix = assetCount > 0 ? ` (assets: ${assetCount}, monaco: ${monacoKeys.length})` : " (no assets)";
  log.verbose(` Stored panel: ${panelId}${assetSuffix}`);
  if (monacoKeys.length > 0) {
    log.verbose(` Monaco assets: ${monacoKeys.join(", ")}`);
  }

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
