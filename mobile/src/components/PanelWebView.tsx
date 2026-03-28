/**
 * PanelWebView -- WebView wrapper for displaying a NatStack panel.
 *
 * Wraps react-native-webview with NatStack-specific behavior:
 * - Cookie isolation: sharedCookiesEnabled=false, thirdPartyCookiesEnabled=false
 *   to prevent cross-panel cookie leakage (auth is via query params)
 * - Show/hide via display style (keeps WebView alive when hidden)
 * - Navigation interception: panel URLs -> switch panel, external -> system browser
 * - window.open() interception via onOpenWindow
 * - Theme injection via imperative injectTheme() method
 * - Cleanup notification via onUnmount callback
 * - User agent identification for the NatStack mobile client
 * - Error handling with retry button on load failure
 */

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
} from "react-native-webview/lib/WebViewTypes";
import { isManagedHost, parsePanelUrl } from "../services/panelUrls";

/** Navigation event emitted when the WebView tries to navigate to another panel */
export interface PanelNavigationEvent {
  type: "panel-switch";
  /** The parsed panel URL info */
  source: string;
  contextId?: string;
}

/** Methods exposed via ref to parent components */
export interface PanelWebViewHandle {
  /** Inject a theme change notification into the WebView */
  injectTheme: (mode: "light" | "dark") => void;
}

export interface PanelWebViewProps {
  /** Unique panel ID */
  panelId: string;
  /** Full URL to load in the WebView */
  url: string;
  /** Whether this WebView is the active (visible) panel */
  visible: boolean;
  /** The external host for detecting managed URLs (e.g. "natstack.example.com") */
  externalHost: string;
  /** Called when navigation state changes (loading, title, url, etc.) */
  onNavigationStateChange?: (navState: WebViewNavigation) => void;
  /** Called when the WebView attempts to navigate to another panel */
  onPanelNavigate?: (event: PanelNavigationEvent) => void;
  /** Called when the WebView component unmounts (for cleanup/metrics) */
  onUnmount?: (panelId: string) => void;
}

const NATSTACK_USER_AGENT = `NatStack-Mobile/1.0 (${Platform.OS}; ${Platform.Version})`;

export const PanelWebView = forwardRef<PanelWebViewHandle, PanelWebViewProps>(
  function PanelWebView(
    {
      panelId,
      url,
      visible,
      externalHost,
      onNavigationStateChange,
      onPanelNavigate,
      onUnmount,
    },
    ref,
  ) {
  const webViewRef = useRef<WebView>(null);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  // Expose imperative methods to parent via ref
  useImperativeHandle(ref, () => ({
    injectTheme: (mode: "light" | "dark") => {
      webViewRef.current?.injectJavaScript(
        `window.postMessage(${JSON.stringify(JSON.stringify({ type: "theme-changed", theme: { mode } }))}, '*'); true;`,
      );
    },
  }), []);

  // Notify parent when this WebView unmounts (eviction or screen teardown)
  useEffect(() => {
    return () => {
      onUnmount?.(panelId);
    };
  }, [panelId, onUnmount]);

  // Memoize the container style to avoid re-renders
  const containerStyle = useMemo(
    () => [styles.container, !visible && styles.hidden],
    [visible],
  );

  /**
   * Intercept navigation requests to handle:
   * 1. Panel-to-panel navigation (detected via parsePanelUrl)
   * 2. External URLs (open in system browser)
   * 3. Same-origin navigation (allow normally)
   */
  const handleShouldStartLoad = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      const { url: requestUrl, isTopFrame } = request;

      // Only intercept top-frame navigations, not iframes/resources
      if (!isTopFrame) return true;

      // Always allow the initial URL load
      if (requestUrl === url) return true;

      // Check if it's a managed host URL (panel URL)
      if (isManagedHost(requestUrl, externalHost)) {
        // Try to parse as a panel URL (clean panel link, not a bootstrapped URL)
        const parsed = parsePanelUrl(requestUrl, externalHost);
        if (parsed) {
          // This is a panel-to-panel navigation -- emit event instead of navigating
          onPanelNavigate?.({
            type: "panel-switch",
            source: parsed.source,
            contextId: parsed.contextId,
          });
          return false;
        }
        // It's a managed URL but already bootstrapped (has _bk/pid params)
        // or is a non-panel resource -- allow normal navigation
        return true;
      }

      // External URL -- open in system browser
      if (/^https?:\/\//i.test(requestUrl)) {
        void Linking.openURL(requestUrl);
        return false;
      }

      // Allow other schemes (about:, blob:, data:, etc.)
      return true;
    },
    [url, externalHost, onPanelNavigate],
  );

  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      setIsLoading(navState.loading ?? false);
      onNavigationStateChange?.(navState);
    },
    [onNavigationStateChange],
  );

  const handleError = useCallback(
    (syntheticEvent: { nativeEvent: { description?: string; code?: number; url?: string } }) => {
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
    (syntheticEvent: { nativeEvent: { statusCode: number; url: string; description: string } }) => {
      const { statusCode, description } = syntheticEvent.nativeEvent;
      // Only show error for significant HTTP errors on the main frame
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
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Failed to load panel</Text>
          <Text style={styles.errorMessage}>{errorMessage}</Text>
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#1a73e8" />
          <Text style={styles.loadingText}>Loading panel...</Text>
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
        onError={handleError}
        onHttpError={handleHttpError}
        onLoadEnd={handleLoadEnd}
        // === Cookie isolation (Sub-task 1) ===
        // Auth is passed via query params (pid, rpcPort, rpcToken, rpcHost),
        // so we don't rely on cookies. Disable cookie sharing to prevent
        // panel A's cookies from leaking to panel B.
        // iOS: sharedCookiesEnabled=false gives each WebView its own WKDataStore
        sharedCookiesEnabled={false}
        // Android: thirdPartyCookiesEnabled=false prevents cross-WebView cookie access
        thirdPartyCookiesEnabled={false}
        // === window.open() interception ===
        // Android requires setSupportMultipleWindows for onOpenWindow to fire.
        // Without it, window.open() navigates the current WebView instead.
        // Setting it on iOS is harmless (iOS uses a different mechanism).
        setSupportMultipleWindows
        // Panels may call window.open() to create child panels. Intercept
        // and route panel URLs to the panel tree, external URLs to system browser.
        onOpenWindow={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          const { targetUrl } = nativeEvent;

          // Check if it's a managed panel URL
          if (isManagedHost(targetUrl, externalHost)) {
            const parsed = parsePanelUrl(targetUrl, externalHost);
            if (parsed) {
              onPanelNavigate?.({
                type: "panel-switch",
                source: parsed.source,
                contextId: parsed.contextId,
              });
              return;
            }
          }

          // External URL -- open in system browser
          if (/^https?:\/\//i.test(targetUrl)) {
            void Linking.openURL(targetUrl);
          }
        }}
        // Allow JavaScript and DOM storage for panels
        javaScriptEnabled
        domStorageEnabled
        // Allow mixed content in dev (HTTP resources on HTTPS pages)
        mixedContentMode="compatibility"
        // Allow inline media playback on iOS
        allowsInlineMediaPlayback
        // Enable file access for panels that need it
        allowFileAccess
        // Pull-to-refresh is not appropriate for panels
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
    // Keep the WebView mounted but invisible. Using display: "none" unmounts
    // on some RN versions; instead use opacity + pointerEvents.
    opacity: 0,
    // Move off-screen to avoid hit-test issues while hidden
    position: "absolute",
    left: -9999,
    top: -9999,
    width: 1,
    height: 1,
  },
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
