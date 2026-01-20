/**
 * Protocol handler for natstack-about:// URLs.
 *
 * Serves shell pages (model-provider-config, about, keyboard-shortcuts, help) as panel content.
 * These pages have full shell-level access to services.
 */

import { protocol, session } from "electron";
import * as path from "path";
import { randomBytes } from "crypto";
import type { ProtocolBuildArtifacts, ShellPage } from "../shared/ipc/types.js";

/** MIME types for serving assets */
const ASSET_MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type AboutAssets = NonNullable<ProtocolBuildArtifacts["assets"]>;

/**
 * Protocol-served about page content storage.
 * Maps page name -> { html, bundle, css, assets }
 */
const aboutPages = new Map<
  string,
  {
    html: string;
    bundle: string;
    css?: string;
    assets?: AboutAssets;
  }
>();

/**
 * Per-page access tokens for natstack-about:// resources.
 */
const aboutPageTokens = new Map<string, string>();

/**
 * Track which partitions have had the about protocol handler registered.
 */
const registeredPartitions = new Set<string>();

/**
 * Track in-progress registrations to prevent race conditions.
 */
const registrationLocks = new Map<string, Promise<void>>();

/**
 * Valid shell page names.
 */
const VALID_SHELL_PAGES: ShellPage[] = ["model-provider-config", "about", "keyboard-shortcuts", "help", "new"];

/**
 * Check if a string is a valid shell page.
 */
export function isValidShellPage(page: string): page is ShellPage {
  return VALID_SHELL_PAGES.includes(page as ShellPage);
}

/**
 * Handle a protocol request for natstack-about://
 */
export function handleAboutProtocolRequest(request: Request): Response {
  const url = new URL(request.url);

  // URL format: natstack-about://page/resource?token=xxx
  // hostname is the page name (e.g., "model-provider-config", "about")
  const page = url.hostname;
  const pathname = url.pathname || "/";

  if (!isValidShellPage(page)) {
    console.error(`[AboutProtocol] Invalid page: ${page}`);
    return new Response(`Invalid about page: ${page}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const pageContent = aboutPages.get(page);
  if (!pageContent) {
    console.error(`[AboutProtocol] Page not built: ${page}`);
    return new Response(`About page not found: ${page}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate token
  const expectedToken = aboutPageTokens.get(page);
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
    const htmlWithBundle = injectBundleIntoHtml(pageContent.html, page, expectedToken ?? "");
    return new Response(htmlWithBundle, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (pathname === "/bundle.js") {
    return new Response(pageContent.bundle, {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }

  if (pathname === "/bundle.css" && pageContent.css) {
    return new Response(pageContent.css, {
      status: 200,
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  }

  // Check for asset
  const assetContent = getAssetContent(pageContent.assets, pathname);
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
 * Inject bundle script into HTML.
 */
function injectBundleIntoHtml(html: string, page: string, token: string): string {
  const encodedToken = encodeURIComponent(token);
  const bundleUrl = `natstack-about://${page}/bundle.js?token=${encodedToken}`;
  const cssUrl = `natstack-about://${page}/bundle.css?token=${encodedToken}`;
  const bundleScript = `<script src="${bundleUrl}"></script>`;

  let result = html;

  // Check if there's a placeholder script tag to replace
  if (result.includes("<!-- BUNDLE_PLACEHOLDER -->")) {
    result = result.replace("<!-- BUNDLE_PLACEHOLDER -->", bundleScript);
  } else if (result.includes('src="./bundle.js"')) {
    result = result.replace(/src="\.\/bundle\.js"/g, `src="${bundleUrl}"`);
  } else if (!result.includes("bundle.js")) {
    result = result.replace("</body>", `${bundleScript}\n</body>`);
  }

  // Handle CSS similarly
  if (result.includes('href="./bundle.css"')) {
    result = result.replace(/href="\.\/bundle\.css"/g, `href="${cssUrl}"`);
  }

  return result;
}

/**
 * Check if request is authorized by referer.
 */
function isAuthorizedByReferer(request: Request, expectedToken: string): boolean {
  const referer = request.headers.get("referer") ?? request.headers.get("referrer");
  if (!referer) return false;
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.protocol !== "natstack-about:") {
      return false;
    }
    return refererUrl.searchParams.get("token") === expectedToken;
  } catch {
    return false;
  }
}

/**
 * Get asset content by pathname.
 */
function getAssetContent(
  assets: AboutAssets | undefined,
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

/**
 * Decode base64 to ArrayBuffer.
 */
function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Set up the about protocol handler for the default session.
 * Must be called after app.ready.
 */
export function setupAboutProtocol(): void {
  console.log("[AboutProtocol] Setting up protocol handler for default session");
  protocol.handle("natstack-about", handleAboutProtocolRequest);
  registeredPartitions.add("default");
}

/**
 * Register the about protocol handler for a specific partition's session.
 */
export async function registerAboutProtocolForPartition(partition: string): Promise<void> {
  if (registeredPartitions.has(partition)) {
    return;
  }

  const existingLock = registrationLocks.get(partition);
  if (existingLock) {
    await existingLock;
    return;
  }

  const registrationPromise = (async () => {
    try {
      if (registeredPartitions.has(partition)) {
        return;
      }

      console.log(`[AboutProtocol] Registering protocol for partition: ${partition}`);
      const ses = session.fromPartition(partition);
      ses.protocol.handle("natstack-about", handleAboutProtocolRequest);
      registeredPartitions.add(partition);
    } finally {
      registrationLocks.delete(partition);
    }
  })();

  registrationLocks.set(partition, registrationPromise);
  await registrationPromise;
}

/**
 * Store about page content for protocol serving.
 * Returns the URL for the page.
 */
export function storeAboutPage(page: ShellPage, artifacts: ProtocolBuildArtifacts): string {
  aboutPages.set(page, {
    html: artifacts.html,
    bundle: artifacts.bundle,
    css: artifacts.css,
    assets: artifacts.assets,
  });

  // Ensure a stable per-page token exists
  if (!aboutPageTokens.has(page)) {
    aboutPageTokens.set(page, randomBytes(32).toString("hex"));
  }

  console.log(`[AboutProtocol] Stored about page: ${page}`);

  // Return the URL for this page
  const token = aboutPageTokens.get(page)!;
  const encodedToken = encodeURIComponent(token);
  return `natstack-about://${page}/index.html?token=${encodedToken}`;
}

/**
 * Check if an about page is stored.
 */
export function hasAboutPage(page: ShellPage): boolean {
  return aboutPages.has(page);
}

/**
 * Get the URL for an about page.
 */
export function getAboutPageUrl(page: ShellPage): string {
  const token = aboutPageTokens.get(page);
  if (!token) {
    throw new Error(`About page token not found for ${page}`);
  }
  const encodedToken = encodeURIComponent(token);
  return `natstack-about://${page}/index.html?token=${encodedToken}`;
}
