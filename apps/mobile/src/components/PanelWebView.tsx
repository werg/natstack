import React, {
  useRef,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Linking,
  Platform,
} from "react-native";
import { WebView } from "react-native-webview";
import type {
  WebViewNavigation,
  ShouldStartLoadRequest,
  WebViewMessageEvent,
} from "react-native-webview/lib/WebViewTypes";
import { isManagedHost, parsePanelUrl } from "../services/panelUrls";

export interface PanelNavigationEvent {
  type: "panel-switch";
  panelId: string;
  source: string;
  contextId?: string;
  options: { name?: string; contextId?: string; focus?: boolean };
  stateArgs?: Record<string, unknown>;
}

export interface PanelWebViewHandle {
  injectTheme: (mode: "light" | "dark") => void;
  dispatchHostEvent: (event: string, payload: unknown) => void;
}

export interface PanelWebViewProps {
  panelId: string;
  url: string;
  visible: boolean;
  managed: boolean;
  panelInit?: unknown;
  externalHost: string;
  onNavigationStateChange?: (navState: WebViewNavigation) => void;
  onPanelNavigate?: (event: PanelNavigationEvent) => void;
  onTitleChange?: (panelId: string, title: string) => void;
  onBridgeCall?: (panelId: string, method: string, args: unknown[]) => Promise<unknown>;
  onUnmount?: (panelId: string) => void;
  diagnosticsEnabled?: boolean;
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    primary?: string;
  };
}

const NATSTACK_USER_AGENT = `NatStack-Mobile/1.0 (${Platform.OS}; ${Platform.Version})`;
const REFERRER_POLICY_SCRIPT = `try{var m=document.createElement('meta');m.name='referrer';m.content='no-referrer';document.head.appendChild(m);}catch(e){}true;`;
const RANDOM_UUID_POLYFILL_SCRIPT = `
  (function () {
    try {
      var cryptoObj = globalThis.crypto;
      if (!cryptoObj || typeof cryptoObj.randomUUID === "function") return;
      function randomByte() {
        if (typeof cryptoObj.getRandomValues === "function") {
          var bytes = new Uint8Array(1);
          cryptoObj.getRandomValues(bytes);
          return bytes[0];
        }
        return Math.floor(Math.random() * 256);
      }
      Object.defineProperty(cryptoObj, "randomUUID", {
        configurable: true,
        value: function () {
          var bytes = new Uint8Array(16);
          for (var i = 0; i < bytes.length; i++) bytes[i] = randomByte();
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          var hex = [];
          for (var j = 0; j < bytes.length; j++) hex.push(bytes[j].toString(16).padStart(2, "0"));
          return [
            hex.slice(0, 4).join(""),
            hex.slice(4, 6).join(""),
            hex.slice(6, 8).join(""),
            hex.slice(8, 10).join(""),
            hex.slice(10, 16).join("")
          ].join("-");
        }
      });
    } catch (_) {}
  })();
`;

