/**
 * NatStack Panel Manager — Background Service Worker
 *
 * Connects to the natstack-server SSE endpoint, listens for panel lifecycle
 * events, and manages browser tabs accordingly.
 *
 * Context pre-warming: When a panel is created (but not yet built), the
 * extension opens a hidden tab to the panel's /__init__ page. This pre-warms
 * the context by running the context bootstrap before the real panel
 * tab is opened, so the panel loads with data already available.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {AbortController | null} */
let sseAbort = null;

/** @type {Map<string, number>} panelId → tabId */
const panelTabs = new Map();

/** @type {Map<number, string>} tabId → panelId (reverse lookup) */
const tabPanels = new Map();

/** @type {Map<string, object>} panelId → panel metadata */
const panels = new Map();

/** @type {Map<string, number>} panelId → windowId for minimized init windows (pre-warming) */
const initWindows = new Map();

/** @type {boolean} */
let connected = false;

/** @type {number} */
let reconnectAttempt = 0;

/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "com.natstack.connector";

async function getConfig() {
  const result = await chrome.storage.local.get(["serverUrl", "managementToken", "autoOpenTabs", "autoCloseTabs"]);
  return {
    serverUrl: result.serverUrl || "",
    managementToken: result.managementToken || "",
    autoOpenTabs: result.autoOpenTabs !== false,
    autoCloseTabs: result.autoCloseTabs !== false,
  };
}

// ---------------------------------------------------------------------------
// Native messaging auto-discovery
// ---------------------------------------------------------------------------

/**
 * Try to discover the running natstack-server via native messaging.
 * If successful, stores the config in chrome.storage.local so the normal
 * SSE connect() path picks it up. This is idempotent — safe to call on
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
// SSE connection
// ---------------------------------------------------------------------------

async function connect() {
  disconnect();

  const config = await getConfig();
  if (!config.serverUrl || !config.managementToken) {
    console.log("[NatStack] No server URL or token configured — skipping connection");
    return;
  }

  const url = `${config.serverUrl}/api/events`;
  console.log(`[NatStack] Connecting to SSE: ${url}`);

  sseAbort = new AbortController();

  try {
    // EventSource doesn't support custom headers, so we use fetch + ReadableStream
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${config.managementToken}` },
      signal: sseAbort.signal,
    });

    if (!response.ok) {
      console.error(`[NatStack] SSE connection failed: ${response.status}`);
      scheduleReconnect();
      return;
    }

    connected = true;
    reconnectAttempt = 0;
    broadcastStatus();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE messages from buffer
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        if (!msg.trim()) continue;
        const parsed = parseSSEMessage(msg);
        if (parsed) {
          handleSSEEvent(parsed.event, parsed.data, config);
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("[NatStack] SSE connection error:", err);
  }

  connected = false;
  broadcastStatus();
  scheduleReconnect();
}

function disconnect() {
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
  connected = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + Math.random() * 500, 30000);
  reconnectAttempt++;
  console.log(`[NatStack] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Parse a raw SSE message block into {event, data}.
 * @param {string} raw
 * @returns {{ event: string, data: string } | null}
 */
function parseSSEMessage(raw) {
  let event = "message";
  let data = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      data += line.slice(6);
    } else if (line.startsWith("data:")) {
      data += line.slice(5);
    }
  }

  if (!data) return null;
  return { event, data };
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

/**
 * @param {string} event
 * @param {string} dataStr
 * @param {object} config
 */
