import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type {
  BranchInfo,
  CommitInfo,
  PanelFocusResult,
  ThemeAppearance,
  WorkspaceNode,
} from "@natstack/shared/types";
import type { ServerClient } from "../serverClient.js";
import {
  buildPanelChromeState,
  isBrowserPanelSource,
  getSharedBrowserAddressOptions,
  getSharedPanelAddressOptions,
  type AddressProviderBrowserDataAdapter,
  type PanelAddressOptions,
  type BrowserAddressOptions,
  type PanelChromeState,
  type PanelRepoState,
} from "@natstack/shared/panelChrome";
import { createBrowserDataRpcClient } from "@natstack/browser-data";
import { getPanelSource } from "@natstack/shared/panel/accessors";
import {
  BROWSER_NAVIGATION_TRANSITIONS,
  type BrowserNavigationIntent,
} from "@natstack/shared/panelCommands";
import { createDevLogger } from "@natstack/dev-log";
import { requireAppCapability } from "./appCapabilities.js";

const log = createDevLogger("PanelShellService");

async function getPanelAddressOptions(
  source: string,
  ref?: string,
  serverClient?: ServerClient | null
): Promise<PanelAddressOptions> {
  return getSharedPanelAddressOptions({
    source,
    ref,
    git: serverClient ? createGitAdapter(serverClient) : null,
  });
}

async function getBrowserAddressOptions(
  query: string,
  registry: PanelRegistry,
  serverClient?: ServerClient | null
): Promise<BrowserAddressOptions> {
  return getSharedBrowserAddressOptions({
    query,
    panels: registry.getSerializablePanelTree(),
    browserData: serverClient ? createBrowserDataAdapter(serverClient) : null,
  });
}

function createGitAdapter(serverClient: ServerClient) {
  return {
    getWorkspaceTree: () =>
      serverClient.call("git", "getWorkspaceTree", []) as Promise<{ children: WorkspaceNode[] }>,
    findRepoForPath: (source: string) =>
      serverClient.call("git", "findRepoForPath", [source]) as Promise<{
        repoPath: string;
        relativePath: string;
      } | null>,
    status: (repoPath: string) =>
      serverClient.call("git", "status", [repoPath]) as Promise<
        PanelRepoState & { repoPath: string }
      >,
    listBranches: (repoPath: string) =>
      serverClient.call("git", "listBranches", [repoPath]) as Promise<BranchInfo[]>,
    listCommits: (repoPath: string, ref: string, limit: number) =>
      serverClient.call("git", "listCommits", [repoPath, ref, limit]) as Promise<CommitInfo[]>,
  };
}

function createBrowserDataAdapter(serverClient: ServerClient): AddressProviderBrowserDataAdapter {
  const client = createBrowserDataRpcClient(serverClient);
  return {
    searchHistoryForAutocomplete: (query, limit) =>
      client.history.searchForAutocomplete(query, limit),
    getHistory: (query) => client.history.get(query),
    searchBookmarks: (query) => client.bookmarks.search(query),
    getSearchEngines: () => client.searchEngines.getAll(),
  };
}

async function getRepoState(
  source: string,
  serverClient?: ServerClient | null
): Promise<PanelRepoState | undefined> {
  if (!serverClient || isBrowserPanelSource(source) || source.startsWith("about/")) {
    return undefined;
  }

  try {
    const repo = (await serverClient.call("git", "findRepoForPath", [source])) as {
      repoPath: string;
      relativePath: string;
    } | null;
    const repoPath = repo?.repoPath ?? source;
    const status = (await serverClient.call("git", "status", [repoPath])) as {
      repoPath: string;
      branch: string | null;
      commit: string | null;
      dirty: boolean;
    };
    return {
      repoPath: status.repoPath,
      branch: status.branch,
      commit: status.commit,
      dirty: status.dirty,
    };
  } catch {
    return {
      repoPath: source,
    };
  }
}