function serializeForInjection(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function buildBridgeBootstrapScript(panelInit: unknown, enableDebug: boolean): string {
  return `
    (function () {
      ${RANDOM_UUID_POLYFILL_SCRIPT}
      const panelInit = ${serializeForInjection(panelInit)};
      const pending = new Map();
      const listeners = new Map();
      let nextListenerId = 1;
      const enableDebug = ${enableDebug ? "true" : "false"};

      function ensureViewportMeta() {
        try {
          let meta = document.querySelector('meta[name="viewport"]');
          if (!meta) {
            meta = document.createElement("meta");
            meta.setAttribute("name", "viewport");
            const parent = document.head || document.documentElement;
            parent.appendChild(meta);
          }
          meta.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
        } catch (_) {}
      }
      ensureViewportMeta();

      function postDebug(level, args) {
        if (!enableDebug) return;
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            __natstackDebug: true,
            level,
            args: Array.isArray(args) ? args.map(function (value) {
              if (value instanceof Error) {
                return {
                  type: "error",
                  name: value.name,
                  message: value.message,
                  stack: value.stack || "",
                };
              }
              if (typeof value === "string") return value;
              try {
                return JSON.stringify(value);
              } catch (_) {
                return String(value);
              }
            }) : [],
          }));
        } catch (_) {}
      }

      let lastDocumentTitle = document.title || "";
      function shouldForwardTitle(title) {
        const trimmed = typeof title === "string" ? title.trim() : "";
        return trimmed.length > 0 && trimmed !== "Panel";
      }
      function postTitleChange(force) {
        try {
          const title = document.title || "";
          if (!force && title === lastDocumentTitle) return;
          lastDocumentTitle = title;
          if (!shouldForwardTitle(title)) return;
          window.ReactNativeWebView.postMessage(JSON.stringify({
            __natstackTitle: true,
            title,
          }));
        } catch (_) {}
      }
      function installTitleObserver() {
        try {
          const observer = new MutationObserver(function () {
            postTitleChange(false);
          });
          if (document.documentElement) {
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              characterData: true,
            });
          }
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
              postTitleChange(true);
            }, { once: true });
          } else {
            setTimeout(function () { postTitleChange(true); }, 0);
          }
        } catch (_) {}
      }
      installTitleObserver();

      if (enableDebug) {
        const originalConsole = globalThis.console || {};
        const wrapConsoleMethod = function (level) {
          const original = typeof originalConsole[level] === "function"
            ? originalConsole[level].bind(originalConsole)
            : null;
          return function () {
            const args = Array.prototype.slice.call(arguments);
            postDebug(level, args);
            if (original) {
              try { original.apply(null, args); } catch (_) {}
            }
          };
        };

        globalThis.console = {
          ...originalConsole,
          log: wrapConsoleMethod("log"),
          info: wrapConsoleMethod("info"),
          warn: wrapConsoleMethod("warn"),
          error: wrapConsoleMethod("error"),
        };

        globalThis.addEventListener("error", function (event) {
          postDebug("error", [
            event.message || "Unhandled error",
            event.error || event.filename || "unknown",
            event.error && event.error.stack ? event.error.stack : "",
          ]);
        });

        globalThis.addEventListener("unhandledrejection", function (event) {
          const reason = event.reason instanceof Error
            ? event.reason
            : (typeof event.reason === "string" ? event.reason : JSON.stringify(event.reason));
          postDebug("error", ["Unhandled promise rejection", reason]);
        });
      }

      function resolvePending(id, ok, payload) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) entry.resolve(payload);
        else entry.reject(new Error(typeof payload === "string" ? payload : "Bridge call failed"));
      }

      function dispatchEventToListeners(event, payload) {
        for (const listener of listeners.values()) {
          try { listener(event, payload); } catch (_) {}
        }
      }

      function callHost(method, args) {
        return new Promise(function(resolve, reject) {
          const id = "bridge-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
          pending.set(id, { resolve, reject });
          window.ReactNativeWebView.postMessage(JSON.stringify({
            __natstackBridge: true,
            id,
            method,
            args: Array.isArray(args) ? args : [],
          }));
        });
      }

      try {
        globalThis.__natstackPanelInit = panelInit;
        if (panelInit !== null) {
          sessionStorage.setItem("__natstackPanelInit", JSON.stringify(panelInit));
        }
      } catch (_) {}

      const shell = {
        getPanelInit: () => Promise.resolve(panelInit),
        getBootstrapConfig: () => Promise.resolve(panelInit),
        getInfo: () => callHost("getInfo", []),
        setStateArgs: (updates) => callHost("setStateArgs", [updates]),
        closeSelf: () => callHost("closeSelf", []),
        closeChild: (childId) => callHost("closeChild", [childId]),
        focusPanel: (panelId) => callHost("focusPanel", [panelId]),
        createBrowserPanel: (url, opts) => callHost("createBrowserPanel", [url, opts]),
        openDevtools: () => callHost("openDevtools", []),
        openFolderDialog: (opts) => callHost("openFolderDialog", [opts]),
        openExternal: (url, opts) => callHost("openExternal", [url, opts]),
        getCdpEndpoint: (id) => callHost("getCdpEndpoint", [id]),
        navigate: (id, url) => callHost("navigate", [id, url]),
        goBack: (id) => callHost("goBack", [id]),
        goForward: (id) => callHost("goForward", [id]),
        reload: (id) => callHost("reload", [id]),
        stop: (id) => callHost("stop", [id]),
        addEventListener: (handler) => {
          const id = nextListenerId++;
          listeners.set(id, handler);
          return id;
        },
        removeEventListener: (id) => {
          listeners.delete(id);
        },
      };

      globalThis.__natstackMobileHost = {
        resolvePending,
        dispatchEventToListeners,
      };
      globalThis.__natstackShell = shell;
      globalThis.__natstackElectron = shell;
    })();
    true;
  `;
}

export const PanelWebView = forwardRef<PanelWebViewHandle, PanelWebViewProps>(
  function PanelWebView(
    {
      panelId,
      url,
      visible,
      managed,
      panelInit,
      externalHost,
      onNavigationStateChange,
      onPanelNavigate,
      onTitleChange,
      onBridgeCall,
      onUnmount,
      diagnosticsEnabled = false,
      colors,
    },
    ref,
  ) {
    const webViewRef = useRef<WebView>(null);
    const [hasError, setHasError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    // Track the origin currently loaded in the WebView so we can verify that
    // host-bridge messages (handleMessage below) actually originate from a
    // managed panel page on our shell host. A redirect inside the same
    // WebView (e.g. via `handleShouldStartLoad` chaining or a meta-refresh)
    // would otherwise let an attacker-controlled origin invoke privileged
    // bridge methods (createBrowserPanel, openExternal, auth.startOAuthLogin,
    // etc.). Initialised to the configured panel URL.
    const currentUrlRef = useRef<string>(url);

    const logDiagnostic = useCallback((message: string, extra?: unknown) => {
      if (!diagnosticsEnabled) return;
      if (extra === undefined) {
        console.log(`[PanelWebView:${panelId}] ${message}`);
      } else {
        console.log(`[PanelWebView:${panelId}] ${message}`, extra);
      }
    }, [diagnosticsEnabled, panelId]);

    const dispatchHostEvent = useCallback((event: string, payload: unknown) => {
      if (!managed) return;
      webViewRef.current?.injectJavaScript(
        `window.__natstackMobileHost&&window.__natstackMobileHost.dispatchEventToListeners(${JSON.stringify(event)}, ${serializeForInjection(payload)}); true;`,
      );
    }, [managed]);

    useImperativeHandle(ref, () => ({
      injectTheme: (mode: "light" | "dark") => {
        dispatchHostEvent("runtime:theme", { theme: mode });
      },
      dispatchHostEvent,
    }), [dispatchHostEvent]);

    useEffect(() => {
      return () => {
        onUnmount?.(panelId);
      };
    }, [panelId, onUnmount]);

    const containerStyle = useMemo(
      () => [styles.container, !visible && styles.hidden],
      [visible],
    );

    const emitManagedNavigation = useCallback((requestUrl: string): boolean => {
      if (!isManagedHost(requestUrl, externalHost)) return false;
      const parsed = parsePanelUrl(requestUrl, externalHost);
      if (!parsed) return false;
      onPanelNavigate?.({
        type: "panel-switch",
        panelId,
        source: parsed.source,
        contextId: parsed.contextId,
        options: parsed.options,
        stateArgs: parsed.stateArgs,
      });
      return true;
    }, [externalHost, onPanelNavigate, panelId]);

    const handleShouldStartLoad = useCallback(
      (request: ShouldStartLoadRequest): boolean => {
        const { url: requestUrl, isTopFrame } = request;
        if (!isTopFrame) return true;
        if (requestUrl === url) return true;

        if (emitManagedNavigation(requestUrl)) {
          return false;
        }

        if (managed && /^https?:\/\//i.test(requestUrl)) {
          void onBridgeCall?.(panelId, "createBrowserPanel", [requestUrl, { focus: true }]);
          return false;
        }

        return true;
      },
      [emitManagedNavigation, managed, url],
    );

    const handleNavigationStateChange = useCallback(
      (navState: WebViewNavigation) => {
        logDiagnostic("navigation", {
          url: navState.url,
          loading: navState.loading,
          title: navState.title,
          canGoBack: navState.canGoBack,
          canGoForward: navState.canGoForward,
        });
        setIsLoading(navState.loading ?? false);
        if (typeof navState.url === "string" && navState.url.length > 0) {
          currentUrlRef.current = navState.url;
        }
        onNavigationStateChange?.(navState);
      },
      [logDiagnostic, onNavigationStateChange],
    );

    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
      if (!managed) return;

      // Origin check: bridge calls (createBrowserPanel, openExternal,
      // auth.startOAuthLogin, setStateArgs, ...) are only accepted when the
      // WebView is currently displaying a page on the managed shell host.
      // If the page redirected itself to an attacker origin, drop the
      // message. We prefer the event's nativeEvent.url (the source frame
      // origin reported by react-native-webview); fall back to the last
      // known top-level navigation URL.
      const sourceUrl = (event.nativeEvent as { url?: string }).url
        ?? currentUrlRef.current;
      if (!sourceUrl || !isManagedHost(sourceUrl, externalHost)) {
        console.warn(
          `[PanelWebView] Rejecting bridge message from non-managed origin: ${sourceUrl ?? "<unknown>"} (panel=${panelId})`,
        );
        return;
      }

      try {
        const message = JSON.parse(event.nativeEvent.data) as {
          __natstackBridge?: boolean;
          __natstackDebug?: boolean;
          __natstackDomSnapshot?: boolean;
          __natstackTitle?: boolean;
          id?: string;
          method?: string;
          args?: unknown[];
          level?: "log" | "info" | "warn" | "error";
          text?: string;
          childCount?: number;
          title?: string;
        };
        if (message.__natstackDebug) {
          if (!diagnosticsEnabled && !__DEV__) return;
          const level = message.level ?? "log";
          const parts = Array.isArray(message.args) ? message.args : [];
          const text = parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ");
          console[level](`[PanelWebView:${panelId}] ${text}`);
          return;
        }
        if (message.__natstackDomSnapshot) {
          if (!diagnosticsEnabled && !__DEV__) return;
          console.log(
            `[PanelWebView:${panelId}] DOM title=${message.title ?? ""} childCount=${message.childCount ?? 0} text=${message.text ?? ""}`,
          );
          return;
        }
        if (message.__natstackTitle) {
          const title = typeof message.title === "string" ? message.title.trim() : "";
          if (title.length > 0) {
            onTitleChange?.(panelId, title);
          }
          return;
        }
        if (!onBridgeCall) return;
        if (!message.__natstackBridge || !message.id || !message.method) return;

        try {
          const result = await onBridgeCall(panelId, message.method, message.args ?? []);
          webViewRef.current?.injectJavaScript(
            `window.__natstackMobileHost&&window.__natstackMobileHost.resolvePending(${JSON.stringify(message.id)}, true, ${serializeForInjection(result)}); true;`,
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          webViewRef.current?.injectJavaScript(
            `window.__natstackMobileHost&&window.__natstackMobileHost.resolvePending(${JSON.stringify(message.id)}, false, ${serializeForInjection(errorMessage)}); true;`,
          );
        }
      } catch {
        // Ignore non-bridge messages.
      }
    }, [diagnosticsEnabled, externalHost, managed, onBridgeCall, onTitleChange, panelId]);

    const handleError = useCallback(
      (syntheticEvent: { nativeEvent: { description?: string; code?: number } }) => {
        const { nativeEvent } = syntheticEvent;
        logDiagnostic("load error", nativeEvent);
        setHasError(true);
        setIsLoading(false);
        setErrorMessage(
          nativeEvent.description || `Failed to load panel (code ${nativeEvent.code ?? "unknown"})`,
        );
      },
      [logDiagnostic],
    );

    const handleHttpError = useCallback(
      (syntheticEvent: { nativeEvent: { statusCode: number; description: string } }) => {
        const { statusCode, description } = syntheticEvent.nativeEvent;
        logDiagnostic("http error", syntheticEvent.nativeEvent);
        if (statusCode >= 400) {
          setHasError(true);
          setIsLoading(false);
          setErrorMessage(`HTTP ${statusCode}: ${description || "Server error"}`);
        }
      },
      [logDiagnostic],
    );

    const handleRetry = useCallback(() => {
      setHasError(false);
      setIsLoading(true);
      setErrorMessage("");
      webViewRef.current?.reload();
    }, []);

    const handleLoadEnd = useCallback(() => {
      logDiagnostic("load end", { url: currentUrlRef.current });
      setIsLoading(false);
      if (!managed || (!diagnosticsEnabled && !__DEV__)) return;
      webViewRef.current?.injectJavaScript(`
        (function () {
          try {
            const text = (document.body && document.body.innerText ? document.body.innerText : "")
              .replace(/\\s+/g, " ")
              .trim()
              .slice(0, 500);
            const childCount = document.body ? document.body.children.length : 0;
            window.ReactNativeWebView.postMessage(JSON.stringify({
              __natstackDomSnapshot: true,
              title: document.title || "",
              childCount,
              text,
            }));
          } catch (error) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              __natstackDebug: true,
              level: "error",
              args: ["DOM snapshot failed", error instanceof Error ? error.message : String(error)],
            }));
          }
          true;
        })();
      `);
    }, [diagnosticsEnabled, logDiagnostic, managed]);

    const handleLoadStart = useCallback(
      (syntheticEvent: { nativeEvent: { url?: string } }) => {
        logDiagnostic("load start", syntheticEvent.nativeEvent);
      },
      [logDiagnostic],
    );

    const handleLoadProgress = useCallback(
      (syntheticEvent: { nativeEvent: { progress?: number; url?: string } }) => {
        const progress = syntheticEvent.nativeEvent.progress;
        if (progress === undefined || progress === 1 || progress < 0.05 || progress > 0.95) {
          logDiagnostic("load progress", syntheticEvent.nativeEvent);
        }
      },
      [logDiagnostic],
    );

    const handleRenderProcessGone = useCallback(
      (syntheticEvent: { nativeEvent: { didCrash?: boolean } }) => {
        logDiagnostic("render process gone", syntheticEvent.nativeEvent);
        setHasError(true);
        setIsLoading(false);
        setErrorMessage(
          syntheticEvent.nativeEvent.didCrash
            ? "Android WebView renderer crashed."
            : "Android WebView renderer was terminated.",
        );
      },
      [logDiagnostic],
    );

    if (hasError) {
      return (
        <View style={containerStyle}>
          <View style={[styles.errorContainer, colors?.background != null && { backgroundColor: colors.background }]}>
            <Text style={[styles.errorTitle, colors?.text != null && { color: colors.text }]}>Failed to load panel</Text>
            <Text style={[styles.errorMessage, colors?.textSecondary != null && { color: colors.textSecondary }]}>{errorMessage}</Text>
            <Pressable style={[styles.retryButton, colors?.primary != null && { backgroundColor: colors.primary }]} onPress={handleRetry}>
              <Text style={[styles.retryText, colors?.text != null && { color: colors.text }]}>Retry</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return (
      <View style={containerStyle}>
        {isLoading && (
          <View style={[styles.loadingOverlay, colors?.background != null && { backgroundColor: colors.background + "E6" }]}>
            <ActivityIndicator size="large" color={colors?.primary ?? "#1a73e8"} />
            <Text style={[styles.loadingText, colors?.textSecondary != null && { color: colors.textSecondary }]}>Loading panel...</Text>
          </View>
        )}
        <WebView
          ref={webViewRef}
          key={panelId}
          source={{ uri: url }}
          style={styles.webView}
          userAgent={NATSTACK_USER_AGENT}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onNavigationStateChange={handleNavigationStateChange}
          onMessage={handleMessage}
          onLoadStart={handleLoadStart}
          onLoadProgress={handleLoadProgress}
          onError={handleError}
          onHttpError={handleHttpError}
          onLoadEnd={handleLoadEnd}
          onRenderProcessGone={handleRenderProcessGone}
          injectedJavaScriptBeforeContentLoaded={managed ? buildBridgeBootstrapScript(panelInit, diagnosticsEnabled || __DEV__) : undefined}
          injectedJavaScript={REFERRER_POLICY_SCRIPT}
          scalesPageToFit={false}
          textZoom={100}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows
          onOpenWindow={(syntheticEvent) => {
            const { targetUrl } = syntheticEvent.nativeEvent;
            if (emitManagedNavigation(targetUrl)) return;
            if (managed && /^https?:\/\//i.test(targetUrl)) {
              void onBridgeCall?.(panelId, "createBrowserPanel", [targetUrl, { focus: true }]);
              return;
            }
            if (/^https?:\/\//i.test(targetUrl)) {
              void Linking.openURL(targetUrl);
            }
          }}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="never"
          allowsInlineMediaPlayback
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          pullToRefreshEnabled={false}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  hidden: {
    opacity: 0,
    pointerEvents: "none",
  } as const,
  webView: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(26, 26, 46, 0.9)",
    zIndex: 10,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: "#888",
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    backgroundColor: "#1a1a2e",
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#e0e0e0",
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: "#0f3460",
    borderRadius: 8,
  },
  retryText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