async function handleSSEEvent(event, dataStr, config) {
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch {
    console.warn("[NatStack] Failed to parse SSE data:", dataStr);
    return;
  }

  console.log(`[NatStack] Event: ${event}`, data);

  switch (event) {
    case "snapshot": {
      // Initial state — sync panels map
      panels.clear();
      if (data.panels) {
        for (const p of data.panels) {
          panels.set(p.panelId, p);
        }
      }
      broadcastStatus();
      break;
    }

    case "panel:created": {
      panels.set(data.panelId, data);
      broadcastStatus();

      // Pre-warm context: open a hidden tab to the /__init__ page
      // This pre-warms the context before the real panel tab is opened.
      // The initToken from the event authenticates the init page request.
      if (data.subdomain && config.serverUrl && data.initToken) {
        preWarmContext(data.panelId, data.subdomain, data.initToken, config);
      }
      break;
    }

    case "panel:built": {
      const existing = panels.get(data.panelId);
      if (existing) {
        Object.assign(existing, data);
      } else {
        panels.set(data.panelId, data);
      }

      // Close pre-warming init tab (if still open) — the real panel
      // will now handle any remaining bootstrap inline
      closeInitWindow(data.panelId);

      // Auto-open tab if configured and URL is available
      if (config.autoOpenTabs && data.url && !panelTabs.has(data.panelId)) {
        try {
          const tab = await chrome.tabs.create({ url: data.url, active: false });
          if (tab.id != null) {
            panelTabs.set(data.panelId, tab.id);
            tabPanels.set(tab.id, data.panelId);

            // Try to group natstack tabs together
            try {
              await groupNatstackTabs();
            } catch { /* tab grouping not supported or failed */ }
          }
        } catch (err) {
          console.error("[NatStack] Failed to open tab:", err);
        }
      }

      broadcastStatus();
      break;
    }

    case "panel:closed": {
      panels.delete(data.panelId);

      // Close any pre-warming init tab
      closeInitWindow(data.panelId);

      // Auto-close tab if configured
      if (config.autoCloseTabs) {
        const tabId = panelTabs.get(data.panelId);
        if (tabId != null) {
          try {
            await chrome.tabs.remove(tabId);
          } catch { /* tab already closed */ }
        }
      }
      panelTabs.delete(data.panelId);

      broadcastStatus();
      break;
    }

    case "panel:build-error": {
      const existing2 = panels.get(data.panelId);
      if (existing2) {
        existing2.buildState = "failed";
        existing2.error = data.error;
      }
      broadcastStatus();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Tab tracking
// ---------------------------------------------------------------------------

// Clean up mappings when tabs are closed by the user
chrome.tabs.onRemoved.addListener((tabId) => {
  const panelId = tabPanels.get(tabId);
  if (panelId) {
    panelTabs.delete(panelId);
    tabPanels.delete(tabId);
  }

  broadcastStatus();
});

// Clean up init window mappings when windows are closed
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [pid, wid] of initWindows) {
    if (wid === windowId) {
      initWindows.delete(pid);
      break;
    }
  }
});

// Track when tabs navigate to detect manually opened natstack tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url) {
    const match = tab.url.match(/^https?:\/\/([a-z0-9-]+)\.localhost(:\d+)?\//i);
    if (match) {
      const subdomain = match[1];
      // Find panel by subdomain
      for (const [panelId, panel] of panels) {
        if (panel.subdomain === subdomain && !panelTabs.has(panelId)) {
          panelTabs.set(panelId, tabId);
          tabPanels.set(tabId, panelId);
          broadcastStatus();
          break;
        }
      }
    }
  }
});

/**
 * Group all natstack panel tabs into a Chrome tab group.
 * No-op on browsers that don't support the tab groups API (e.g. Firefox, older Edge).
 */
async function groupNatstackTabs() {
  if (typeof chrome.tabs.group !== "function") return;

  const tabIds = Array.from(panelTabs.values());
  if (tabIds.length < 2) return;

  const tabs = await chrome.tabs.query({});
  const natstackTabIds = tabIds.filter((id) => tabs.some((t) => t.id === id));
  if (natstackTabIds.length < 2) return;

  const existingTab = tabs.find((t) => natstackTabIds.includes(t.id) && t.groupId !== -1);
  if (existingTab && existingTab.groupId !== -1) {
    await chrome.tabs.group({ tabIds: natstackTabIds, groupId: existingTab.groupId });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: natstackTabIds });
    if (typeof chrome.tabGroups?.update === "function") {
      await chrome.tabGroups.update(groupId, { title: "NatStack", color: "red" });
    }
  }
}

// ---------------------------------------------------------------------------
// Context pre-warming
// ---------------------------------------------------------------------------