export function createPanelShellService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  panelView: PanelView;
  getViewManager: () => ViewManager;
  serverClient?: ServerClient | null;
}): ServiceDefinition {
  return {
    name: "panel",
    description: "Panel tree management, reload, close",
    policy: { allowed: ["shell", "app"] },
    methods: {
      loadTree: { args: z.tuple([]) },
      getTree: { args: z.tuple([]) },
      getTreeSnapshot: { args: z.tuple([]) },
      getFocusedPanelId: { args: z.tuple([]) },
      notifyFocused: { args: z.tuple([z.string()]) },
      updateTheme: { args: z.tuple([z.unknown()]) },
      openDevTools: { args: z.tuple([z.string()]) },
      getChromeState: { args: z.tuple([z.string()]) },
      getRuntimeLease: { args: z.tuple([z.string()]) },
      takeOver: { args: z.tuple([z.string()]) },
      getAddressOptions: {
        args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string().optional()])]),
      },
      getBrowserAddressOptions: { args: z.tuple([z.string()]) },
      markBrowserNavigationIntent: {
        args: z.tuple([
          z.string(),
          z.object({
            transition: z.enum(BROWSER_NAVIGATION_TRANSITIONS).optional(),
            typed: z.boolean().optional(),
          }),
        ]),
      },
      reload: { args: z.tuple([z.string()]) },
      reloadView: { args: z.tuple([z.string()]) },
      forceReloadView: { args: z.tuple([z.string()]) },
      rebuildPanel: { args: z.tuple([z.string()]) },
      goBack: { args: z.tuple([z.string()]) },
      goForward: { args: z.tuple([z.string()]) },
      unload: { args: z.tuple([z.string()]) },
      archive: { args: z.tuple([z.string()]) },
      retryDirtyBuild: { args: z.tuple([z.string()]) },
      initGitRepo: { args: z.tuple([z.string()]) },
      updatePanelState: { args: z.tuple([z.string(), z.record(z.unknown())]) },
      createAboutPanel: { args: z.tuple([z.unknown()]) },
      navigate: {
        args: z.tuple([
          z.string(),
          z.string(),
          z
            .object({
              ref: z.string().optional(),
              contextId: z.string().optional(),
              stateArgs: z.record(z.unknown()).optional(),
            })
            .optional(),
        ]),
      },
      create: {
        args: z.tuple([
          z.string(),
          z
            .object({
              name: z.string().optional(),
              isRoot: z.boolean().optional(),
              ref: z.string().optional(),
            })
            .optional(),
        ]),
      },
      createChild: {
        args: z.tuple([
          z.string(),
          z.string(),
          z
            .object({
              name: z.string().optional(),
              focus: z.boolean().optional(),
              ref: z.string().optional(),
            })
            .optional(),
        ]),
      },
      createBrowser: {
        args: z.tuple([
          z.string(),
          z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional(),
        ]),
      },
      createBrowserChild: {
        args: z.tuple([
          z.string(),
          z.string(),
          z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional(),
        ]),
      },
      movePanel: {
        args: z.tuple([
          z.object({
            panelId: z.string(),
            newParentId: z.string().nullable(),
            targetPosition: z.number(),
          }),
        ]),
      },
      getChildrenPaginated: {
        args: z.tuple([z.object({ parentId: z.string(), offset: z.number(), limit: z.number() })]),
      },
      getRootPanelsPaginated: {
        args: z.tuple([z.object({ offset: z.number(), limit: z.number() })]),
      },
      getCollapsedIds: { args: z.tuple([]) },
      setCollapsed: { args: z.tuple([z.string(), z.boolean()]) },
      expandIds: { args: z.tuple([z.array(z.string())]) },
    },
    handler: async (ctx, method, args) => {
      const lifecycle = deps.panelOrchestrator;
      const registry = deps.panelRegistry;
      const pv = deps.panelView;
      const vm = deps.getViewManager();
      requireAppCapability(ctx, vm, "panel-hosting", `panel.${method}`);

      switch (method) {
        case "loadTree":
          return {
            rootPanels: registry.getSerializablePanelTree(),
            collapsedIds: await lifecycle.getCollapsedIds(),
          };

        case "getTree":
          return registry.getSerializablePanelTree();

        case "getTreeSnapshot":
          return registry.getPanelTreeSnapshot();

        case "getFocusedPanelId":
          return lifecycle.getFocusedPanelId();

        case "notifyFocused": {
          const panelId = args[0] as string;
          if (!registry.getPanel(panelId)) {
            log.verbose(` Ignoring focus notification for missing panel: ${panelId}`);
            return {
              panelId,
              status: "missing",
              focused: false,
              loaded: false,
              message: `Panel not found: ${panelId}`,
            } satisfies PanelFocusResult;
          }

          const result = await lifecycle.focusPanel(panelId, { loadIfNeeded: true });
          vm.refreshVisiblePanel();
          return result;
        }

        case "updateTheme": {
          const theme = args[0] as ThemeAppearance;
          lifecycle.setCurrentTheme(theme);
          lifecycle.broadcastTheme(theme);
          return;
        }

        case "openDevTools": {
          const panelId = args[0] as string;
          if (!pv.hasView(panelId)) {
            throw new Error(`No view found for panel ${panelId}`);
          }
          pv.openDevTools(panelId);
          return;
        }

        case "getChromeState": {
          const panelId = args[0] as string;
          const panel = registry.getPanel(panelId);
          if (!panel) throw new Error(`Panel not found: ${panelId}`);
          const repo = await getRepoState(getPanelSource(panel), deps.serverClient);
          return buildPanelChromeState({ panel, repo }) satisfies PanelChromeState;
        }

        case "getRuntimeLease": {
          const panelId = args[0] as string;
          return registry.getRuntimeLease(panelId);
        }

        case "takeOver": {
          const panelId = args[0] as string;
          await lifecycle.takeOverPanel(panelId);
          return;
        }

        case "getAddressOptions": {
          const source = args[0] as string;
          const ref = args[1] as string | undefined;
          return getPanelAddressOptions(source, ref, deps.serverClient);
        }

        case "getBrowserAddressOptions": {
          return getBrowserAddressOptions(args[0] as string, registry, deps.serverClient);
        }

        case "markBrowserNavigationIntent": {
          const [panelId, intent] = args as [string, BrowserNavigationIntent];
          pv.markBrowserNavigationIntent?.(panelId, intent);
          return;
        }

        case "reload": {
          const panelId = args[0] as string;
          await lifecycle.reloadPanel(panelId);
          return;
        }

        case "reloadView": {
          const panelId = args[0] as string;
          vm.reload(panelId);
          return;
        }

        case "forceReloadView": {
          const panelId = args[0] as string;
          vm.forceReload(panelId);
          return;
        }

        case "rebuildPanel": {
          const panelId = args[0] as string;
          await lifecycle.retryBuild(panelId);
          return;
        }

        case "goBack": {
          const panelId = args[0] as string;
          const panel = registry.getPanel(panelId);
          const contents = vm.getWebContents(panelId);
          if (panel && getPanelSource(panel).startsWith("browser:") && contents?.canGoBack()) {
            contents.goBack();
            return;
          }
          await lifecycle.navigatePanelHistory(panelId, -1);
          return;
        }

        case "goForward": {
          const panelId = args[0] as string;
          const panel = registry.getPanel(panelId);
          const contents = vm.getWebContents(panelId);
          if (panel && getPanelSource(panel).startsWith("browser:") && contents?.canGoForward()) {
            contents.goForward();
            return;
          }
          await lifecycle.navigatePanelHistory(panelId, 1);
          return;
        }

        case "unload": {
          const panelId = args[0] as string;
          log.verbose(` Unload requested for panel: ${panelId}`);
          await lifecycle.unloadPanel(panelId);
          return;
        }

        case "archive": {
          const panelId = args[0] as string;
          try {
            await lifecycle.closePanel(panelId);
          } catch (error) {
            log.warn(
              ` Archive failed for panel ${panelId}: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
          }
          return;
        }

        case "retryDirtyBuild": {
          const panelId = args[0] as string;
          await lifecycle.retryBuild(panelId);
          return;
        }

        case "initGitRepo": {
          const panelId = args[0] as string;
          await lifecycle.initializeGitRepo(panelId);
          return;
        }

        case "updatePanelState": {
          const [panelId, state] = args as [
            string,
            {
              url?: string;
              pageTitle?: string;
              isLoading?: boolean;
              canGoBack?: boolean;
              canGoForward?: boolean;
            },
          ];
          // updatePanelState is handled by PanelView's browser state tracking
          // This was a method on PanelManager that's now in PanelView
          // For now, delegate to the panel view
          void state;
          void panelId;
          return;
        }

        case "createAboutPanel": {
          const page = args[0] as string;
          return lifecycle.createAboutPanel(page);
        }

        case "create": {
          const source = args[0] as string;
          const opts = args[1] as { name?: string; isRoot?: boolean; ref?: string } | undefined;
          return lifecycle.createRootPanel(source, opts);
        }

        case "createChild": {
          const parentId = args[0] as string;
          const source = args[1] as string;
          const opts = args[2] as { name?: string; focus?: boolean; ref?: string } | undefined;
          return lifecycle.createPanel(parentId, source, opts);
        }

        case "navigate": {
          const panelId = args[0] as string;
          const source = args[1] as string;
          const opts = args[2] as
            | { ref?: string; contextId?: string; stateArgs?: Record<string, unknown> }
            | undefined;
          return lifecycle.navigatePanel(panelId, source, opts);
        }

        case "createBrowser": {
          const url = args[0] as string;
          const opts = args[1] as { name?: string; focus?: boolean } | undefined;
          return lifecycle.createBrowserUrlPanel("shell", url, {
            ...opts,
            focus: opts?.focus ?? true,
          });
        }

        case "createBrowserChild": {
          const parentId = args[0] as string;
          const url = args[1] as string;
          const opts = args[2] as { name?: string; focus?: boolean } | undefined;
          return lifecycle.createBrowserUrlPanel(parentId, url, {
            ...opts,
            focus: opts?.focus ?? true,
          });
        }

        case "movePanel": {
          const { panelId, newParentId, targetPosition } = args[0] as {
            panelId: string;
            newParentId: string | null;
            targetPosition: number;
          };
          await lifecycle.movePanel(panelId, newParentId, targetPosition);
          return;
        }

        case "getChildrenPaginated": {
          const { parentId, offset, limit } = args[0] as {
            parentId: string;
            offset: number;
            limit: number;
          };
          return registry.getChildrenPaginated(parentId, offset, limit);
        }

        case "getRootPanelsPaginated": {
          const { offset, limit } = args[0] as { offset: number; limit: number };
          return registry.getRootPanelsPaginated(offset, limit);
        }

        case "getCollapsedIds":
          return lifecycle.getCollapsedIds();

        case "setCollapsed": {
          const [panelId, collapsed] = args as [string, boolean];
          await lifecycle.setCollapsed(panelId, collapsed);
          return;
        }

        case "expandIds": {
          const [panelIds] = args as [string[]];
          await lifecycle.expandIds(panelIds);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
