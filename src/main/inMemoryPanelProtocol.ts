import { protocol, session } from "electron";
import type { InMemoryBuildArtifacts } from "../shared/ipc/types.js";

/**
 * In-memory panel content storage
 * Maps panelId -> { html, bundle, css }
 */
const inMemoryPanels = new Map<
  string,
  {
    html: string;
    bundle: string;
    css?: string;
  }
>();

/**
 * Track which partitions have had the protocol handler registered
 */
const registeredPartitions = new Set<string>();

/**
 * Track in-progress registrations to prevent race conditions
 */
const registrationLocks = new Map<string, Promise<void>>();

/**
 * Register the natstack-panel:// protocol for serving in-memory panel content
 * Must be called before app.ready
 */
export function registerInMemoryPanelProtocol(): void {
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
  ]);
}

/**
 * Handle a protocol request for natstack-panel://
 * This is the shared handler logic used by all sessions
 */
function handleProtocolRequest(request: Request): Response {
  console.log(`[InMemoryPanel] Protocol handler invoked for: ${request.url.slice(0, 100)}`);
  const url = new URL(request.url);

  // The panelId is encoded in the URL. Since panelIds contain '/', we encode them as the path
  // URL format: natstack-panel://panel/{encodedPanelId}/resource
  // Or legacy: natstack-panel://{simplePanelId}/resource (if no '/' in panelId)
  let panelId: string;
  let pathname: string;

  if (url.hostname === "panel") {
    // New format: natstack-panel://panel/{encodedPanelId}/resource
    const pathParts = url.pathname.split("/").filter(Boolean);
    panelId = decodeURIComponent(pathParts[0] || "");
    pathname = "/" + pathParts.slice(1).join("/") || "/";
  } else {
    // Legacy format for simple panel IDs: natstack-panel://{panelId}/resource
    panelId = url.hostname;
    pathname = url.pathname || "/";
  }

  console.log(`[InMemoryPanel] Request: ${request.url}`);
  console.log(`[InMemoryPanel] Parsed panelId: ${panelId}, pathname: ${pathname}`);
  console.log(`[InMemoryPanel] Available panels:`, Array.from(inMemoryPanels.keys()));

  const panelContent = inMemoryPanels.get(panelId);
  if (!panelContent) {
    console.error(`[InMemoryPanel] Panel not found: ${panelId}`);
    return new Response(`Panel not found: ${panelId}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Route based on pathname
  if (pathname === "/" || pathname === "/index.html") {
    // Inject the bundle script tag into the HTML
    const htmlWithBundle = injectBundleIntoHtml(panelContent.html, panelId);
    console.log(`[InMemoryPanel] Serving HTML (${htmlWithBundle.length} bytes)`);
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

  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Set up the protocol handler for the default session
 * Must be called after app.ready
 */
export function setupInMemoryPanelProtocol(): void {
  console.log("[InMemoryPanel] Setting up protocol handler for default session");
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
    return;
  }

  // Create registration promise
  const registrationPromise = (async () => {
    try {
      console.log(`[InMemoryPanel] Registering protocol for partition: ${partition}`);
      const ses = session.fromPartition(partition);
      ses.protocol.handle("natstack-panel", handleProtocolRequest);
      registeredPartitions.add(partition);
    } finally {
      // Clean up lock after registration completes
      registrationLocks.delete(partition);
    }
  })();

  registrationLocks.set(partition, registrationPromise);
  await registrationPromise;
}

/**
 * Inject bundle script into HTML
 * Replaces placeholder or appends before </body>
 */
function injectBundleIntoHtml(html: string, panelId: string): string {
  const encodedPanelId = encodeURIComponent(panelId);
  const bundleScript = `<script type="module" src="natstack-panel://panel/${encodedPanelId}/bundle.js"></script>`;
  const cssLink = `<link rel="stylesheet" href="natstack-panel://panel/${encodedPanelId}/bundle.css">`;

  let result = html;

  // Check if there's a placeholder script tag to replace
  if (result.includes("<!-- BUNDLE_PLACEHOLDER -->")) {
    result = result.replace("<!-- BUNDLE_PLACEHOLDER -->", bundleScript);
  } else if (result.includes('src="./bundle.js"')) {
    // Replace relative bundle reference
    result = result.replace(
      /src="\.\/bundle\.js"/g,
      `src="natstack-panel://${panelId}/bundle.js"`
    );
  } else if (!result.includes("bundle.js")) {
    // Append before </body> if no bundle reference exists
    result = result.replace("</body>", `${bundleScript}\n</body>`);
  }

  // Handle CSS similarly
  if (result.includes('href="./bundle.css"')) {
    result = result.replace(
      /href="\.\/bundle\.css"/g,
      `href="natstack-panel://${panelId}/bundle.css"`
    );
  }

  return result;
}

/**
 * Store in-memory panel content
 */
export function storeInMemoryPanel(
  panelId: string,
  artifacts: InMemoryBuildArtifacts
): string {
  inMemoryPanels.set(panelId, {
    html: artifacts.html,
    bundle: artifacts.bundle,
    css: artifacts.css,
  });

  console.log(`[InMemoryPanel] Stored panel: ${panelId}`);

  // Return the URL for this panel
  // Use the new format with encoded panelId to handle '/' in panel IDs
  const encodedPanelId = encodeURIComponent(panelId);
  return `natstack-panel://panel/${encodedPanelId}/index.html`;
}

/**
 * Remove in-memory panel content
 */
export function removeInMemoryPanel(panelId: string): void {
  inMemoryPanels.delete(panelId);
}

/**
 * Check if a panel is served from memory
 */
export function isInMemoryPanel(panelId: string): boolean {
  return inMemoryPanels.has(panelId);
}

/**
 * Get the URL for an in-memory panel
 */
export function getInMemoryPanelUrl(panelId: string): string {
  const encodedPanelId = encodeURIComponent(panelId);
  return `natstack-panel://panel/${encodedPanelId}/index.html`;
}
