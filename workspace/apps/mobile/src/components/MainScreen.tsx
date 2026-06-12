import React, { useEffect, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  BackHandler,
  Platform,
  ActivityIndicator,
  Alert,
  ActionSheetIOS,
  Pressable,
} from "react-native";
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
import { parseHostConfig, getExternalHost } from "../services/panelUrls";
import { materializeMobilePanel } from "../services/panelMaterializer";
import { handleExternalOpen, type ExternalOpenPayload } from "../services/oauthLoopback";
import {
  handleMobileAppLifecycleEvent,
  type AppLifecyclePayload,
} from "../services/appUpdatePrompt";
import { copyToClipboard, openExternalUrl } from "../services/nativeCapabilities";
import type { MobilePanelRuntimeHost } from "../services/bridgeAdapter";
import {
  buildPanelChromeState,
  buildAddressAutocompleteItems,
  formatRepoChip,
  isBrowserPanelSource,
  parseAddressInput,
  type AddressAction,
  type AddressAutocompleteItem,
  type PanelAddressOptions,
  type PanelRepoState,
} from "@natstack/shared/panelChrome";
import {
  applySearchTemplate,
  canonicalizeBrowserHistoryUrl,
  getAvailablePanelCommands,
  getBrowserNavigationIntentForAddressAction,
  getBrowserNavigationIntentForCommand,
  type BrowserNavigationIntent,
  type AddressNavigationMode,
  type PanelCommandId,
} from "@natstack/shared/panelCommands";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import type { HostConfig } from "../services/panelUrls";
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
const MAX_WEBVIEWS = 5;
const PANEL_MATERIALIZE_TIMEOUT_MS = 45_000;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function smokePhase(phase: string, extra?: Record<string, unknown>): void {
  console.log(`[NatStackMobileSmoke] phase=${phase}`, extra ?? "");
}

