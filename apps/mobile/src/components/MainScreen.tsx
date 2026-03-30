/**
 * MainScreen -- Panel content area with multi-WebView management.
 *
 * Sits inside the drawer navigator. Shows:
 * - ConnectionBar at the very top
 * - AppBar with hamburger, title, and "+" button
 * - Multi-WebView layer: up to MAX_WEBVIEWS live, LRU eviction
 * - Empty state when no panel is selected
 * - Android BackHandler for parent/exit navigation
 *
 * Panel tree is kept fresh via server-sent panel-tree-updated events,
 * with a 60s fallback poll. The drawer reads from panelTreeAtom and
 * activePanelIdAtom for display/highlight.
 */

import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, BackHandler, Platform, Linking, Appearance, Alert, ActivityIndicator } from "react-native";
import { useNavigation, DrawerActions } from "@react-navigation/native";
import { useAtomValue, useSetAtom } from "jotai";
import { ConnectionBar } from "./ConnectionBar";
import { AppBar } from "./AppBar";
import { PanelWebView } from "./PanelWebView";
import { WebViewErrorBoundary } from "./WebViewErrorBoundary";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import type { PanelWebViewHandle, PanelNavigationEvent } from "./PanelWebView";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { colorSchemeAtom, themeColorsAtom } from "../state/themeAtoms";
import {
  activePanelIdAtom,
  activePanelTitleAtom,
  activePanelParentIdAtom,
} from "../state/navigationAtoms";
import {
  buildPanelUrl,
  parseHostConfig,
  getExternalHost,
} from "../services/panelUrls";
import type { HostConfig } from "../services/panelUrls";
import type { Panel } from "@natstack/shared/types";

/** Maximum number of WebViews kept alive simultaneously */
const MAX_WEBVIEWS = 5;

/** Find a panel by source path in a nested tree */
function findPanelBySource(panels: Panel[], source: string): Panel | null {
  for (const panel of panels) {
    if (panel.snapshot.source === source) return panel;
    const found = findPanelBySource(panel.children, source);
    if (found) return found;
  }
  return null;
}

/** An entry in the WebView stack tracking the panel and its URL */
interface WebViewEntry {
  panelId: string;
  url: string;
  /** Timestamp of last activation -- used for LRU eviction */
  lastActive: number;
}

