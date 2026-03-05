/**
 * Config Loader — Nonce-keyed cookie bootstrap + RPC config delivery.
 *
 * This script is served as `/__loader.js` and injected into panel HTML
 * as a blocking classic script. It:
 *
 * 1. Reads bootstrap data from nonce-keyed `_ns_boot_{bk}` cookie or sessionStorage
 * 2. Seeds panelId, rpcPort, rpcToken into sessionStorage
 * 3. Loads `/__transport.js` (browser RPC transport)
 * 4. Calls `bridge.getBootstrapConfig` via RPC to get full config
 * 5. Sets `globalThis.__natstack*` globals
 * 6. Sets `globalThis.__natstackContextReady = true`
 * 7. Loads `./bundle.js` as a module
 *
 * Bootstrap data sources (checked in order):
 * - URL params: `?pid=&rpcPort=&rpcToken=` (Electron — all data in URL)
 * - `_ns_boot_{bk}` cookie (browser — set by server on redirect, one-time use)
 * - sessionStorage (cached from prior load — validated against current source)
 *
 * Recovery: if no bootstrap data or RPC fails, redirects with `?_fresh`
 * to force re-bootstrap via the server (browser flow only; Electron always
 * has URL params).
 *
 * Exported as a string constant for PanelHttpServer to serve.
 */

