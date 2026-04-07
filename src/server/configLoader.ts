/**
 * Config Loader — host-injected panel identity bootstrap.
 *
 * This script is served as `/__loader.js` and injected into panel HTML
 * as a blocking classic script. The host injects the full panel init bundle
 * at runtime, and this loader simply normalizes it into the globals consumed
 * by the transport/runtime code.
 */

export const CONFIG_LOADER_JS = `(async () => {
  const parseStoredInit = () => {
    try {
      const raw = sessionStorage.getItem("__natstackPanelInit");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  let cfg = null;
  const shell = globalThis.__natstackShell ?? globalThis.__natstackElectron;

  if (shell && typeof shell.getPanelInit === "function") {
    try {
      cfg = await shell.getPanelInit();
      sessionStorage.setItem("__natstackPanelInit", JSON.stringify(cfg));
    } catch (err) {
      const root = document.getElementById("root");
      if (root) root.textContent = "Failed to load panel init: " + (err.message || err);
      return;
    }
  } else if (globalThis.__natstackPanelInit) {
    cfg = globalThis.__natstackPanelInit;
    sessionStorage.setItem("__natstackPanelInit", JSON.stringify(cfg));
  } else {
    cfg = parseStoredInit();
  }

  if (!cfg || !cfg.panelId || !cfg.rpcWsUrl || !cfg.rpcToken) {
    const root = document.getElementById("root");
    if (root) root.innerHTML = "<p>Open this panel from NatStack.</p>";
    return;
  }

  globalThis.__natstackId = cfg.panelId;
  globalThis.__natstackRpcPort = cfg.rpcPort;
  globalThis.__natstackRpcWsUrl = cfg.rpcWsUrl;
  globalThis.__natstackRpcToken = cfg.rpcToken;
  globalThis.__natstackKind = "panel";
  if (cfg.rpcHost) globalThis.__natstackRpcHost = cfg.rpcHost;

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/__transport.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const url = new URL(location.href);
  let effectiveStateArgs = cfg.stateArgs;
  if (url.searchParams.has("stateArgs")) {
    try { effectiveStateArgs = JSON.parse(url.searchParams.get("stateArgs")); } catch { /* ignore */ }
  }
  Object.assign(globalThis, {
    __natstackContextId: cfg.contextId,
    __natstackParentId: cfg.parentId,
    __natstackInitialTheme: cfg.theme,
    __natstackGitConfig: cfg.gitConfig,
    __natstackPubSubConfig: cfg.pubsubConfig,
    __natstackEnv: cfg.env,
    __natstackStateArgs: effectiveStateArgs,
    process: { env: cfg.env },
  });

  globalThis.__natstackContextReady = true;
  const bundle = document.createElement("script");
  bundle.type = "module";
  bundle.src = "./bundle.js";
  document.body.appendChild(bundle);
})();`;
