/**
 * Auto-mounting system for Svelte panels with zero configuration.
 * Finds default export, mounts Svelte component to #root, sets up
 * connection error handling equivalent to React's ConnectionErrorBarrier.
 */

import { getTheme, onThemeChange, onConnectionError } from "@workspace/runtime";

export interface AutoMountConfig {
  rootId?: string;
}

/**
 * Auto-mount a Svelte component from a module.
 * Looks for default export or named "App" export.
 */
export function autoMountSveltePanel(
  userModule: any,
  config: AutoMountConfig = {},
): void {
  const rootId = config.rootId ?? "root";
  let Component: any;

  if (userModule.default) {
    Component = userModule.default;
  } else if (userModule.App) {
    Component = userModule.App;
  } else {
    throw new Error(
      "No component found to mount. Export a default component or named 'App' component.",
    );
  }

  const container = document.getElementById(rootId);
  if (!container) {
    throw new Error(`Svelte root element '#${rootId}' not found in panel DOM`);
  }

  // Set up connection error handling (vanilla DOM, framework-agnostic)
  setupConnectionErrorOverlay();

  // Mount the Svelte component (supports Svelte 4 and 5)
  try {
    new Component({ target: container });
  } catch {
    throw new Error("Failed to mount Svelte component. Ensure it has a valid default export.");
  }
}

/**
 * Detects if a module should be auto-mounted.
 * Returns false if the module manually calls mount().
 */
export function shouldAutoMount(userModule: any): boolean {
  if (userModule.__noAutoMount === true) {
    return false;
  }
  return !!(userModule.default || userModule.App);
}

/**
 * Set up connection error overlay using vanilla DOM.
 * Matches behavior of React's ConnectionErrorBarrier in reactPanel.ts.
 */
function setupConnectionErrorOverlay(): void {
  onConnectionError((err) => {
    // Remove any existing overlay
    const existing = document.getElementById("__natstack-conn-error");
    if (existing) existing.remove();

    if (err.source === "server") {
      // Non-blocking banner
      const banner = document.createElement("div");
      banner.id = "__natstack-conn-error";
      Object.assign(banner.style, {
        padding: "8px 16px",
        background: "#fef3cd",
        color: "#856404",
        fontSize: "13px",
        textAlign: "center",
        borderBottom: "1px solid #ffc107",
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        zIndex: "2147483647",
      });
      banner.textContent = `Backend unavailable: ${err.reason}`;
      document.body.prepend(banner);
    } else {
      // Full-screen overlay
      const overlay = document.createElement("div");
      overlay.id = "__natstack-conn-error";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-background, #fff)",
        color: "var(--color-text, #111)",
        fontFamily: "system-ui, sans-serif",
        zIndex: "2147483647",
      });
      overlay.innerHTML = `
        <div style="text-align: center; max-width: 400px; padding: 24px;">
          <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Connection lost</div>
          <div style="font-size: 14px; opacity: 0.7;">${escapeHtml(err.reason)}</div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
