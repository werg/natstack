/**
 * NatStack Extension — CDP Relay + Native Messaging
 *
 * Chrome-only: relays CDP commands between the natstack server's WebSocket
 * bridge and chrome.debugger, and tracks tab URLs for CDP targeting.
 * Native messaging provides server auto-discovery.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} browserId → tabId */
const panelTabs = new Map();

/** @type {Map<number, string>} tabId → browserId (reverse lookup) */
const tabPanels = new Map();

/** @type {boolean} */
let connected = false;

// ---------------------------------------------------------------------------
// Module-scope config (hoisted for CDP bridge access)
// ---------------------------------------------------------------------------

/** @type {string} */
let serverUrl = "";

/** @type {string} */
let managementToken = "";

// ---------------------------------------------------------------------------
// CDP bridge state (Chrome-only — Firefox lacks chrome.debugger)
// ---------------------------------------------------------------------------

/** @type {WebSocket | null} */
let cdpWs = null;

/** @type {Map<string, boolean>} browserId → attached */
const debuggerAttached = new Map();

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "com.natstack.connector";

async function getConfig() {
  const result = await chrome.storage.local.get(["serverUrl", "managementToken"]);
  // Update module-scope vars so CDP bridge can access them
  serverUrl = result.serverUrl || "";
  managementToken = result.managementToken || "";
  return { serverUrl, managementToken };
}

// ---------------------------------------------------------------------------
// Native messaging auto-discovery
// ---------------------------------------------------------------------------

/**
 * Try to discover the running natstack-server via native messaging.
 * If successful, stores the config in chrome.storage.local so the normal
 * connect() path picks it up. This is idempotent — safe to call on
 * every startup. Falls back silently if native messaging is unavailable.
 */