export function MainScreen() {
  const navigation = useNavigation();
  const shellClient = useAtomValue(shellClientAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const setColorScheme = useSetAtom(colorSchemeAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const activePanelTitle = useAtomValue(activePanelTitleAtom);
  const activePanelParentId = useAtomValue(activePanelParentIdAtom);
  const colors = useAtomValue(themeColorsAtom);

  // Wire app lifecycle management (AppState, NetInfo, cleanup)
  useAppLifecycle(shellClient);

  // Stack of live WebView entries
  const [webViewStack, setWebViewStack] = React.useState<WebViewEntry[]>([]);

  // Track the raw tree for panel lookups
  const rawTreeRef = useRef<Panel[]>([]);

  // Map of panelId -> PanelWebViewHandle ref for unload tracking and future use
  const webViewRefsMap = useRef<Map<string, PanelWebViewHandle | null>>(new Map());

  // Cache per-panel credentials to avoid repeated RPC calls
  const panelCredsCache = useRef<Map<string, { rpcToken: string; rpcPort: number }>>(new Map());

  // Track in-flight credential fetches to prevent duplicate requests
  const pendingCredentials = useRef<Set<string>>(new Set());

  // Loading state for panel activation feedback
  const [loadingPanelId, setLoadingPanelId] = useState<string | null>(null);

  // Listen for system theme changes.
  // Panels detect theme via CSS prefers-color-scheme in their WebViews,
  // which updates automatically when the OS theme changes. The
  // updateTheme() RPC call notifies the server for any server-side
  // theme-dependent logic (best-effort, may be a no-op in standalone).
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setColorScheme(colorScheme);
      if (shellClient) {
        const mode = colorScheme === "light" ? "light" : "dark";
        void shellClient.panels.updateTheme(mode);
      }
    });
    return () => subscription.remove();
  }, [shellClient, setColorScheme]);

  // Called when a PanelWebView unmounts (LRU eviction or screen teardown)
  const handleWebViewUnmount = useCallback(
    (panelId: string) => {
      webViewRefsMap.current.delete(panelId);
      if (shellClient) {
        void shellClient.panels.unload(panelId).catch(() => {});
      }
    },
    [shellClient],
  );

  // Parse host config from server URL (memoized)
  const hostConfig: HostConfig | null = useMemo(() => {
    if (!shellClient) return null;
    try {
      return parseHostConfig(shellClient.serverUrl);
    } catch {
      return null;
    }
  }, [shellClient]);

  const externalHost = useMemo(() => {
    return hostConfig ? getExternalHost(hostConfig) : "";
  }, [hostConfig]);

  // Read the local registry to update panelTreeAtom.
  const refreshTree = useCallback(() => {
    if (!shellClient) return;
    const tree = shellClient.panels.getTree();
    rawTreeRef.current = tree;
    setPanelTree(tree);
  }, [shellClient, setPanelTree]);

  /**
   * Activate a panel: create or bring its WebView to front.
   * If the stack exceeds MAX_WEBVIEWS, evict the least recently used.
   * Fetches per-panel credentials on first activation (cached thereafter).
   */
  const activatePanel = useCallback(
    (panelId: string) => {
      if (!shellClient || !hostConfig) return;

      const panel = shellClient.panels.registry.getPanel(panelId);
      if (!panel) return;

      const { source, contextId } = panel.snapshot;

      // If already in the stack, just bring to front (no credentials needed)
      setWebViewStack((prev) => {
        const existing = prev.find((e) => e.panelId === panelId);
        if (existing) {
          return prev.map((e) =>
            e.panelId === panelId ? { ...e, lastActive: Date.now() } : e,
          );
        }
        return prev;
      });

      setActivePanelId(panelId);

      // For new panels not yet in the stack, fetch credentials then add
      setWebViewStack((prev) => {
        if (prev.some((e) => e.panelId === panelId)) return prev;
        if (pendingCredentials.current.has(panelId)) return prev;

        const cached = panelCredsCache.current.get(panelId);
        if (cached) {
          const url = buildPanelUrl(panelId, source, contextId, cached.rpcToken, cached.rpcPort, hostConfig);
          const newEntry: WebViewEntry = { panelId, url, lastActive: Date.now() };
          let newStack = [...prev, newEntry];

          if (newStack.length > MAX_WEBVIEWS) {
            const candidates = newStack
              .filter((e) => e.panelId !== panelId)
              .sort((a, b) => a.lastActive - b.lastActive);
            const toEvict = candidates.length > 0 ? candidates[0]! : null;
            if (toEvict) {
              newStack = newStack.filter((e) => e.panelId !== toEvict.panelId);
            }
          }

          return newStack;
        }

        // No cached credentials — fetch async, then update stack
        pendingCredentials.current.add(panelId);
        setLoadingPanelId(panelId);
        void shellClient.panels.getCredentials(panelId).then((creds) => {
          pendingCredentials.current.delete(panelId);
          panelCredsCache.current.set(panelId, creds);
          const url = buildPanelUrl(panelId, source, contextId, creds.rpcToken, creds.rpcPort, hostConfig);
          const newEntry: WebViewEntry = { panelId, url, lastActive: Date.now() };
          setWebViewStack((current) => {
            if (current.some((e) => e.panelId === panelId)) return current;
            let newStack = [...current, newEntry];

            if (newStack.length > MAX_WEBVIEWS) {
              const candidates = newStack
                .filter((e) => e.panelId !== panelId)
                .sort((a, b) => a.lastActive - b.lastActive);
              const toEvict = candidates.length > 0 ? candidates[0]! : null;
              if (toEvict) {
                newStack = newStack.filter((e) => e.panelId !== toEvict.panelId);
              }
            }

            return newStack;
          });
          setLoadingPanelId(null);
        }).catch((err: unknown) => {
          pendingCredentials.current.delete(panelId);
          setLoadingPanelId(null);
          console.error(`[MainScreen] Failed to get credentials for panel ${panelId}:`, err);
        });

        return prev;
      });
    },
    [shellClient, hostConfig, setActivePanelId],
  );

  // Subscribe to panel-tree-updated events for reactive updates.
  // The server emits this event whenever the tree changes (panel create, close,
  // move, etc.). We also keep a 60s fallback poll for missed events.
  useEffect(() => {
    if (!shellClient) return;

    // Initial tree load
    refreshTree();

    // Subscribe to server events.
    // EventService prefixes channels with "event:" (eventsService.ts:123).
    const eventNames = [
      "panel-tree-updated",
      "navigate-to-panel",
      "open-external-requested",
      "notification:show",
    ] as const;
    const subscribeAll = () => {
      for (const name of eventNames) {
        void shellClient.events.subscribe(name).catch(() => {});
      }
    };
    subscribeAll();

    // Re-subscribe after reconnect (server destroys old WsSubscriber with old WebSocket)
    const unsubReconnect = shellClient.transport.onReconnect(() => {
      subscribeAll();
      void shellClient.panels.refresh().then(() => {
        refreshTree();
        // Reconcile: remove stale WebViews for panels no longer in the tree
        setWebViewStack(prev => {
          const filtered = prev.filter(e => shellClient.panels.registry.getPanel(e.panelId) !== undefined);
          return filtered.length === prev.length ? prev : filtered;
        });
        // Clear active panel if it was removed
        if (activePanelId && !shellClient.panels.registry.getPanel(activePanelId)) {
          setActivePanelId(null);
        }
        // Invalidate credential cache so panels get fresh tokens
        panelCredsCache.current.clear();
      }).catch(() => refreshTree());
    });

    // Tree updates: refresh cache then UI
    const unsubTree = shellClient.transport.onEvent("event:panel-tree-updated", () => {
      void shellClient.panels.refresh().then(() => refreshTree()).catch(() => refreshTree());
    });

    // Navigate-to-panel: standalone panels request focus on another panel
    const unsubNav = shellClient.transport.onEvent(
      "event:navigate-to-panel",
      (_from: string, payload: unknown) => {
        const { panelId } = payload as { panelId: string };
        if (panelId) activatePanel(panelId);
      },
    );

    // Open-external-requested: standalone panels want to open a URL in system browser
    const unsubExternal = shellClient.transport.onEvent(
      "event:open-external-requested",
      (_from: string, payload: unknown) => {
        const { url } = payload as { url: string };
        if (url) void Linking.openURL(url);
      },
    );

    // Notification: show an in-app alert for server-sent notifications.
    // Consent notifications (type: "consent") show Approve/Deny buttons and
    // report the action back to the server via notification.reportAction.
    const unsubNotification = shellClient.transport.onEvent(
      "event:notification:show",
      (_from: string, payload: unknown) => {
        const notif = payload as {
          id?: string;
          title?: string;
          message?: string;
          type?: string;
          consent?: { provider?: string; scopes?: string[]; callerTitle?: string };
        };

        if (notif.type === "consent" && notif.id) {
          const provider = notif.consent?.provider ?? "service";
          const scopes = notif.consent?.scopes?.join(", ") ?? "access";
          const callerTitle = notif.consent?.callerTitle ?? "A panel";
          Alert.alert(
            notif.title ?? "OAuth Access Requested",
            `${callerTitle} wants to connect to ${provider} (${scopes}).`,
            [
              {
                text: "Deny",
                style: "cancel",
                onPress: () => {
                  void shellClient.transport.call("main", "notification.reportAction", notif.id, "deny");
                },
              },
              {
                text: "Approve",
                onPress: () => {
                  void shellClient.transport.call("main", "notification.reportAction", notif.id, "approve");
                },
              },
              {
                text: "Always Allow",
                onPress: () => {
                  void shellClient.transport.call("main", "notification.reportAction", notif.id, "approve-workspace");
                },
              },
            ],
          );
        } else {
          Alert.alert(notif.title ?? "NatStack", notif.message ?? "");
        }
      },
    );

    // Fallback polling at 60s in case events are missed (reconnection gaps, etc.)
    const timer = setInterval(refreshTree, 60_000);

    return () => {
      clearInterval(timer);
      unsubReconnect();
      unsubTree();
      unsubNav();
      unsubExternal();
      unsubNotification();
      for (const name of eventNames) {
        void shellClient.events.unsubscribe(name).catch(() => {});
      }
    };
  }, [shellClient, refreshTree, activatePanel, activePanelId, setActivePanelId]);

  // Notify server when active panel changes
  useEffect(() => {
    if (activePanelId && shellClient) {
      void shellClient.panels.notifyFocused(activePanelId);
    }
  }, [activePanelId, shellClient]);

  // Sync atom -> WebView stack: when activePanelId changes, ensure WebView exists
  useEffect(() => {
    if (!activePanelId) return;
    // Check if already in stack or being fetched
    const inStack = webViewStack.some(e => e.panelId === activePanelId);
    const inFlight = pendingCredentials.current.has(activePanelId);
    if (!inStack && !inFlight) {
      activatePanel(activePanelId);
    }
  }, [activePanelId, webViewStack, activatePanel]);

  // === Drawer control ===
  const handleMenuPress = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  // === New panel creation ===
  const handlePanelCreated = useCallback(
    (panelId: string) => {
      activatePanel(panelId);
    },
    [activatePanel],
  );

  // === Panel-to-panel navigation from WebView ===
  const handlePanelNavigate = useCallback(
    (event: PanelNavigationEvent) => {
      console.log("[MainScreen] Panel navigation event:", event);

      // Search the current panel tree for a panel matching the navigation source
      const matchingPanel = findPanelBySource(rawTreeRef.current, event.source);
      if (matchingPanel) {
        activatePanel(matchingPanel.id);
      } else if (event.source.startsWith("about/")) {
        // Only use createAboutPanel for actual about/* pages
        if (shellClient) {
          const aboutPage = event.source.replace(/^about\//, "");
          void shellClient.panels.createAboutPanel(aboutPage).then((result) => {
            refreshTree();
            activatePanel(result.id);
          });
        }
      } else {
        // Unknown panel source -- open in system browser as a safe fallback.
        // Creating panels from arbitrary sources requires server-side build
        // infrastructure that may not be available for the requested source.
        if (externalHost) {
          const fallbackUrl = `https://${externalHost}/${event.source}`;
          console.log(`[MainScreen] No matching panel for "${event.source}", opening in browser: ${fallbackUrl}`);
          void Linking.openURL(fallbackUrl);
        } else {
          console.warn(`[MainScreen] No matching panel for "${event.source}" and no external host configured`);
        }
      }
    },
    [shellClient, activatePanel, refreshTree, externalHost],
  );

  // === Android BackHandler ===
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const onBackPress = () => {
      if (activePanelParentId) {
        activatePanel(activePanelParentId);
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  }, [activePanelParentId, activatePanel]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar />
      <AppBar
        title={activePanelTitle}
        onMenuPress={handleMenuPress}
        onPanelCreated={handlePanelCreated}
      />

      {/* Content area */}
      <View style={styles.contentArea}>
        {!activePanelId && (
          <View style={styles.placeholderContainer}>
            <Text style={[styles.placeholderText, { color: colors.textSecondary }]}>
              Select a panel from the drawer
            </Text>
            <Text style={[styles.placeholderSubtext, { color: colors.textSecondary }]}>
              Swipe from the left edge or tap the menu button
            </Text>
          </View>
        )}

        {loadingPanelId && loadingPanelId === activePanelId && !webViewStack.some(e => e.panelId === loadingPanelId) && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading panel...</Text>
          </View>
        )}

        {/* WebView layer -- all live WebViews rendered, only active one visible */}
        {webViewStack.map((entry) => (
          <WebViewErrorBoundary
            key={entry.panelId}
            panelId={entry.panelId}
            colors={{
              background: colors.background,
              text: colors.text,
              textSecondary: colors.textSecondary,
              accent: colors.primary,
              accentText: colors.text,
            }}
          >
            <PanelWebView
              ref={(handle) => {
                if (handle) {
                  webViewRefsMap.current.set(entry.panelId, handle);
                }
              }}
              panelId={entry.panelId}
              url={entry.url}
              visible={entry.panelId === activePanelId}
              externalHost={externalHost}
              onPanelNavigate={handlePanelNavigate}
              onUnmount={handleWebViewUnmount}
              colors={{
                background: colors.background,
                text: colors.text,
                textSecondary: colors.textSecondary,
                primary: colors.primary,
              }}
            />
          </WebViewErrorBoundary>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentArea: {
    flex: 1,
  },
  placeholderContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  placeholderText: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 8,
  },
  placeholderSubtext: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  loadingText: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
  },
});