export const CONFIG_LOADER_JS = `(async () => {
  const url = new URL(location.href);
  let pid = null;
  let rpcPort = null;
  let rpcToken = null;

  // Extract current source from URL pathname (first two segments: "panels/my-app")
  const sourceMatch = url.pathname.match(/^\\/([^/]+\\/[^/]+)/);
  const currentSource = sourceMatch ? sourceMatch[1] : "";

  // ── 1. Read bootstrap data from URL params ──
  // Electron: pid + rpcPort + rpcToken passed directly in URL (no cookie dependency).
  // Browser: _bk param points to nonce-keyed boot cookie with credentials.
  const bk = url.searchParams.get("_bk");
  const urlPid = url.searchParams.get("pid");

  // Electron path: all credentials in URL params
  let serverRpcPort = null;
  let serverRpcToken = null;
  if (urlPid) {
    pid = urlPid;
    if (url.searchParams.has("rpcPort")) rpcPort = Number(url.searchParams.get("rpcPort"));
    if (url.searchParams.has("rpcToken")) rpcToken = url.searchParams.get("rpcToken");
    if (url.searchParams.has("serverRpcPort")) serverRpcPort = Number(url.searchParams.get("serverRpcPort"));
    if (url.searchParams.has("serverRpcToken")) serverRpcToken = url.searchParams.get("serverRpcToken");
  }

  // Browser path: credentials in nonce-keyed boot cookie
  if (!pid && bk) {
    const cookieName = "_ns_boot_" + bk;
    const cookies = document.cookie.split(";").reduce((acc, c) => {
      const eq = c.indexOf("=");
      if (eq !== -1) acc[c.slice(0, eq).trim()] = c.slice(eq + 1).trim();
      return acc;
    }, {});
    const raw = cookies[cookieName];
    if (raw) {
      try {
        const boot = JSON.parse(decodeURIComponent(raw));
        pid = boot.pid;
        rpcPort = boot.rpcPort;
        rpcToken = boot.rpcToken;
        if (boot.serverRpcPort) serverRpcPort = boot.serverRpcPort;
        if (boot.serverRpcToken) serverRpcToken = boot.serverRpcToken;
        // Delete the one-time cookie
        document.cookie = cookieName + "=; Max-Age=0; Path=/; SameSite=Strict";
      } catch { /* ignore parse errors */ }
    }
  }

  // Store in sessionStorage and clean URL if we got fresh data
  if (pid && (urlPid || bk)) {
    sessionStorage.setItem("__natstackPanelId", pid);
    if (rpcPort) sessionStorage.setItem("__natstackRpcPort", String(rpcPort));
    if (rpcToken) sessionStorage.setItem("__natstackRpcToken", rpcToken);
    if (serverRpcPort) sessionStorage.setItem("__natstackServerRpcPort", String(serverRpcPort));
    if (serverRpcToken) sessionStorage.setItem("__natstackServerRpcToken", serverRpcToken);
    sessionStorage.setItem("__natstackSource", currentSource);
    // Clean all bootstrap params from URL
    url.searchParams.delete("_bk");
    url.searchParams.delete("pid");
    url.searchParams.delete("rpcPort");
    url.searchParams.delete("rpcToken");
    url.searchParams.delete("serverRpcPort");
    url.searchParams.delete("serverRpcToken");
    history.replaceState(null, "", url.pathname + (url.search || ""));
  }

  // ── 3. Fallback: sessionStorage (reload case) ──
  if (!pid) {
    const storedSource = sessionStorage.getItem("__natstackSource");
    if (storedSource && storedSource !== currentSource) {
      // Cross-source navigation on same subdomain — stale identity.
      // Clear stale data and redirect with ?_fresh to force re-bootstrap.
      sessionStorage.removeItem("__natstackPanelId");
      sessionStorage.removeItem("__natstackRpcPort");
      sessionStorage.removeItem("__natstackRpcToken");
      sessionStorage.removeItem("__natstackServerRpcPort");
      sessionStorage.removeItem("__natstackServerRpcToken");
      sessionStorage.removeItem("__natstackSource");
      location.href = url.pathname + "?_fresh";
      return;
    }
    pid = sessionStorage.getItem("__natstackPanelId");
    rpcPort = Number(sessionStorage.getItem("__natstackRpcPort")) || null;
    rpcToken = sessionStorage.getItem("__natstackRpcToken");
    if (!serverRpcPort) serverRpcPort = Number(sessionStorage.getItem("__natstackServerRpcPort")) || null;
    if (!serverRpcToken) serverRpcToken = sessionStorage.getItem("__natstackServerRpcToken");
  }

  // ── 4. No bootstrap data — force re-bootstrap ──
  // Redirect with ?_fresh to force the server to run bootstrapBrowserTab,
  // which creates a panel on-demand and sets a fresh boot cookie.
  // This handles: cleared sessionStorage, fresh authed tab, etc.
  if (!pid || !rpcPort || !rpcToken) {
    if (!url.searchParams.has("_fresh")) {
      location.href = url.pathname + "?_fresh";
      return;
    }
    // If we already tried ?_fresh and still have no data, show fallback
    const root = document.getElementById("root");
    if (root) root.innerHTML = "<p>Open this panel from NatStack.</p>";
    return;
  }

  // ── 5. Set transport globals (including server RPC — must be set BEFORE loading transport) ──
  globalThis.__natstackId = pid;
  globalThis.__natstackRpcPort = rpcPort;
  globalThis.__natstackRpcToken = rpcToken;
  globalThis.__natstackKind = "panel";
  if (serverRpcPort) globalThis.__natstackServerRpcPort = serverRpcPort;
  if (serverRpcToken) globalThis.__natstackServerRpcToken = serverRpcToken;

  // ── 6. Load transport ──
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/__transport.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  // ── 7. RPC call: bridge.getBootstrapConfig ──
  const transport = globalThis.__natstackTransport;
  if (!transport) {
    const root = document.getElementById("root");
    if (root) root.textContent = "Transport failed to initialize";
    return;
  }

  let cfg;
  try {
    const requestId = crypto.randomUUID();
    cfg = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Bootstrap config timeout")), 10000);
      const unsub = transport.onMessage((fromId, msg) => {
        if (msg && msg.type === "response" && msg.requestId === requestId) {
          clearTimeout(timeout);
          unsub();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      });
      transport.send("main", {
        type: "request",
        requestId: requestId,
        fromId: pid,
        method: "bridge.getBootstrapConfig",
        args: [],
      });
    });
  } catch (err) {
    // Stale credentials (revoked token, panel closed, etc.) — clear and re-bootstrap.
    // Only auto-recover once to avoid infinite loops.
    if (!url.searchParams.has("_fresh")) {
      sessionStorage.removeItem("__natstackPanelId");
      sessionStorage.removeItem("__natstackRpcPort");
      sessionStorage.removeItem("__natstackRpcToken");
      sessionStorage.removeItem("__natstackSource");
      location.href = url.pathname + "?_fresh";
      return;
    }
    const root = document.getElementById("root");
    if (root) root.textContent = "Failed to load config: " + (err.message || err);
    return;
  }

  // ── 8. Set remaining globals from RPC config ──
  Object.assign(globalThis, {
    __natstackContextId: cfg.contextId,
    __natstackParentId: cfg.parentId,
    __natstackInitialTheme: cfg.theme,
    __natstackGitConfig: cfg.gitConfig,
    __natstackPubSubConfig: cfg.pubsubConfig,
    __natstackEnv: cfg.env,
    __natstackStateArgs: cfg.stateArgs,
    process: { env: cfg.env },
  });

  if (cfg.serverRpcPort) {
    globalThis.__natstackServerRpcPort = cfg.serverRpcPort;
    globalThis.__natstackServerRpcToken = cfg.serverRpcToken;
  }

  // ── 9. Ready — load bundle ──
  globalThis.__natstackContextReady = true;
  const bundle = document.createElement("script");
  bundle.type = "module";
  bundle.src = "./bundle.js";
  document.body.appendChild(bundle);
})();`;
