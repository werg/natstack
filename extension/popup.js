/**
 * NatStack Panel Manager — Popup UI
 *
 * Shows the list of active panels and their tab status.
 * Communicates with the background service worker for state.
 */

const panelList = document.getElementById("panelList");
const emptyState = document.getElementById("emptyState");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const settingsLink = document.getElementById("settingsLink");
const reconnectLink = document.getElementById("reconnectLink");

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(status) {
  // Connection status
  if (status.connected) {
    statusDot.className = "status-dot connected";
    statusText.textContent = "Connected";
  } else {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = "Disconnected";
  }

  // Panel list
  const panels = status.panels || [];

  if (panels.length === 0) {
    panelList.style.display = "none";
    emptyState.style.display = "block";
    return;
  }

  panelList.style.display = "block";
  emptyState.style.display = "none";

  // Build tree structure
  const roots = panels.filter((p) => !p.parentId);
  const childMap = new Map();
  for (const p of panels) {
    if (p.parentId) {
      if (!childMap.has(p.parentId)) childMap.set(p.parentId, []);
      childMap.get(p.parentId).push(p);
    }
  }

  panelList.innerHTML = "";

  function renderPanel(panel, depth) {
    const li = document.createElement("li");
    li.className = "panel-item";
    if (depth > 0) {
      li.style.paddingLeft = `${12 + depth * 16}px`;
    }

    const info = document.createElement("div");
    info.className = "panel-info";

    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = panel.title;

    const sub = document.createElement("div");
    sub.className = "panel-sub";
    sub.textContent = `${panel.subdomain}.localhost`;

    info.appendChild(title);
    info.appendChild(sub);
    li.appendChild(info);

    if (panel.hasTab) {
      const badge = document.createElement("span");
      badge.className = "panel-badge open";
      badge.textContent = "open";
      li.appendChild(badge);

      li.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "focusTab", panelId: panel.panelId });
      });
    } else if (panel.url) {
      const btn = document.createElement("button");
      btn.className = "open-btn";
      btn.textContent = "Open";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: "openPanel", url: panel.url });
      });
      li.appendChild(btn);
    } else {
      const badge = document.createElement("span");
      badge.className = "panel-badge";
      badge.textContent = "building";
      li.appendChild(badge);
    }

    panelList.appendChild(li);

    // Render children
    const children = childMap.get(panel.panelId) || [];
    for (const child of children) {
      renderPanel(child, depth + 1);
    }
  }

  for (const root of roots) {
    renderPanel(root, 0);
  }

  // Render orphaned children (parent not in list)
  const renderedIds = new Set();
  function collectRendered(panel) {
    renderedIds.add(panel.panelId);
    for (const child of (childMap.get(panel.panelId) || [])) {
      collectRendered(child);
    }
  }
  for (const root of roots) collectRendered(root);

  for (const panel of panels) {
    if (!renderedIds.has(panel.panelId)) {
      renderPanel(panel, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

// Get initial status
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  if (response) render(response);
});

// Listen for status updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    render(msg);
  }
});

// Settings link
settingsLink.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Reconnect link
reconnectLink.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" });
  statusDot.className = "status-dot";
  statusText.textContent = "Connecting...";
});
