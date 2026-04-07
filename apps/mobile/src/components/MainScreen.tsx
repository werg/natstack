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
const MAX_WEBVIEWS = 5;

interface WebViewEntry {
  panelId: string;
  url: string;
  managed: boolean;
  panelInit: unknown | null;
  lastActive: number;
}

function addWebViewEntry(entries: WebViewEntry[], nextEntry: WebViewEntry): WebViewEntry[] {
  const withoutExisting = entries.filter((entry) => entry.panelId !== nextEntry.panelId);
  let nextEntries = [...withoutExisting, nextEntry];
  if (nextEntries.length <= MAX_WEBVIEWS) return nextEntries;
  const candidates = nextEntries
    .filter((entry) => entry.panelId !== nextEntry.panelId)
    .sort((a, b) => a.lastActive - b.lastActive);
  const toEvict = candidates[0];
  return toEvict ? nextEntries.filter((entry) => entry.panelId !== toEvict.panelId) : nextEntries;
}

export function MainScreen() {
  const navigation = useNavigation();
  const shellClient = useAtomValue(shellClientAtom);
  const panelTree = useAtomValue(panelTreeAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const setColorScheme = useSetAtom(colorSchemeAtom);
  const colorScheme = useAtomValue(colorSchemeAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const activePanelTitle = useAtomValue(activePanelTitleAtom);
  const activePanelParentId = useAtomValue(activePanelParentIdAtom);
  const colors = useAtomValue(themeColorsAtom);

  useAppLifecycle(shellClient);

  const [webViewStack, setWebViewStack] = useState<WebViewEntry[]>([]);
  const [loadingPanelId, setLoadingPanelId] = useState<string | null>(null);
  const webViewStackRef = useRef<WebViewEntry[]>([]);
  const webViewRefsMap = useRef<Map<string, PanelWebViewHandle | null>>(new Map());
  const pendingPanelLoads = useRef<Set<string>>(new Set());

  useEffect(() => {
    webViewStackRef.current = webViewStack;
  }, [webViewStack]);

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme: nextScheme }) => {
      setColorScheme(nextScheme);
      if (shellClient) {
        const mode = nextScheme === "light" ? "light" : "dark";
        void shellClient.panels.updateTheme(mode);
      }
    });
    return () => subscription.remove();
  }, [shellClient, setColorScheme]);

  const handleWebViewUnmount = useCallback(
    (panelId: string) => {
      webViewRefsMap.current.delete(panelId);
      if (shellClient) {
        void shellClient.panels.unload(panelId).catch(() => {});
      }
    },
    [shellClient],
  );

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

  const refreshTree = useCallback(() => {
    if (!shellClient) return;
    const tree = shellClient.panels.getTree();
    setPanelTree(tree);
    setWebViewStack((prev) => prev.filter((entry) => shellClient.panels.registry.getPanel(entry.panelId) !== undefined));
  }, [shellClient, setPanelTree]);

  const activatePanel = useCallback((panelId: string) => {
    if (!shellClient || !hostConfig) return;

    const panel = shellClient.panels.registry.getPanel(panelId);
    if (!panel) return;

    setActivePanelId(panelId);
    setWebViewStack((prev) => prev.map((entry) =>
      entry.panelId === panelId ? { ...entry, lastActive: Date.now() } : entry,
    ));

    if (pendingPanelLoads.current.has(panelId) || webViewStackRef.current.some((entry) => entry.panelId === panelId)) {
      return;
    }

    pendingPanelLoads.current.add(panelId);
    setLoadingPanelId(panelId);

    void (async () => {
      const source = panel.snapshot.source;
      const managed = !source.startsWith("browser:");
      const url = managed
        ? buildPanelUrl(source, panel.snapshot.contextId, hostConfig)
        : source.slice("browser:".length);
      const panelInit = managed
        ? await shellClient.panels.getPanelInit(panelId)
        : null;

      setWebViewStack((prev) => addWebViewEntry(prev, {
        panelId,
        url,
        managed,
        panelInit,
        lastActive: Date.now(),
      }));
    })().catch((err: unknown) => {
      console.error(`[MainScreen] Failed to activate panel ${panelId}:`, err);
    }).finally(() => {
      pendingPanelLoads.current.delete(panelId);
      setLoadingPanelId((current) => current === panelId ? null : current);
    });
  }, [hostConfig, shellClient, setActivePanelId]);

  useEffect(() => {
    if (!shellClient) return;

    refreshTree();

    const eventNames = [
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

    const unsubReconnect = shellClient.transport.onReconnect(() => {
      subscribeAll();
      void shellClient.panels.refresh().then(() => {
        refreshTree();
      }).catch(() => refreshTree());
    });

    const unsubNavigate = shellClient.onNavigateToPanel((panelId) => {
      refreshTree();
      activatePanel(panelId);
    });

    const unsubNav = shellClient.transport.onEvent(
      "event:navigate-to-panel",
      (_from: string, payload: unknown) => {
        const { panelId } = payload as { panelId: string };
        if (panelId) activatePanel(panelId);
      },
    );

    const unsubExternal = shellClient.transport.onEvent(
      "event:open-external-requested",
      (_from: string, payload: unknown) => {
        const { url } = payload as { url: string };
        if (url) void Linking.openURL(url);
      },
    );

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

    const timer = setInterval(refreshTree, 60_000);

    return () => {
      clearInterval(timer);
      unsubReconnect();
      unsubNavigate();
      unsubNav();
      unsubExternal();
      unsubNotification();
      for (const name of eventNames) {
        void shellClient.events.unsubscribe(name).catch(() => {});
      }
    };
  }, [activatePanel, refreshTree, shellClient]);

  useEffect(() => {
    if (!activePanelId || !shellClient) return;
    void shellClient.panels.notifyFocused(activePanelId);
    webViewRefsMap.current.get(activePanelId)?.dispatchHostEvent("runtime:focus", null);
  }, [activePanelId, shellClient]);

  useEffect(() => {
    const mode = colorScheme === "light" ? "light" : "dark";
    for (const entry of webViewStack) {
      if (!entry.managed) continue;
      webViewRefsMap.current.get(entry.panelId)?.injectTheme(mode);
    }
  }, [colorScheme, webViewStack]);

  useEffect(() => {
    if (!activePanelId) return;
    if (!webViewStack.some((entry) => entry.panelId === activePanelId) &&
        !pendingPanelLoads.current.has(activePanelId)) {
      activatePanel(activePanelId);
    }
  }, [activePanelId, activatePanel, webViewStack]);

  useEffect(() => {
    if (!shellClient) return;
    if (activePanelId && shellClient.panels.registry.getPanel(activePanelId)) return;
    const firstRoot = shellClient.panels.registry.getRootPanels()[0];
    setActivePanelId(firstRoot?.id ?? null);
  }, [activePanelId, panelTree, setActivePanelId, shellClient]);

  const handleMenuPress = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const handlePanelCreated = useCallback((panelId: string) => {
    activatePanel(panelId);
  }, [activatePanel]);

  const handlePanelNavigate = useCallback((event: PanelNavigationEvent) => {
    if (!shellClient) return;

    void shellClient.panels.createChildPanel(event.panelId, event.source, {
      name: event.options.name,
      contextId: event.contextId ?? event.options.contextId,
      focus: event.options.focus,
      stateArgs: event.stateArgs,
    }).then((result) => {
      refreshTree();
      if (event.options.focus !== false) {
        activatePanel(result.id);
      }
    }).catch((error: unknown) => {
      Alert.alert(
        "Panel Navigation Failed",
        error instanceof Error ? error.message : "Could not open panel.",
      );
    });
  }, [activatePanel, refreshTree, shellClient]);

  const handleBridgeCall = useCallback(async (panelId: string, method: string, args: unknown[]) => {
    if (!shellClient) throw new Error("Shell client not available");
    const result = await shellClient.handlePanelBridgeCall(panelId, method, args);
    refreshTree();
    return result;
  }, [refreshTree, shellClient]);

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

        {loadingPanelId && loadingPanelId === activePanelId && !webViewStack.some((entry) => entry.panelId === loadingPanelId) && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading panel...</Text>
          </View>
        )}

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
              managed={entry.managed}
              panelInit={entry.panelInit}
              externalHost={externalHost}
              onPanelNavigate={handlePanelNavigate}
              onBridgeCall={handleBridgeCall}
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
