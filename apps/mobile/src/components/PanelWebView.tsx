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
  onBridgeCall?: (panelId: string, method: string, args: unknown[]) => Promise<unknown>;
  onUnmount?: (panelId: string) => void;
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    primary?: string;
  };
}

const NATSTACK_USER_AGENT = `NatStack-Mobile/1.0 (${Platform.OS}; ${Platform.Version})`;
const REFERRER_POLICY_SCRIPT = `try{var m=document.createElement('meta');m.name='referrer';m.content='no-referrer';document.head.appendChild(m);}catch(e){}true;`;

function serializeForInjection(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function buildBridgeBootstrapScript(panelInit: unknown): string {
  return `
    (function () {
      const panelInit = ${serializeForInjection(panelInit)};
      const pending = new Map();
      const listeners = new Map();
      let nextListenerId = 1;

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
        openExternal: (url) => callHost("openExternal", [url]),
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
      onBridgeCall,
      onUnmount,
      colors,
    },
    ref,
  ) {
    const webViewRef = useRef<WebView>(null);
    const [hasError, setHasError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");

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
        setIsLoading(navState.loading ?? false);
        onNavigationStateChange?.(navState);
      },
      [onNavigationStateChange],
    );

    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
      if (!managed || !onBridgeCall) return;

      try {
        const message = JSON.parse(event.nativeEvent.data) as {
          __natstackBridge?: boolean;
          id?: string;
          method?: string;
          args?: unknown[];
        };
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
    }, [managed, onBridgeCall, panelId]);

    const handleError = useCallback(
      (syntheticEvent: { nativeEvent: { description?: string; code?: number } }) => {
        const { nativeEvent } = syntheticEvent;
        setHasError(true);
        setIsLoading(false);
        setErrorMessage(
          nativeEvent.description || `Failed to load panel (code ${nativeEvent.code ?? "unknown"})`,
        );
      },
      [],
    );

    const handleHttpError = useCallback(
      (syntheticEvent: { nativeEvent: { statusCode: number; description: string } }) => {
        const { statusCode, description } = syntheticEvent.nativeEvent;
        if (statusCode >= 400) {
          setHasError(true);
          setIsLoading(false);
          setErrorMessage(`HTTP ${statusCode}: ${description || "Server error"}`);
        }
      },
      [],
    );

    const handleRetry = useCallback(() => {
      setHasError(false);
      setIsLoading(true);
      setErrorMessage("");
      webViewRef.current?.reload();
    }, []);

    const handleLoadEnd = useCallback(() => {
      setIsLoading(false);
    }, []);

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
          onError={handleError}
          onHttpError={handleHttpError}
          onLoadEnd={handleLoadEnd}
          injectedJavaScriptBeforeContentLoaded={managed ? buildBridgeBootstrapScript(panelInit) : undefined}
          injectedJavaScript={REFERRER_POLICY_SCRIPT}
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
          mixedContentMode="compatibility"
          allowsInlineMediaPlayback
          allowFileAccess
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
