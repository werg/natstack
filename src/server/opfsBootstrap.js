/**
 * Context bootstrap — Minimal signaling for init pages.
 *
 * Context filesystem is now server-side (per-context folders accessed via RPC).
 * This script only handles init-page completion signaling for the extension.
 */
(function() {
  "use strict";
  globalThis.__natstackContextReady = true;
  var C = globalThis.__opfsBootstrapConfig;
  if (C && C.isInitPage) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "contextInitComplete", contextId: C.contextId });
      }
    } catch(e) { /* extension not available */ }
  }
})();
