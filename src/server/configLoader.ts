/**
 * Config Loader — host-injected panel identity bootstrap.
 *
 * This script is served as `/__loader.js` and injected into panel HTML
 * as a blocking classic script. The host injects the full panel init bundle
 * at runtime, and this loader simply normalizes it into the globals consumed
 * by the transport/runtime code.
 */

export const CONFIG_LOADER_JS = `(async () => {
  const installRandomUuidPolyfill = () => {
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.randomUUID === "function") return;
    const fallbackRandom = () => Math.floor(Math.random() * 256);
    const getByte = () => {
      if (typeof cryptoObj.getRandomValues === "function") {
        const bytes = new Uint8Array(1);
        cryptoObj.getRandomValues(bytes);
        return bytes[0];
      }
      return fallbackRandom();
    };
    Object.defineProperty(cryptoObj, "randomUUID", {
      configurable: true,
      value: () => {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < bytes.length; i++) bytes[i] = getByte();
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
        return [
          hex.slice(0, 4).join(""),
          hex.slice(4, 6).join(""),
          hex.slice(6, 8).join(""),
          hex.slice(8, 10).join(""),
          hex.slice(10, 16).join(""),
        ].join("-");
      },
    });
  };
  installRandomUuidPolyfill();

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

  if (!cfg || !cfg.panelId || !cfg.gatewayConfig || !cfg.gatewayConfig.serverUrl || !cfg.gatewayConfig.token) {
    const root = document.getElementById("root");
    if (root) root.innerHTML = "<p>Open this panel from NatStack.</p>";
    return;
  }

  globalThis.__natstackId = cfg.panelId;
  const gatewayConfig = cfg.gatewayConfig;
  const gatewayRpcWsUrl = gatewayConfig.serverUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\\/$/, "") + "/rpc";
  globalThis.__natstackGatewayRpcWsUrl = gatewayRpcWsUrl;
  globalThis.__natstackGatewayToken = gatewayConfig.token;
  globalThis.__natstackKind = "panel";

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
    __natstackGatewayConfig: gatewayConfig,
    __natstackSourceRepo: cfg.sourceRepo,
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
