/**
 * NatStack Panel Manager — Background Script (Firefox)
 *
 * Connects to the natstack-server SSE endpoint, listens for panel lifecycle
 * events, and manages browser tabs accordingly.
 *
 * Uses browser.* APIs (Firefox WebExtensions). Firefox does not support
 * tab groups, so that feature is omitted.
 *
 * Context pre-warming: When a panel is created (but not yet built), the
 * extension opens a hidden tab to the panel's /__init__ page. This pre-warms
 * the OPFS storage by running the context bootstrap before the real panel
 * tab is opened, so the panel loads with data already available.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {AbortController | null} */
let abortController = null;

/** @type {Map<string, number>} panelId → tabId */
const panelTabs = new Map();

/** @type {Map<number, string>} tabId → panelId (reverse lookup) */
const tabPanels = new Map();

/** @type {Map<string, object>} panelId → panel metadata */
const panels = new Map();

/** @type {Map<string, number>} panelId → tabId for hidden init tabs (pre-warming) */
const initTabs = new Map();

/** @type {boolean} */
let connected = false;

/** @type {number} */
let reconnectAttempt = 0;

/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig() {
  const result = await browser.storage.local.get(["serverUrl", "managementToken", "autoOpenTabs", "autoCloseTabs"]);
  return {
    serverUrl: result.serverUrl || "",
    managementToken: result.managementToken || "",
    autoOpenTabs: result.autoOpenTabs !== false,
    autoCloseTabs: result.autoCloseTabs !== false,
  };
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

  abortController = new AbortController();

  try {
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${config.managementToken}` },
      signal: abortController.signal,
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
          await handleSSEEvent(parsed.event, parsed.data, config);
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
  if (abortController) {
    abortController.abort();
    abortController = null;
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

      // Pre-warm context: open a hidden tab to the /__init__ page.
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

      // Close pre-warming init tab (if still open)
      closeInitTab(data.panelId);

      // Auto-open tab if configured and URL is available
      if (config.autoOpenTabs && data.url && !panelTabs.has(data.panelId)) {
        try {
          const tab = await browser.tabs.create({ url: data.url, active: false });
          if (tab.id != null) {
            panelTabs.set(data.panelId, tab.id);
            tabPanels.set(tab.id, data.panelId);
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
      closeInitTab(data.panelId);

      if (config.autoCloseTabs) {
        const tabId = panelTabs.get(data.panelId);
        if (tabId != null) {
          try {
            await browser.tabs.remove(tabId);
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

browser.tabs.onRemoved.addListener((tabId) => {
  const panelId = tabPanels.get(tabId);
  if (panelId) {
    panelTabs.delete(panelId);
    tabPanels.delete(tabId);
    broadcastStatus();
  }

  // Also clean up init tabs
  for (const [pid, tid] of initTabs) {
    if (tid === tabId) {
      initTabs.delete(pid);
      break;
    }
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url) {
    const match = tab.url.match(/^https?:\/\/([a-z0-9-]+)\.localhost(:\d+)?\//i);
    if (match) {
      const subdomain = match[1];
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

// ---------------------------------------------------------------------------
// Context pre-warming
// ---------------------------------------------------------------------------

/**
 * Pre-warm a panel's context by opening a hidden tab to /__init__.
 * @param {string} panelId
 * @param {string} subdomain
 * @param {string} initToken - Short-lived token from panel:created event
 * @param {object} config
 */
async function preWarmContext(panelId, subdomain, initToken, config) {
  if (initTabs.has(panelId)) return;

  try {
    const serverUrl = new URL(config.serverUrl);
    const port = serverUrl.port || (serverUrl.protocol === "https:" ? "443" : "80");
    const initUrl = `http://${subdomain}.localhost:${port}/__init__?token=${encodeURIComponent(initToken)}`;

    console.log(`[NatStack] Pre-warming context for ${panelId}: ${initUrl}`);

    const tab = await browser.tabs.create({
      url: initUrl,
      active: false,
    });

    if (tab.id != null) {
      initTabs.set(panelId, tab.id);

      // Auto-close init tab after 30s timeout (safety net)
      setTimeout(() => {
        closeInitTab(panelId);
      }, 30000);
    }
  } catch (err) {
    console.warn(`[NatStack] Failed to pre-warm context for ${panelId}:`, err);
  }
}

/**
 * Close and clean up a pre-warming init tab.
 * @param {string} panelId
 */
async function closeInitTab(panelId) {
  const tabId = initTabs.get(panelId);
  if (tabId == null) return;
  initTabs.delete(panelId);

  try {
    await browser.tabs.remove(tabId);
    console.log(`[NatStack] Closed init tab for ${panelId}`);
  } catch {
    // Tab already closed
  }
}

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------

function buildStatusPayload() {
  return {
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
}

function broadcastStatus() {
  browser.runtime.sendMessage({ type: "status", ...buildStatusPayload() }).catch(() => {
    // No popup open
  });
}

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type === "getStatus") {
    return Promise.resolve(buildStatusPayload());
  }

  if (msg.type === "focusTab") {
    const tabId = panelTabs.get(msg.panelId);
    if (tabId != null) {
      browser.tabs.update(tabId, { active: true });
      browser.tabs.get(tabId).then((tab) => {
        if (tab.windowId != null) {
          browser.windows.update(tab.windowId, { focused: true });
        }
      }).catch(() => {});
    }
    return false;
  }

  if (msg.type === "openPanel") {
    if (msg.url) {
      browser.tabs.create({ url: msg.url, active: true });
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
    for (const [panelId, panel] of panels) {
      if (panel.contextId === msg.contextId || panel.subdomain === msg.subdomain) {
        closeInitTab(panelId);
        break;
      }
    }
    return false;
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.serverUrl || changes.managementToken)) {
    reconnectAttempt = 0;
    connect();
  }
});

connect();