async function tryNativeDiscovery() {
  try {
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: "getConfig" });
    if (response && response.success && response.serverUrl && response.managementToken) {
      const current = await chrome.storage.local.get(["serverUrl", "managementToken"]);
      // Only update if the values actually changed (avoids triggering unnecessary reconnects)
      if (current.serverUrl !== response.serverUrl || current.managementToken !== response.managementToken) {
        await chrome.storage.local.set({
          serverUrl: response.serverUrl,
          managementToken: response.managementToken,
        });
        console.log("[NatStack] Auto-configured via native messaging:", response.serverUrl);
      } else {
        console.log("[NatStack] Native messaging config unchanged, skipping update");
      }
      return true;
    }
    console.log("[NatStack] Native messaging responded but no valid config:", response);
    return false;
  } catch (err) {
    // Native messaging not available — this is expected when the host isn't installed
    console.log("[NatStack] Native messaging unavailable, using manual config:", err.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

async function connect() {
  disconnect();

  const config = await getConfig();
  if (!config.serverUrl || !config.managementToken) {
    console.log("[NatStack] No server URL or token configured — skipping connection");
    return;
  }

  connected = true;
  connectCdpBridge();
}

function disconnect() {
  connected = false;
  disconnectCdpBridge();
}

// ---------------------------------------------------------------------------
// Tab URL tracking (for CDP targeting)
// ---------------------------------------------------------------------------

// Clean up mappings when tabs are closed by the user
chrome.tabs.onRemoved.addListener((tabId) => {
  const browserId = tabPanels.get(tabId);
  if (browserId) {
    // Unregister from CDP bridge and detach debugger
    if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
      cdpWs.send(JSON.stringify({ type: "cdp:unregister", browserId }));
    }
    detachDebugger(browserId);

    panelTabs.delete(browserId);
    tabPanels.delete(tabId);
  }
});

// Track when tabs navigate to detect natstack tabs by subdomain
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url) {
    const match = tab.url.match(/^https?:\/\/([a-z0-9-]+)\.localhost(:\d+)?\//i);
    if (match) {
      const subdomain = match[1];
      // If this tab isn't already tracked for a browserId, register it
      if (!tabPanels.has(tabId)) {
        // Use subdomain as browserId for CDP targeting
        panelTabs.set(subdomain, tabId);
        tabPanels.set(tabId, subdomain);

        // Register with CDP bridge
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
          cdpWs.send(JSON.stringify({ type: "cdp:register", browserId: subdomain, tabId }));
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// CDP bridge (Chrome-only)
// ---------------------------------------------------------------------------

/**
 * Connect to the server's CDP bridge WebSocket.
 * Called when connection succeeds.
 */
function connectCdpBridge() {
  if (!serverUrl || !managementToken) return;
  if (cdpWs) { cdpWs.close(); cdpWs = null; }

  const url = serverUrl.replace(/^http/, "ws") + "/api/cdp-bridge?token=" + managementToken;
  const ws = new WebSocket(url);
  cdpWs = ws;

  ws.onopen = () => {
    if (cdpWs !== ws) return; // replaced
    console.log("[NatStack] CDP bridge connected");
    // Register all currently tracked panel tabs
    for (const [browserId, tabId] of panelTabs) {
      ws.send(JSON.stringify({ type: "cdp:register", browserId, tabId }));
    }
  };

  ws.onmessage = async (event) => {
    if (cdpWs !== ws) return; // replaced
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "cdp:command") await handleCdpCommand(msg);
      else if (msg.type === "cdp:detach") await detachDebugger(msg.browserId);
      else if (msg.type === "nav:command") await handleNavCommand(msg);
    } catch (err) {
      console.error("[NatStack] CDP bridge message error:", err);
    }
  };

  ws.onclose = () => {
    if (cdpWs !== ws) return; // replaced — don't null out the new connection
    console.log("[NatStack] CDP bridge disconnected");
    cdpWs = null;
    // Retry once after 2s if still connected (covers independent WS drop)
    if (connected) {
      setTimeout(() => {
        if (connected && !cdpWs) {
          console.log("[NatStack] CDP bridge retry");
          connectCdpBridge();
        }
      }, 2000);
    }
  };

  ws.onerror = (err) => {
    console.error("[NatStack] CDP bridge WebSocket error:", err);
  };
}

/**
 * Disconnect from the CDP bridge and detach all debuggers.
 */
function disconnectCdpBridge() {
  if (cdpWs) { cdpWs.close(); cdpWs = null; }
  for (const [browserId] of debuggerAttached) {
    const tabId = panelTabs.get(browserId);
    if (tabId != null) {
      chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
  debuggerAttached.clear();
}

/**
 * Detach debugger for a specific browser and clear its attached flag.
 * @param {string} browserId
 */
async function detachDebugger(browserId) {
  if (!debuggerAttached.has(browserId)) return;
  debuggerAttached.delete(browserId);
  const tabId = panelTabs.get(browserId);
  if (tabId != null) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached
    }
  }
}

/**
 * Handle a CDP command from the server bridge.
 * Lazy-attaches the debugger on first command.
 * @param {object} msg
 */
async function handleCdpCommand(msg) {
  const { requestId, browserId, method, params, sessionId } = msg;
  const tabId = panelTabs.get(browserId);
  if (tabId == null) {
    cdpWs?.send(JSON.stringify({ type: "cdp:error", requestId, browserId, error: "Tab not found" }));
    return;
  }

  try {
    // Lazy attach — also re-attaches after DevTools detach
    if (!debuggerAttached.get(browserId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      debuggerAttached.set(browserId, true);
    }

    // sessionId goes INSIDE the target object (Chrome flat sessions)
    const target = sessionId ? { tabId, sessionId } : { tabId };
    const result = await chrome.debugger.sendCommand(target, method, params ?? {});
    cdpWs?.send(JSON.stringify({ type: "cdp:result", requestId, browserId, result, sessionId }));
  } catch (err) {
    cdpWs?.send(JSON.stringify({ type: "cdp:error", requestId, browserId, error: err.message }));
  }
}

/**
 * Handle a navigation command from the server bridge.
 * Uses chrome.tabs API (no debugger needed) except for "stop".
 * @param {object} msg
 */
async function handleNavCommand(msg) {
  const { requestId, browserId, action, url } = msg;
  const tabId = panelTabs.get(browserId);
  if (tabId == null) {
    cdpWs?.send(JSON.stringify({ type: "nav:error", requestId, browserId, error: "Tab not found" }));
    return;
  }
  try {
    switch (action) {
      case "navigate": await chrome.tabs.update(tabId, { url }); break;
      case "goBack":   await chrome.tabs.goBack(tabId); break;
      case "goForward": await chrome.tabs.goForward(tabId); break;
      case "reload":   await chrome.tabs.reload(tabId); break;
      case "stop":
        if (debuggerAttached.get(browserId)) {
          await chrome.debugger.sendCommand({ tabId }, "Page.stopLoading", {});
        }
        break;
    }
    cdpWs?.send(JSON.stringify({ type: "nav:result", requestId, browserId }));
  } catch (err) {
    cdpWs?.send(JSON.stringify({ type: "nav:error", requestId, browserId, error: err.message }));
  }
}

// Forward CDP events from chrome.debugger to the server bridge
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
  const browserId = tabPanels.get(source.tabId);
  if (!browserId) return;

  cdpWs.send(JSON.stringify({
    type: "cdp:event",
    browserId,
    method,
    params,
    sessionId: source.sessionId,
  }));
});

// Handle debugger detach (e.g. user opens DevTools) — lazy reattach on next command
chrome.debugger.onDetach.addListener((source, _reason) => {
  const browserId = tabPanels.get(source.tabId);
  if (browserId) {
    // Just clear attached flag — next CDP command will re-attach.
    // Do NOT unregister: the tab still exists (user may have just opened DevTools).
    debuggerAttached.delete(browserId);
  }
});

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({ connected });
    return true;
  }

  if (msg.type === "reconnect") {
    connect();
    return false;
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Listen for config changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.serverUrl) serverUrl = changes.serverUrl.newValue || "";
    if (changes.managementToken) managementToken = changes.managementToken.newValue || "";
    if (changes.serverUrl || changes.managementToken) {
      connect();
    }
  }
});

// Try native messaging auto-discovery, then connect.
tryNativeDiscovery().then(() => {
  connect();
});
