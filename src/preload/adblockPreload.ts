/**
 * Adblock preload script for browser panels.
 *
 * This preload enables cosmetic filtering (element hiding) in browser panels.
 * It communicates with the AdBlockManager in the main process via IPC to:
 * - Request initial cosmetic filters on page load
 * - Report DOM changes via MutationObserver for dynamic filter updates
 *
 * Runs with contextIsolation: true, sandbox: true, nodeIntegration: false.
 */

import { ipcRenderer } from "electron";

// IPC channel names (must match AdBlockManager)
const IPC_INJECT_COSMETICS = "natstack:adblock:inject-cosmetics";
const IPC_MUTATION_OBSERVER = "natstack:adblock:mutation-observer-enabled";

/**
 * Collect DOM information for cosmetic filter matching.
 */
function collectDomInfo(): { classes: string[]; ids: string[]; hrefs: string[] } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const hrefs = new Set<string>();

  // Collect from all elements
  const elements = document.querySelectorAll("*");
  elements.forEach((el) => {
    // Collect IDs
    if (el.id) {
      ids.add(el.id);
    }

    // Collect classes
    el.classList.forEach((cls) => {
      classes.add(cls);
    });

    // Collect hrefs from links
    if (el instanceof HTMLAnchorElement && el.href) {
      try {
        hrefs.add(el.href);
      } catch {
        // Invalid URL, skip
      }
    }
  });

  return {
    classes: Array.from(classes),
    ids: Array.from(ids),
    hrefs: Array.from(hrefs),
  };
}

/**
 * Request cosmetic filters from main process and apply them.
 * Returns true if filters were successfully requested.
 */
async function injectCosmeticFilters(isInitial: boolean = false): Promise<boolean> {
  try {
    const url = window.location.href;

    if (isInitial) {
      // Initial injection - no DOM info needed
      await ipcRenderer.invoke(IPC_INJECT_COSMETICS, url);
      console.log("[AdBlock] Initial cosmetic filters applied for:", url);
    } else {
      // Update - include DOM info for more targeted filtering
      const domInfo = collectDomInfo();
      await ipcRenderer.invoke(IPC_INJECT_COSMETICS, url, {
        classes: domInfo.classes,
        ids: domInfo.ids,
        hrefs: domInfo.hrefs,
        lifecycle: "update",
      });
    }
    return true;
  } catch (error) {
    // Log at warn level for visibility during development
    console.warn("[AdBlock] Failed to inject cosmetic filters:", error);
    return false;
  }
}

/**
 * Set up MutationObserver to detect DOM changes and request filter updates.
 */
async function setupMutationObserver(): Promise<void> {
  // Check if mutation observer is enabled
  let enabled = false;
  try {
    enabled = await ipcRenderer.invoke(IPC_MUTATION_OBSERVER);
  } catch (error) {
    console.warn("[AdBlock] Failed to check mutation observer status:", error);
    return;
  }

  if (!enabled) {
    console.log("[AdBlock] Dynamic cosmetic filtering disabled");
    return;
  }

  console.log("[AdBlock] Dynamic cosmetic filtering enabled");

  // Debounce updates to avoid excessive IPC calls
  let updateTimeout: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 250;

  const observer = new MutationObserver(() => {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      void injectCosmeticFilters(false);
    }, DEBOUNCE_MS);
  });

  // Observe the entire document for additions
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "id"],
  });
}

/**
 * Initialize adblock functionality.
 */
function init(): void {
  console.log("[AdBlock] Preload initialized");

  // Inject initial cosmetic filters as soon as DOM is available
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void injectCosmeticFilters(true).then((success) => {
        if (success) {
          void setupMutationObserver();
        } else {
          console.log("[AdBlock] Cosmetic filtering disabled or unavailable");
        }
      });
    });
  } else {
    // DOM already loaded
    void injectCosmeticFilters(true).then((success) => {
      if (success) {
        void setupMutationObserver();
      } else {
        console.log("[AdBlock] Cosmetic filtering disabled or unavailable");
      }
    });
  }

  // Also inject on subsequent navigations (SPA support)
  // Note: This handles in-page navigation that doesn't trigger a full page load
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      void injectCosmeticFilters(true);
    }
  });

  // Start observing once DOM is ready
  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
}

// Initialize
init();
