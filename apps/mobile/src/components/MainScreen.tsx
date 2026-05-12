import React, { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, BackHandler, Platform, Linking, Appearance, ActivityIndicator } from "react-native";
import { useNavigation, DrawerActions } from "@react-navigation/native";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ConnectionBar } from "./ConnectionBar";
import { AppBar } from "./AppBar";
import { PanelWebView } from "./PanelWebView";
import { WebViewErrorBoundary } from "./WebViewErrorBoundary";
import { ApprovalSheet } from "./ApprovalSheet";
import { Toast } from "./Toast";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import type { PanelWebViewHandle, PanelNavigationEvent } from "./PanelWebView";
import type { WebViewNavigation } from "react-native-webview/lib/WebViewTypes";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { colorSchemeAtom, themeColorsAtom } from "../state/themeAtoms";
import { approvalDeepLinkAtom } from "../state/approvalDeepLinkAtom";
import { pushToastAtom } from "../state/toastAtoms";
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
import {
  buildPanelChromeState,
  formatRepoChip,
  isBrowserPanelSource,
  parseAddressInput,
  type PanelRepoState,
} from "@natstack/shared/panelChrome";
import type { HostConfig } from "../services/panelUrls";
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
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
  const nextEntries = [...withoutExisting, nextEntry];
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
  const [approvalDeepLinkId, setApprovalDeepLinkId] = useAtom(approvalDeepLinkAtom);
  const pushToast = useSetAtom(pushToastAtom);

  useAppLifecycle(shellClient);

  const [webViewStack, setWebViewStack] = useState<WebViewEntry[]>([]);
  const [loadingPanelId, setLoadingPanelId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [addressBarVisible, setAddressBarVisible] = useState(false);
  const [webViewNavigation, setWebViewNavigation] = useState<Record<string, WebViewNavigation>>({});
  const [activeRepoState, setActiveRepoState] = useState<PanelRepoState | undefined>();
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

  const visibleApprovals = useMemo(() => {
    if (!approvalDeepLinkId) return pendingApprovals;
    const linked = pendingApprovals.find((approval) => approval.approvalId === approvalDeepLinkId);
    if (!linked) return pendingApprovals;
    return [linked, ...pendingApprovals.filter((approval) => approval.approvalId !== approvalDeepLinkId)];
  }, [approvalDeepLinkId, pendingApprovals]);

  const activePanel = useMemo(() => {
    if (!activePanelId || !shellClient) return null;
    return shellClient.panels.registry.getPanel(activePanelId) ?? null;
  }, [activePanelId, panelTree, shellClient]);

  const activeChromeState = useMemo(() => {
    if (!activePanel) return null;
    const nav = activePanelId ? webViewNavigation[activePanelId] : undefined;
    return buildPanelChromeState({
      panel: {
        ...activePanel,
        navigation: nav ? {
          url: nav.url,
          pageTitle: nav.title,
          isLoading: nav.loading,
          canGoBack: nav.canGoBack,
          canGoForward: nav.canGoForward,
        } : activePanel.navigation,
      },
      repo: activeRepoState,
    });
  }, [activePanel, activePanelId, activeRepoState, webViewNavigation]);

  useEffect(() => {
    if (!activePanel || !shellClient || isBrowserPanelSource(activePanel.snapshot.source) || activePanel.snapshot.source.startsWith("about/")) {
      setActiveRepoState(undefined);
      return;
    }

    let cancelled = false;
    const source = activePanel.snapshot.source;
    void Promise.all([
      shellClient.transport.call<Array<{ name: string; current?: boolean }>>("main", "git.listBranches", source),
      shellClient.transport.call<string>("main", "git.resolveRef", source, "HEAD"),
    ]).then(([branches, commit]) => {
      if (cancelled) return;
      setActiveRepoState({
        repoPath: source,
        branch: branches.find((branch) => branch.current)?.name ?? null,
        commit,
      });
    }).catch(() => {
      if (!cancelled) setActiveRepoState({ repoPath: source });
    });
    return () => {
      cancelled = true;
    };
  }, [activePanel, shellClient]);

  useEffect(() => {
    if (!approvalDeepLinkId) return;
    if (pendingApprovals.some((approval) => approval.approvalId === approvalDeepLinkId)) {
      setApprovalDeepLinkId(null);
    }
  }, [approvalDeepLinkId, pendingApprovals, setApprovalDeepLinkId]);

  useEffect(() => {
    if (!shellClient) {
      setPendingApprovals([]);
    }
  }, [shellClient]);

  const refreshTree = useCallback(() => {
    if (!shellClient) return;
    const tree = shellClient.panels.getTree();
    setPanelTree(tree);
    setWebViewStack((prev) => prev.filter((entry) => shellClient.panels.registry.getPanel(entry.panelId) !== undefined));
  }, [shellClient, setPanelTree]);

  const refreshPendingApprovals = useCallback(async () => {
    if (!shellClient) {
      setPendingApprovals([]);
      return [];
    }
    const pending = await shellClient.transport.call<PendingApproval[]>(
      "main",
      RPC_METHODS.shellApproval.listPending,
    );
    setPendingApprovals(pending);
    return pending;
  }, [shellClient]);

  const removeResolvedApproval = useCallback((approvalId: string) => {
    setPendingApprovals((current) => current.filter((approval) => approval.approvalId !== approvalId));
  }, []);

  const resolveApproval = useCallback(async (approvalId: string, decision: ApprovalDecision) => {
    if (!shellClient) throw new Error("Shell client not available");
    await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolve, approvalId, decision);
    removeResolvedApproval(approvalId);
  }, [removeResolvedApproval, shellClient]);

  const submitClientConfig = useCallback(async (approvalId: string, values: Record<string, string>) => {
    if (!shellClient) throw new Error("Shell client not available");
    await shellClient.transport.call("main", RPC_METHODS.shellApproval.submitClientConfig, approvalId, values);
    removeResolvedApproval(approvalId);
  }, [removeResolvedApproval, shellClient]);

  const submitCredentialInput = useCallback(async (approvalId: string, values: Record<string, string>) => {
    if (!shellClient) throw new Error("Shell client not available");
    await shellClient.transport.call("main", RPC_METHODS.shellApproval.submitCredentialInput, approvalId, values);
    removeResolvedApproval(approvalId);
  }, [removeResolvedApproval, shellClient]);

  const resolveUserland = useCallback(async (approvalId: string, choice: string | "dismiss") => {
    if (!shellClient) throw new Error("Shell client not available");
    await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolveUserland, approvalId, choice);
    removeResolvedApproval(approvalId);
  }, [removeResolvedApproval, shellClient]);

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
      if (hostConfig.protocol === "http") {
        console.log(`[MainScreen] Activating panel ${panelId}`, { source, url, managed });
      }

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
      "external-open:open",
      "notification:show",
      "shell-approval:pending-changed",
    ] as const;
    const subscribeAll = () => {
      for (const name of eventNames) {
        void shellClient.events.subscribe(name).catch(() => {});
      }
    };
    subscribeAll();

    const unsubReconnect = shellClient.transport.onReconnect(() => {
      subscribeAll();
      void refreshPendingApprovals().catch(() => {});
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

    void refreshPendingApprovals().catch(() => {});

    const unsubExternal = shellClient.transport.onEvent(
      "event:external-open:open",
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
          pushToast({
            title: notif.title ?? "OAuth access requested",
            message: `${callerTitle} wants to connect to ${provider} (${scopes}).`,
            tone: "info",
          });
        } else {
          pushToast({
            title: notif.title ?? "NatStack",
            message: notif.message ?? "",
            tone: "info",
          });
        }
      },
    );

    const unsubApproval = shellClient.transport.onEvent(
      "event:shell-approval:pending-changed",
      (_from: string, payload: unknown) => {
        const { pending } = payload as { pending?: PendingApproval[] };
        setPendingApprovals(pending ?? []);
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
      unsubApproval();
      for (const name of eventNames) {
        void shellClient.events.unsubscribe(name).catch(() => {});
      }
    };
  }, [activatePanel, pushToast, refreshPendingApprovals, refreshTree, shellClient]);

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

  const handleActiveBack = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.goBack();
  }, [activePanelId]);

  const handleActiveForward = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.goForward();
  }, [activePanelId]);

  const handleActiveReload = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.reload();
  }, [activePanelId]);

  const handleActiveStop = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.stop();
  }, [activePanelId]);

  const handleNavigateAddress = useCallback((value: string) => {
    if (!shellClient || !activePanelId) return;
    const parsed = parseAddressInput(value);
    if (!parsed) return;

    if (parsed.type === "browser-url") {
      const active = shellClient.panels.registry.getPanel(activePanelId);
      if (active && isBrowserPanelSource(active.snapshot.source)) {
        setWebViewStack((prev) => prev.map((entry) =>
          entry.panelId === activePanelId ? { ...entry, url: parsed.url } : entry,
        ));
        setWebViewNavigation((prev) => ({
          ...prev,
          [activePanelId]: { ...(prev[activePanelId] as WebViewNavigation | undefined), url: parsed.url } as WebViewNavigation,
        }));
      } else {
        void shellClient.panels.createBrowserPanel(activePanelId, parsed.url, { focus: true })
          .catch((error: unknown) => pushToast({
            title: "Navigation failed",
            message: error instanceof Error ? error.message : "Could not open browser panel.",
            tone: "danger",
          }));
      }
      return;
    }

    if (parsed.type === "panel-source") {
      void shellClient.panels.createFromSource(parsed.source)
        .then((result) => activatePanel(result.id))
        .catch((error: unknown) => pushToast({
          title: "Navigation failed",
          message: error instanceof Error ? error.message : "Could not open panel.",
          tone: "danger",
        }));
      return;
    }

    if (parsed.type === "search") {
      const url = `https://www.google.com/search?q=${encodeURIComponent(parsed.query)}`;
      void shellClient.panels.createBrowserPanel(activePanelId, url, { focus: true })
        .catch((error: unknown) => pushToast({
          title: "Navigation failed",
          message: error instanceof Error ? error.message : "Could not search.",
          tone: "danger",
        }));
    }
  }, [activatePanel, activePanelId, pushToast, shellClient]);

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
      pushToast({
        title: "Panel navigation failed",
        message: error instanceof Error ? error.message : "Could not open panel.",
        tone: "danger",
      });
    });
  }, [activatePanel, pushToast, refreshTree, shellClient]);

  const handlePanelTitleChange = useCallback((panelId: string, title: string) => {
    if (!shellClient) return;
    void shellClient.panels.updateTitle(panelId, title)
      .then(refreshTree)
      .catch((error: unknown) => {
        console.warn(
          `[MainScreen] Failed to update title for panel ${panelId}:`,
          error,
        );
      });
  }, [refreshTree, shellClient]);

  const handleBridgeCall = useCallback(async (panelId: string, method: string, args: unknown[]) => {
    if (!shellClient) throw new Error("Shell client not available");
    const result = await shellClient.handlePanelBridgeCall(panelId, method, args);
    refreshTree();
    return result;
  }, [refreshTree, shellClient]);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const onBackPress = () => {
      if (activePanelId && webViewNavigation[activePanelId]?.canGoBack) {
        webViewRefsMap.current.get(activePanelId)?.goBack();
        return true;
      }
      if (activePanelParentId) {
        activatePanel(activePanelParentId);
        return true;
      }
      return false;
    };

    const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => subscription.remove();
  }, [activePanelId, activePanelParentId, activatePanel, webViewNavigation]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar />
      <AppBar
        title={activePanelTitle}
        onMenuPress={handleMenuPress}
        onPanelCreated={handlePanelCreated}
        addressBarVisible={addressBarVisible}
        address={activeChromeState?.editableAddress ?? ""}
        metadata={activeChromeState?.kind === "panel" ? formatRepoChip(activeChromeState.repo) : null}
        isLoading={activeChromeState?.isLoading}
        canGoBack={activeChromeState?.canGoBack}
        canGoForward={activeChromeState?.canGoForward}
        onToggleAddressBar={() => setAddressBarVisible((visible) => !visible)}
        onBack={handleActiveBack}
        onForward={handleActiveForward}
        onReload={handleActiveReload}
        onStop={handleActiveStop}
        onNavigateAddress={handleNavigateAddress}
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
          <View
            key={entry.panelId}
            style={styles.webViewSlot}
            pointerEvents={entry.panelId === activePanelId ? "auto" : "none"}
          >
            <WebViewErrorBoundary
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
                onNavigationStateChange={(navState) => {
                  setWebViewNavigation((prev) => ({
                    ...prev,
                    [entry.panelId]: navState,
                  }));
                  if (!entry.managed && /^https?:\/\//i.test(navState.url)) {
                    void shellClient?.panels.updateBrowserUrl(entry.panelId, navState.url).catch(() => {});
                  }
                }}
                onTitleChange={handlePanelTitleChange}
                onBridgeCall={handleBridgeCall}
                onUnmount={handleWebViewUnmount}
                diagnosticsEnabled={entry.managed && hostConfig?.protocol === "http"}
                colors={{
                  background: colors.background,
                  text: colors.text,
                  textSecondary: colors.textSecondary,
                  primary: colors.primary,
                }}
              />
            </WebViewErrorBoundary>
          </View>
        ))}
      </View>
      <ApprovalSheet
        approvals={visibleApprovals}
        onResolve={resolveApproval}
        onSubmitClientConfig={submitClientConfig}
        onSubmitCredentialInput={submitCredentialInput}
        onResolveUserland={resolveUserland}
      />
      <Toast />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentArea: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  webViewSlot: {
    ...StyleSheet.absoluteFillObject,
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