/**
 * Pre-warm a panel's context by opening a minimized popup window to /__init__.
 *
 * Uses a minimized popup window instead of a background tab so the user
 * doesn't see a tab flash in their tab bar. The init page runs the context
 * bootstrap and signals completion via
 * chrome.runtime.sendMessage().
 *
 * @param {string} panelId
 * @param {string} subdomain
 * @param {string} initToken - Short-lived token from panel:created event
 * @param {object} config
 */
async function preWarmContext(panelId, subdomain, initToken, config) {
  if (initWindows.has(panelId)) return;

  try {
    const serverUrl = new URL(config.serverUrl);
    const port = serverUrl.port || (serverUrl.protocol === "https:" ? "443" : "80");
    const initUrl = `http://${subdomain}.localhost:${port}/__init__?token=${encodeURIComponent(initToken)}`;

    console.log(`[NatStack] Pre-warming context for ${panelId}: ${initUrl}`);

    const win = await chrome.windows.create({
      url: initUrl,
      type: "popup",
      state: "minimized",
      focused: false,
      width: 400,
      height: 300,
    });

    if (win.id != null) {
      initWindows.set(panelId, win.id);

      // Auto-close after 30s timeout (safety net)
      setTimeout(() => {
        closeInitWindow(panelId);
      }, 30000);
    }
  } catch (err) {
    console.warn(`[NatStack] Failed to pre-warm context for ${panelId}:`, err);
  }
}

/**
 * Close and clean up a pre-warming init window.
 * @param {string} panelId
 */
async function closeInitWindow(panelId) {
  const windowId = initWindows.get(panelId);
  if (windowId == null) return;
  initWindows.delete(panelId);

  try {
    await chrome.windows.remove(windowId);
    console.log(`[NatStack] Closed init window for ${panelId}`);
  } catch {
    // Window already closed
  }
}

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------

function broadcastStatus() {
  const status = {
    connected,
    panels: Array.from(panels.entries()).map(([id, p]) => ({
      panelId: id,
      title: p.title || id,
      subdomain: p.subdomain || "",
      url: p.url || "",
      source: p.source || "",
      parentId: p.parentId || null,
      hasTab: panelTabs.has(id),
      tabId: panelTabs.get(id) ?? null,
    })),
  };

  // Send to any open popup
  chrome.runtime.sendMessage({ type: "status", ...status }).catch(() => {
    // No popup open — ignore
  });
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStatus") {
    const status = {
      connected,
      panels: Array.from(panels.entries()).map(([id, p]) => ({
        panelId: id,
        title: p.title || id,
        subdomain: p.subdomain || "",
        url: p.url || "",
        source: p.source || "",
        parentId: p.parentId || null,
        hasTab: panelTabs.has(id),
        tabId: panelTabs.get(id) ?? null,
      })),
    };
    sendResponse(status);
    return true;
  }

  if (msg.type === "focusTab") {
    const tabId = panelTabs.get(msg.panelId);
    if (tabId != null) {
      chrome.tabs.update(tabId, { active: true });
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.windowId != null) {
          chrome.windows.update(tab.windowId, { focused: true });
        }
      }).catch(() => {});
    }
    return false;
  }

  if (msg.type === "openPanel") {
    if (msg.url) {
      chrome.tabs.create({ url: msg.url, active: true });
    }
    return false;
  }

  if (msg.type === "reconnect") {
    reconnectAttempt = 0;
    connect();
    return false;
  }

  // Context pre-warming completion signal from /__init__ page
  if (msg.type === "contextInitComplete") {
    console.log(`[NatStack] Context init complete: ${msg.contextId} — ${msg.status}`);
    // Find the panel by contextId and close its init tab
    for (const [panelId, panel] of panels) {
      if (panel.contextId === msg.contextId || panel.subdomain === msg.subdomain) {
        closeInitWindow(panelId);
        break;
      }
    }
    return false;
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Listen for config changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.serverUrl || changes.managementToken)) {
    reconnectAttempt = 0;
    connect();
  }
});

// Try native messaging auto-discovery, then connect.
// Always call connect() afterwards — if discovery updated storage, the
// onChanged listener already triggered a reconnect (connect() deduplicates
// via disconnect()). If config was unchanged, no onChanged fires, so we
// must call connect() explicitly to establish the SSE connection.
tryNativeDiscovery().then(() => {
  connect();
});