export function MainScreen() {
  const navigation = useNavigation();
  const shellClient = useAtomValue(shellClientAtom);
  const panelTree = useAtomValue(panelTreeAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const colorScheme = useAtomValue(colorSchemeAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const activePanelTitle = useAtomValue(activePanelTitleAtom);
  const activePanelParentId = useAtomValue(activePanelParentIdAtom);
  const colors = useAtomValue(themeColorsAtom);
  const [approvalDeepLinkId, setApprovalDeepLinkId] = useAtom(approvalDeepLinkAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const promptedAppUpdatesRef = useRef<Set<string>>(new Set());
  useAppLifecycle(shellClient);
  const [webViewStack, setWebViewStack] = useState<WebViewEntry[]>([]);
  const [loadingPanelId, setLoadingPanelId] = useState<string | null>(null);
  const [panelLoadErrors, setPanelLoadErrors] = useState<Record<string, string>>({});
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const pendingApprovalsRefreshSeq = useRef(0);
  const pendingApprovalsSignatureRef = useRef("");
  const [addressBarVisible, setAddressBarVisible] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<AddressAutocompleteItem[]>([]);
  const [panelAddressOptions, setPanelAddressOptions] = useState<PanelAddressOptions | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [selectedMobileApp, setSelectedMobileApp] = useState<{
    source: string | null;
    appId: string | null;
  }>({ source: null, appId: null });
  const [webViewNavigation, setWebViewNavigation] = useState<Record<string, WebViewNavigation>>({});
  const [activeRepoState, setActiveRepoState] = useState<PanelRepoState | undefined>();
  const webViewStackRef = useRef<WebViewEntry[]>([]);
  const webViewRefsMap = useRef<Map<string, PanelWebViewHandle | null>>(new Map());
  const pendingPanelLoads = useRef<Set<string>>(new Set());
  const pendingHistoryIntentByUrl = useRef<Map<string, BrowserNavigationIntent>>(new Map());
  const pendingHistoryIntentByPanel = useRef<Map<string, BrowserNavigationIntent>>(new Map());
  const recentHistoryRecords = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    webViewStackRef.current = webViewStack;
  }, [webViewStack]);
  useEffect(() => {
    let cancelled = false;
    if (!shellClient) {
      setSelectedMobileApp({ source: null, appId: null });
      return;
    }
    void shellClient.workspaces
      .getHostTargetSelection("react-native")
      .then((result) => {
        if (cancelled) return;
        setSelectedMobileApp({
          source: result.valid ? (result.selection?.source ?? null) : null,
          appId: result.valid ? (result.selection?.appId ?? null) : null,
        });
      })
      .catch(() => {
        if (!cancelled) setSelectedMobileApp({ source: null, appId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [shellClient]);
  const handleWebViewUnmount = useCallback(
    (panelId: string) => {
      webViewRefsMap.current.delete(panelId);
      if (shellClient) {
        void shellClient.panels.unload(panelId).catch(() => {});
      }
    },
    [shellClient]
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
    return [
      linked,
      ...pendingApprovals.filter((approval) => approval.approvalId !== approvalDeepLinkId),
    ];
  }, [approvalDeepLinkId, pendingApprovals]);
  const activePanel = useMemo(() => {
    if (!activePanelId || !shellClient) return null;
    return shellClient.panels.registry.getPanel(activePanelId) ?? null;
  }, [activePanelId, panelTree, shellClient]);
  const activeRuntimeLease = useMemo(() => {
    if (!activePanelId || !shellClient) return null;
    return shellClient.panels.registry.getRuntimeLease(activePanelId);
  }, [activePanelId, panelTree, shellClient]);
  const activePanelLoadError = activePanelId ? panelLoadErrors[activePanelId] : null;
  const activePanelLeasedElsewhere = Boolean(
    activeRuntimeLease && activeRuntimeLease.clientSessionId !== shellClient?.credentials.deviceId
  );
  const activeChromeState = useMemo(() => {
    if (!activePanel) return null;
    const nav = activePanelId ? webViewNavigation[activePanelId] : undefined;
    return buildPanelChromeState({
      panel: {
        ...activePanel,
        navigation: nav
          ? {
              url: nav.url,
              pageTitle: nav.title,
              isLoading: nav.loading,
              canGoBack: nav.canGoBack,
              canGoForward: nav.canGoForward,
            }
          : activePanel.navigation,
      },
      repo: activeRepoState,
    });
  }, [activePanel, activePanelId, activeRepoState, webViewNavigation]);
  const activePanelSnapshot = useMemo(() => {
    if (!activePanel) return null;
    return getCurrentSnapshot(activePanel);
  }, [activePanel]);
  useEffect(() => {
    if (!addressBarVisible || !activeChromeState || !shellClient) {
      setAddressSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const query = addressQuery.trim() || activeChromeState.editableAddress;
      const request =
        activeChromeState.kind === "browser"
          ? shellClient.panels.getBrowserAddressOptions(query).then((options) =>
              buildAddressAutocompleteItems({
                kind: "browser",
                input: query,
                browserSuggestions: options.suggestions,
                limit: 8,
              })
            )
          : shellClient.panels
              .getAddressOptions(query, selectedBranch ?? activeChromeState.ref)
              .then((options) => {
                setPanelAddressOptions(options);
                return buildAddressAutocompleteItems({
                  kind: "panel",
                  input: query,
                  panelSuggestions: options.suggestions,
                  limit: 8,
                });
              });
      void request
        .then((items) => {
          if (!cancelled) setAddressSuggestions(items);
        })
        .catch(() => {
          if (!cancelled) setAddressSuggestions([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeChromeState, addressBarVisible, addressQuery, selectedBranch, shellClient]);
  useEffect(() => {
    setSelectedBranch(activeChromeState?.ref ?? activeChromeState?.repo?.branch ?? null);
    setSelectedCommit(null);
  }, [activeChromeState?.panelId, activeChromeState?.ref, activeChromeState?.repo?.branch]);
  useEffect(() => {
    if (
      !activePanel ||
      !activePanelSnapshot ||
      !shellClient ||
      isBrowserPanelSource(activePanelSnapshot.source) ||
      activePanelSnapshot.source.startsWith("about/")
    ) {
      setActiveRepoState(undefined);
      setPanelAddressOptions(null);
      return;
    }
    let cancelled = false;
    const source = activePanelSnapshot.source;
    void shellClient.panels
      .getAddressOptions(source, selectedBranch ?? activeChromeState?.ref)
      .then((options) => {
        if (cancelled) return;
        setPanelAddressOptions(options);
        setActiveRepoState(options.repo);
      })
      .catch(() => {
        if (!cancelled) setActiveRepoState({ repoPath: source });
      });
    return () => {
      cancelled = true;
    };
  }, [activeChromeState?.ref, activePanel, activePanelSnapshot, selectedBranch, shellClient]);
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
    setWebViewStack((prev) =>
      prev.filter((entry) => shellClient.panels.registry.getPanel(entry.panelId) !== undefined)
    );
  }, [shellClient, setPanelTree]);
  const refreshPendingApprovals = useCallback(async () => {
    if (!shellClient) {
      pendingApprovalsRefreshSeq.current++;
      setPendingApprovals([]);
      return [];
    }
    const seq = ++pendingApprovalsRefreshSeq.current;
    const pending = await shellClient.transport.call<PendingApproval[]>(
      "main",
      RPC_METHODS.shellApproval.listPending,
      []
    );
    if (seq === pendingApprovalsRefreshSeq.current) {
      setPendingApprovals(pending);
      const signature = pending.map((approval) => `${approval.kind}:${approval.approvalId}`).join("|");
      if (signature !== pendingApprovalsSignatureRef.current) {
        pendingApprovalsSignatureRef.current = signature;
        if (pending.length > 0) {
          smokePhase("workspace-approval-pending", {
            count: pending.length,
            kinds: pending.map((approval) => approval.kind),
          });
        }
      }
    }
    return pending;
  }, [shellClient]);
  const removeResolvedApproval = useCallback((approvalId: string) => {
    setPendingApprovals((current) =>
      current.filter((approval) => approval.approvalId !== approvalId)
    );
  }, []);
  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      if (!shellClient) throw new Error("Shell client not available");
      await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolve, [
        approvalId,
        decision,
      ]);
      removeResolvedApproval(approvalId);
      void refreshPendingApprovals().catch(() => {});
    },
    [refreshPendingApprovals, removeResolvedApproval, shellClient]
  );
  const submitClientConfig = useCallback(
    async (approvalId: string, values: Record<string, string>) => {
      if (!shellClient) throw new Error("Shell client not available");
      await shellClient.transport.call("main", RPC_METHODS.shellApproval.submitClientConfig, [
        approvalId,
        values,
      ]);
      removeResolvedApproval(approvalId);
    },
    [removeResolvedApproval, shellClient]
  );
  const submitCredentialInput = useCallback(
    async (approvalId: string, values: Record<string, string>) => {
      if (!shellClient) throw new Error("Shell client not available");
      await shellClient.transport.call("main", RPC_METHODS.shellApproval.submitCredentialInput, [
        approvalId,
        values,
      ]);
      removeResolvedApproval(approvalId);
    },
    [removeResolvedApproval, shellClient]
  );
  const resolveUserland = useCallback(
    async (approvalId: string, choice: string | "dismiss") => {
      if (!shellClient) throw new Error("Shell client not available");
      await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolveUserland, [
        approvalId,
        choice,
      ]);
      removeResolvedApproval(approvalId);
    },
    [removeResolvedApproval, shellClient]
  );
  const activatePanel = useCallback(
    (panelId: string) => {
      if (!shellClient || !hostConfig) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      if (!panel) return;
      setActivePanelId(panelId);
      setWebViewStack((prev) =>
        prev.map((entry) =>
          entry.panelId === panelId ? { ...entry, lastActive: Date.now() } : entry
        )
      );
      if (
        pendingPanelLoads.current.has(panelId) ||
        webViewStackRef.current.some((entry) => entry.panelId === panelId)
      ) {
        return;
      }
      pendingPanelLoads.current.add(panelId);
      smokePhase("workspace-panel-activate-start", { panelId });
      setLoadingPanelId(panelId);
      setPanelLoadErrors((prev) => {
        if (!prev[panelId]) return prev;
        const { [panelId]: _removed, ...rest } = prev;
        return rest;
      });
      void (async () => {
        const lease = shellClient.panels.registry.getRuntimeLease(panelId);
        if (lease && lease.clientSessionId !== shellClient.credentials.deviceId) {
          setWebViewStack((prev) => prev.filter((entry) => entry.panelId !== panelId));
          smokePhase("workspace-panel-leased-elsewhere", { panelId });
          return;
        }
        const materialized = await withTimeout(
          materializeMobilePanel({
            panelId,
            panel,
            hostConfig,
            getPanelInit: (id) => shellClient.panels.getPanelInit(id),
            acquireLease: (id, entityId, opts) =>
              shellClient.panels.acquireLease(id, entityId, opts),
            takeOverLease: (id, entityId, opts) =>
              shellClient.panels.takeOverLease(id, entityId, opts),
            leaseMode: "acquire",
          }),
          PANEL_MATERIALIZE_TIMEOUT_MS,
          `Timed out preparing panel ${panelId} for mobile.`
        );
        if (hostConfig.protocol === "http") {
          console.log(`[MainScreen] Activating panel ${panelId}`, {
            url: materialized.url,
            managed: materialized.managed,
          });
        }
        smokePhase("workspace-panel-materialized", {
          panelId,
          managed: materialized.managed,
        });
        setWebViewStack((prev) =>
          addWebViewEntry(prev, {
            panelId,
            url: materialized.url,
            managed: materialized.managed,
            panelInit: materialized.panelInit,
            lastActive: Date.now(),
          })
        );
        setPanelLoadErrors((prev) => {
          if (!prev[panelId]) return prev;
          const { [panelId]: _removed, ...rest } = prev;
          return rest;
        });
      })()
        .catch((err: unknown) => {
          console.error(`[MainScreen] Failed to activate panel ${panelId}:`, err);
          const message = err instanceof Error ? err.message : "Could not load this panel.";
          setPanelLoadErrors((prev) => ({ ...prev, [panelId]: message }));
          pushToast({
            title: "Panel failed to load",
            message,
            tone: "danger",
            durationMs: 10000,
          });
          smokePhase("workspace-panel-activate-failed", { panelId, message });
        })
        .finally(() => {
          pendingPanelLoads.current.delete(panelId);
          setLoadingPanelId((current) => (current === panelId ? null : current));
        });
    },
    [hostConfig, pushToast, shellClient, setActivePanelId]
  );
  const takeOverActivePanel = useCallback(() => {
    if (!activePanelId || !activePanel || !hostConfig || !shellClient) return;
    pendingPanelLoads.current.add(activePanelId);
    setLoadingPanelId(activePanelId);
    void materializeMobilePanel({
      panelId: activePanelId,
      panel: activePanel,
      hostConfig,
      getPanelInit: (id) => shellClient.panels.getPanelInit(id),
      acquireLease: (id, entityId, opts) => shellClient.panels.acquireLease(id, entityId, opts),
      takeOverLease: (id, entityId, opts) => shellClient.panels.takeOverLease(id, entityId, opts),
      leaseMode: "takeOver",
    })
      .then((materialized) => {
        setWebViewStack((prev) =>
          addWebViewEntry(prev, {
            panelId: materialized.panelId,
            url: materialized.url,
            managed: materialized.managed,
            panelInit: materialized.panelInit,
            lastActive: Date.now(),
          })
        );
      })
      .catch((error: unknown) => {
        pushToast({
          title: "Take over failed",
          message: error instanceof Error ? error.message : "Could not take over panel.",
          tone: "danger",
        });
      })
      .finally(() => {
        pendingPanelLoads.current.delete(activePanelId);
        setLoadingPanelId((current) => (current === activePanelId ? null : current));
      });
  }, [activePanel, activePanelId, hostConfig, pushToast, shellClient]);
  const waitForWebViewHandle = useCallback(
    async (panelId: string): Promise<PanelWebViewHandle> => {
      const existing = webViewRefsMap.current.get(panelId);
      if (existing) return existing;
      activatePanel(panelId);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 10_000) {
        const handle = webViewRefsMap.current.get(panelId);
        if (handle) return handle;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Panel ${panelId} is not loaded in a mobile WebView`);
    },
    [activatePanel]
  );
  const mobileRuntimeHost = useMemo<MobilePanelRuntimeHost>(
    () => ({
      ensureLoaded: async (panelId) => {
        await waitForWebViewHandle(panelId);
      },
      snapshot: async (panelId) => {
        const handle = await waitForWebViewHandle(panelId);
        return handle.snapshot();
      },
      callAgent: async (panelId, method, args) => {
        const handle = await waitForWebViewHandle(panelId);
        return handle.callAgent(method, args);
      },
      reload: async (panelId) => {
        const handle = await waitForWebViewHandle(panelId);
        handle.reload();
      },
    }),
    [waitForWebViewHandle]
  );
  useLayoutEffect(() => {
    shellClient?.panels.setRuntimeHost(mobileRuntimeHost);
    return () => shellClient?.panels.setRuntimeHost(null);
  }, [mobileRuntimeHost, shellClient]);
  useEffect(() => {
    if (!shellClient) return;
    refreshTree();
    const eventNames = [
      "navigate-to-panel",
      "external-open:open",
      "notification:show",
      "apps:lifecycle",
      "shell-approval:pending-changed",
      "workspace:revision-bumped",
    ] as const;
    let disposed = false;
    const subscribeAll = async () => {
      await Promise.all(
        eventNames.map((name) =>
          shellClient.events.subscribe(name).catch(() => undefined)
        )
      );
    };
    void subscribeAll()
      .then(() => {
        if (!disposed) void refreshPendingApprovals().catch(() => {});
      })
      .catch(() => {
        if (!disposed) void refreshPendingApprovals().catch(() => {});
      });
    const unsubReconnect = shellClient.transport.onReconnect(() => {
      void subscribeAll()
        .then(() => refreshPendingApprovals())
        .catch(() => refreshPendingApprovals());
      void shellClient.panels
        .refresh()
        .then(() => {
          refreshTree();
        })
        .catch(() => refreshTree());
    });
    const unsubNavigate = shellClient.onNavigateToPanel((panelId) => {
      refreshTree();
      activatePanel(panelId);
    });
    const unsubNav = shellClient.transport.on(
      "event:navigate-to-panel",
      (event) => {
        const { panelId } = event.payload as {
          panelId: string;
        };
        if (panelId) activatePanel(panelId);
      }
    );
    const unsubExternal = shellClient.transport.on(
      "event:external-open:open",
      (event) => {
        void handleExternalOpen(shellClient, event.payload as ExternalOpenPayload).catch(
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[MainScreen] Failed to open external URL:", error);
            pushToast({
              title: "Could not open OAuth flow",
              message,
              tone: "danger",
              durationMs: 10000,
            });
          }
        );
      }
    );
    const unsubNotification = shellClient.transport.on(
      "event:notification:show",
      (event) => {
        const notif = event.payload as {
          id?: string;
          title?: string;
          message?: string;
          type?: string;
          consent?: {
            provider?: string;
            scopes?: string[];
            callerTitle?: string;
          };
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
      }
    );
    const unsubAppLifecycle = shellClient.transport.on(
      "event:apps:lifecycle",
      (event) => {
        handleMobileAppLifecycleEvent(event.payload as AppLifecyclePayload, {
          shellClient,
          pushToast,
          prompted: promptedAppUpdatesRef.current,
          selectedSource: selectedMobileApp.source,
          selectedAppId: selectedMobileApp.appId,
        });
      }
    );
    const unsubApproval = shellClient.transport.on(
      "event:shell-approval:pending-changed",
      () => {
        void refreshPendingApprovals().catch(() => {});
      }
    );
    const unsubWorkspaceRevision = shellClient.transport.on(
      "event:workspace:revision-bumped",
      () => {
        void shellClient.panels
          .refresh()
          .then(refreshTree)
          .catch(() => refreshTree());
      }
    );
    const approvalTimer = setInterval(() => {
      void refreshPendingApprovals().catch(() => {});
    }, 2000);
    const treeTimer = setInterval(refreshTree, 60000);
    return () => {
      disposed = true;
      clearInterval(approvalTimer);
      clearInterval(treeTimer);
      unsubReconnect();
      unsubNavigate();
      unsubNav();
      unsubExternal();
      unsubNotification();
      unsubAppLifecycle();
      unsubApproval();
      unsubWorkspaceRevision();
      for (const name of eventNames) {
        void shellClient.events.unsubscribe(name).catch(() => {});
      }
    };
  }, [
    activatePanel,
    pushToast,
    refreshPendingApprovals,
    refreshTree,
    selectedMobileApp,
    shellClient,
  ]);
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
    if (activePanelLeasedElsewhere) return;
    if (
      !webViewStack.some((entry) => entry.panelId === activePanelId) &&
      !pendingPanelLoads.current.has(activePanelId)
    ) {
      activatePanel(activePanelId);
    }
  }, [activePanelId, activePanelLeasedElsewhere, activatePanel, webViewStack]);
  useEffect(() => {
    if (!shellClient) return;
    setWebViewStack((prev) =>
      prev.filter((entry) => {
        const lease = shellClient.panels.registry.getRuntimeLease(entry.panelId);
        return !lease || lease.clientSessionId === shellClient.credentials.deviceId;
      })
    );
  }, [panelTree, shellClient]);
  useEffect(() => {
    if (!shellClient) return;
    if (activePanelId && shellClient.panels.registry.getPanel(activePanelId)) return;
    const firstRoot = shellClient.panels.registry.getRootPanels()[0];
    setActivePanelId(firstRoot?.id ?? null);
  }, [activePanelId, panelTree, setActivePanelId, shellClient]);
  const handleMenuPress = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
  const handlePanelCreated = useCallback(
    (panelId: string) => {
      activatePanel(panelId);
    },
    [activatePanel]
  );
  const handleActiveBack = useCallback(() => {
    if (!activePanelId) return;
    pendingHistoryIntentByPanel.current.set(activePanelId, requireBrowserNavigationIntent("back"));
    webViewRefsMap.current.get(activePanelId)?.goBack();
  }, [activePanelId]);
  const handleActiveForward = useCallback(() => {
    if (!activePanelId) return;
    pendingHistoryIntentByPanel.current.set(
      activePanelId,
      requireBrowserNavigationIntent("forward")
    );
    webViewRefsMap.current.get(activePanelId)?.goForward();
  }, [activePanelId]);
  const handleActiveReload = useCallback(() => {
    if (!activePanelId) return;
    const currentUrl = webViewNavigation[activePanelId]?.url;
    if (currentUrl)
      pendingHistoryIntentByUrl.current.set(
        canonicalHistoryKey(currentUrl),
        requireBrowserNavigationIntent("reload-panel")
      );
    webViewRefsMap.current.get(activePanelId)?.reload();
  }, [activePanelId, webViewNavigation]);
  const handleActiveStop = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.stop();
  }, [activePanelId]);
  const performPanelCommand = useCallback(
    (command: PanelCommandId, panelId = activePanelId) => {
      if (!shellClient || !panelId) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      switch (command) {
        case "back":
          pendingHistoryIntentByPanel.current.set(panelId, requireBrowserNavigationIntent("back"));
          webViewRefsMap.current.get(panelId)?.goBack();
          return;
        case "forward":
          pendingHistoryIntentByPanel.current.set(
            panelId,
            requireBrowserNavigationIntent("forward")
          );
          webViewRefsMap.current.get(panelId)?.goForward();
          return;
        case "reload-panel":
        case "reload-view":
        case "force-reload-view":
        case "rebuild-panel":
          {
            const currentUrl = webViewNavigation[panelId]?.url;
            if (currentUrl)
              pendingHistoryIntentByUrl.current.set(
                canonicalHistoryKey(currentUrl),
                requireBrowserNavigationIntent("reload-panel")
              );
          }
          webViewRefsMap.current.get(panelId)?.reload();
          return;
        case "stop":
          webViewRefsMap.current.get(panelId)?.stop();
          return;
        case "copy-address": {
          const address =
            panelId === activePanelId
              ? activeChromeState?.editableAddress
              : panel
                ? getCurrentSnapshot(panel).source
                : undefined;
          if (address) {
            copyToClipboard(address);
            pushToast({ title: "Address copied", message: address, tone: "success" });
          }
          return;
        }
        case "open-external": {
          const url =
            panelId === activePanelId
              ? activeChromeState?.resolvedUrl
              : panel
                ? getCurrentSnapshot(panel).resolvedUrl
                : undefined;
          if (url && /^https?:\/\//i.test(url)) void openExternalUrl(url);
          return;
        }
        case "duplicate": {
          if (!panel) return;
          const snapshot = getCurrentSnapshot(panel);
          if (isBrowserPanelSource(snapshot.source)) {
            const url =
              panelId === activePanelId
                ? activeChromeState?.resolvedUrl
                : snapshot.source.slice("browser:".length);
            if (url)
              void shellClient.panels
                .createBrowserUrlPanel(null, url, { focus: true })
                .then((result) => activatePanel(result.id));
          } else {
            void shellClient.panels
              .createRootPanel(snapshot.source)
              .then((result) => activatePanel(result.id));
          }
          return;
        }
        case "unload":
          void shellClient.panels.unload(panelId);
          setWebViewStack((prev) => prev.filter((entry) => entry.panelId !== panelId));
          return;
        case "archive":
          void shellClient.panels.archive(panelId).then(refreshTree);
          return;
        case "focus-address":
          setAddressBarVisible(true);
          return;
      }
    },
    [
      activatePanel,
      activeChromeState,
      activePanelId,
      pushToast,
      refreshTree,
      shellClient,
      webViewNavigation,
    ]
  );
  const showPanelActions = useCallback(
    (panelId = activePanelId) => {
      if (!shellClient || !panelId) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      const chrome =
        panelId === activePanelId
          ? activeChromeState
          : panel
            ? buildPanelChromeState({ panel })
            : null;
      const commands = getAvailablePanelCommands({ chrome, addressBarVisible }, [
        "back",
        "forward",
        "reload-panel",
        "reload-view",
        "force-reload-view",
        "rebuild-panel",
        "stop",
        "copy-address",
        "open-external",
        "duplicate",
        "unload",
        "archive",
      ]);
      const labels = commands.map((command) => command.label);
      if (Platform.OS === "ios") {
        const destructiveIndex = commands.findIndex((command) => command.id === "archive");
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...labels, "Cancel"],
            cancelButtonIndex: labels.length,
            destructiveButtonIndex: destructiveIndex >= 0 ? destructiveIndex : undefined,
          },
          (buttonIndex) => {
            const command = commands[buttonIndex];
            if (command) performPanelCommand(command.id, panelId);
          }
        );
        return;
      }
      Alert.alert(panel?.title ?? "Panel", undefined, [
        ...commands.map((command) => ({
          text: command.label,
          onPress: () => performPanelCommand(command.id, panelId),
          style: command.id === "archive" ? ("destructive" as const) : ("default" as const),
        })),
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [activeChromeState, activePanelId, addressBarVisible, performPanelCommand, shellClient]
  );
  const executeAddressAction = useCallback(
    (action: AddressAction, mode: AddressNavigationMode = "current") => {
      if (!shellClient || !activePanelId) return;
      if (action.type === "navigate-url") {
        const intent = getBrowserNavigationIntentForAddressAction(action);
        if (intent) pendingHistoryIntentByUrl.current.set(canonicalHistoryKey(action.url), intent);
        if (mode === "external") {
          void openExternalUrl(action.url);
        } else if (mode === "child") {
          void shellClient.panels
            .createBrowserUrlPanel(activePanelId, action.url, { focus: true })
            .catch((error: unknown) =>
              pushToast({
                title: "Navigation failed",
                message: error instanceof Error ? error.message : "Could not open browser panel.",
                tone: "danger",
              })
            );
        } else if (mode === "root") {
          void shellClient.panels
            .createBrowserUrlPanel(null, action.url, { focus: true })
            .then((result) => activatePanel(result.id))
            .catch((error: unknown) =>
              pushToast({
                title: "Navigation failed",
                message: error instanceof Error ? error.message : "Could not open browser panel.",
                tone: "danger",
              })
            );
        } else {
          const active = shellClient.panels.registry.getPanel(activePanelId);
          if (active && isBrowserPanelSource(getCurrentSnapshot(active).source)) {
            setWebViewStack((prev) =>
              prev.map((entry) =>
                entry.panelId === activePanelId ? { ...entry, url: action.url } : entry
              )
            );
            setWebViewNavigation((prev) => ({
              ...prev,
              [activePanelId]: {
                ...(prev[activePanelId] as WebViewNavigation | undefined),
                url: action.url,
              } as WebViewNavigation,
            }));
          } else {
            void shellClient.panels
              .createBrowserUrlPanel(activePanelId, action.url, { focus: true })
              .catch((error: unknown) =>
                pushToast({
                  title: "Navigation failed",
                  message: error instanceof Error ? error.message : "Could not open browser panel.",
                  tone: "danger",
                })
              );
          }
        }
        return;
      }
      if (action.type === "search" || action.type === "keyword-search") {
        const url = applySearchTemplate(action.query, action.template);
        const intent = getBrowserNavigationIntentForAddressAction(action);
        if (intent) pendingHistoryIntentByUrl.current.set(canonicalHistoryKey(url), intent);
        if (mode === "external") {
          void openExternalUrl(url);
          return;
        }
        if (mode === "current") {
          const active = shellClient.panels.registry.getPanel(activePanelId);
          if (active && isBrowserPanelSource(getCurrentSnapshot(active).source)) {
            setWebViewStack((prev) =>
              prev.map((entry) => (entry.panelId === activePanelId ? { ...entry, url } : entry))
            );
            setWebViewNavigation((prev) => ({
              ...prev,
              [activePanelId]: {
                ...(prev[activePanelId] as WebViewNavigation | undefined),
                url,
              } as WebViewNavigation,
            }));
            return;
          }
        }
        void shellClient.panels
          .createBrowserUrlPanel(mode === "child" ? activePanelId : null, url, { focus: true })
          .then((result) => activatePanel(result.id))
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message: error instanceof Error ? error.message : "Could not search.",
              tone: "danger",
            })
          );
        return;
      }
      if (action.type === "panel-source") {
        const ref = action.ref ?? selectedCommit ?? selectedBranch ?? undefined;
        const created =
          mode === "current"
            ? shellClient.panels.navigatePanel(activePanelId, action.source, { ref })
            : mode === "child"
              ? shellClient.panels.createChildPanel(activePanelId, action.source, {
                  focus: true,
                  ref,
                })
              : shellClient.panels.createRootPanel(action.source, { ref });
        void created
          .then((result) => activatePanel(result.id))
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message: error instanceof Error ? error.message : "Could not open panel.",
              tone: "danger",
            })
          );
      }
    },
    [
      activatePanel,
      activePanelId,
      pushToast,
      selectedBranch,
      selectedCommit,
      shellClient,
      webViewNavigation,
    ]
  );
  const handleNavigateAddress = useCallback(
    (value: string, mode: AddressNavigationMode = "current") => {
      if (!shellClient || !activePanelId) return;
      const parsed = parseAddressInput(value);
      if (!parsed) return;
      if (parsed.type === "browser-url") {
        executeAddressAction({ type: "navigate-url", url: parsed.url, recordAsTyped: true }, mode);
        return;
      }
      if (parsed.type === "panel-source") {
        executeAddressAction({ type: "panel-source", source: parsed.source }, mode);
        return;
      }
      if (parsed.type === "search") {
        executeAddressAction(
          {
            type: "search",
            query: parsed.query,
            template: "https://www.google.com/search?q=%s",
            recordAsTyped: true,
          },
          mode
        );
      }
    },
    [activePanelId, executeAddressAction, shellClient]
  );
  const handlePanelNavigate = useCallback(
    (event: PanelNavigationEvent) => {
      if (!shellClient) return;
      void shellClient.panels
        .createChildPanel(event.panelId, event.source, {
          name: event.options.name,
          contextId: event.contextId ?? event.options.contextId,
          focus: event.options.focus,
          stateArgs: event.stateArgs,
        })
        .then((result) => {
          refreshTree();
          if (event.options.focus !== false) {
            activatePanel(result.id);
          }
        })
        .catch((error: unknown) => {
          pushToast({
            title: "Panel navigation failed",
            message: error instanceof Error ? error.message : "Could not open panel.",
            tone: "danger",
          });
        });
    },
    [activatePanel, pushToast, refreshTree, shellClient]
  );
  const handlePanelTitleChange = useCallback(
    (panelId: string, title: string) => {
      if (!shellClient) return;
      const navUrl = webViewNavigation[panelId]?.url;
      const panel = shellClient.panels.registry.getPanel(panelId);
      if (navUrl && panel && isBrowserPanelSource(getCurrentSnapshot(panel).source)) {
        void shellClient.panels.updateHistoryTitle({ url: navUrl, title }).catch(() => {});
      }
      void shellClient.panels
        .updateTitle(panelId, title)
        .then(refreshTree)
        .catch((error: unknown) => {
          console.warn(`[MainScreen] Failed to update title for panel ${panelId}:`, error);
        });
    },
    [refreshTree, shellClient, webViewNavigation]
  );
  const recordMobileBrowserNavigation = useCallback(
    (panelId: string, navState: WebViewNavigation) => {
      if (!shellClient || !/^https?:\/\//i.test(navState.url)) return;
      const key = canonicalHistoryKey(navState.url);
      const intent = pendingHistoryIntentByUrl.current.get(key) ??
        pendingHistoryIntentByPanel.current.get(panelId) ?? { transition: "link", typed: false };
      pendingHistoryIntentByUrl.current.delete(key);
      pendingHistoryIntentByPanel.current.delete(panelId);
      const duplicateKey = `${panelId}:${key}:${intent.transition ?? "link"}`;
      const now = Date.now();
      const previous = recentHistoryRecords.current.get(duplicateKey);
      if (previous && now - previous < 1000) return;
      recentHistoryRecords.current.set(duplicateKey, now);
      void shellClient.panels
        .recordHistoryVisit({
          url: navState.url,
          title: navState.title,
          transition: intent.transition,
          typed: intent.typed,
          visitTime: now,
        })
        .catch(() => {});
    },
    [shellClient]
  );
  const handleBridgeCall = useCallback(
    async (panelId: string, method: string, args: unknown[]) => {
      if (!shellClient) throw new Error("Shell client not available");
      const result = await shellClient.handlePanelBridgeCall(panelId, method, args);
      refreshTree();
      return result;
    },
    [refreshTree, shellClient]
  );
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const onBackPress = () => {
      if (activePanelId && webViewNavigation[activePanelId]?.canGoBack) {
        pendingHistoryIntentByPanel.current.set(
          activePanelId,
          requireBrowserNavigationIntent("back")
        );
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
      <ConnectionBar onRepair={() => navigation.getParent()?.navigate("Login" as never)} />
      <AppBar
        title={activePanelTitle}
        onMenuPress={handleMenuPress}
        onPanelCreated={handlePanelCreated}
        addressBarVisible={addressBarVisible}
        address={activeChromeState?.editableAddress ?? ""}
        metadata={
          activeChromeState?.kind === "panel" ? formatRepoChip(activeChromeState.repo) : null
        }
        isLoading={activeChromeState?.isLoading}
        canGoBack={activeChromeState?.canGoBack}
        canGoForward={activeChromeState?.canGoForward}
        onToggleAddressBar={() => setAddressBarVisible((visible) => !visible)}
        onBack={handleActiveBack}
        onForward={handleActiveForward}
        onReload={handleActiveReload}
        onStop={handleActiveStop}
        onNavigateAddress={handleNavigateAddress}
        addressSuggestions={addressSuggestions}
        onAddressQueryChange={setAddressQuery}
        onSelectAddressSuggestion={(item) => executeAddressAction(item.action)}
        chromeKind={activeChromeState?.kind}
        branches={panelAddressOptions?.branches ?? []}
        commits={panelAddressOptions?.commits ?? []}
        selectedBranch={selectedBranch ?? panelAddressOptions?.repo?.branch ?? null}
        selectedCommit={selectedCommit ?? panelAddressOptions?.repo?.commit ?? null}
        dirty={Boolean(panelAddressOptions?.repo?.dirty ?? activeChromeState?.repo?.dirty)}
        onSelectBranch={(branch) => {
          setSelectedBranch(branch);
          setSelectedCommit(null);
        }}
        onSelectCommit={setSelectedCommit}
        onShowActions={() => showPanelActions()}
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

        {loadingPanelId &&
          loadingPanelId === activePanelId &&
          !activePanelLoadError &&
          !webViewStack.some((entry) => entry.panelId === loadingPanelId) && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
                Loading panel...
              </Text>
            </View>
          )}

        {activePanelId &&
          activePanelLoadError &&
          !activePanelLeasedElsewhere &&
          !webViewStack.some((entry) => entry.panelId === activePanelId) && (
            <View style={styles.placeholderContainer}>
              <Text style={[styles.placeholderText, { color: colors.text }]}>
                Panel failed to load
              </Text>
              <Text style={[styles.placeholderSubtext, { color: colors.textSecondary }]}>
                {activePanelLoadError}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading panel"
                hitSlop={8}
                style={({ pressed }) => [
                  styles.retryButton,
                  { borderColor: colors.primary },
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => activatePanel(activePanelId)}
              >
                <Text style={[styles.retryButtonText, { color: colors.primary }]}>Retry</Text>
              </Pressable>
            </View>
          )}

        {activePanelId && activePanelLeasedElsewhere && (
          <View style={styles.placeholderContainer}>
            <Text style={[styles.placeholderText, { color: colors.text }]}>
              Running on {activeRuntimeLease?.holderLabel ?? "another client"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take over this panel"
              hitSlop={8}
              style={({ pressed }) => [
                styles.takeOverButton,
                { borderColor: colors.primary },
                pressed && { opacity: 0.6 },
              ]}
              onPress={takeOverActivePanel}
            >
              <Text style={[styles.takeOverButtonText, { color: colors.primary }]}>Take Over</Text>
            </Pressable>
          </View>
        )}

        {!activePanelLeasedElsewhere &&
          webViewStack.map((entry) => (
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
                      void shellClient?.panels
                        .updateBrowserUrl(entry.panelId, navState.url)
                        .catch(() => {});
                      recordMobileBrowserNavigation(entry.panelId, navState);
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
        onNavigateToPanel={activatePanel}
      />
      <Toast />
    </View>
  );
}
function canonicalHistoryKey(url: string): string {
  return canonicalizeBrowserHistoryUrl(url) ?? url;
}

function requireBrowserNavigationIntent(command: PanelCommandId): BrowserNavigationIntent {
  const intent = getBrowserNavigationIntentForCommand(command);
  if (!intent) {
    throw new Error(`Panel command ${command} does not have a browser navigation intent`);
  }
  return intent;
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
  takeOverButton: {
    marginTop: 12,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  takeOverButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  retryButton: {
    marginTop: 16,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
