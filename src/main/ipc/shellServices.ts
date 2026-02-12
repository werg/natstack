/**
 * Shell Service Handlers - Unified handlers for shell-only services.
 *
 * These handlers consolidate the existing IPC handlers into the service dispatcher format.
 * They are called from the service dispatcher when shell makes service calls.
 *
 * Services:
 * - app: App lifecycle, theme, devtools
 * - panel: Panel tree management
 * - view: View bounds, visibility
 * - menu: Native menus
 * - workspace: Workspace operations
 * - central: Central data store
 * - settings: Settings management
 */

import { app, nativeTheme, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import * as path from "path";
import * as fs from "fs";
import type { ServiceContext } from "../serviceDispatcher.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("ShellServices");
import type {
  ThemeMode,
  ThemeAppearance,
  WorkspaceValidation,
  SettingsData,
  PanelContextMenuAction,
  AppMode,
  ProviderInfo,
  AvailableProvider,
  ModelRoleConfig,
  ShellPage,
} from "../../shared/types.js";
import { getPanelPersistence } from "../db/panelPersistence.js";
import { getPanelSearchIndex } from "../db/panelSearchIndex.js";
import type { SupportedProvider } from "../workspace/types.js";
import { getViewManager } from "../viewManager.js";
import { buildHamburgerMenuTemplate } from "../menu.js";
import { getCentralData } from "../centralData.js";
import {
  loadCentralConfig,
  saveCentralConfig,
  loadSecrets,
  saveSecrets,
  loadWorkspaceConfig,
} from "../workspace/loader.js";
import {
  getSupportedProviders,
  getProviderEnvVars,
  getProviderDisplayName,
  getDefaultModelsForProvider,
  hasProviderApiKey,
  usesCliAuth,
} from "../ai/providerFactory.js";
import { fetchModelsForProvider, type FetchedModel } from "../ai/modelFetcher.js";
import { getShellPagesForLauncher } from "../aboutBuilder.js";

// These will be set during initialization to avoid circular dependencies
let _panelManager: import("../panelManager.js").PanelManager | null = null;
let _currentAppMode: AppMode = "chooser";
let _serverClient: import("../serverClient.js").ServerClient | null = null;

/**
 * Set the panel manager instance (called during initialization).
 */
export function setShellServicesPanelManager(pm: import("../panelManager.js").PanelManager | null): void {
  _panelManager = pm;
}

/**
 * Set the current app mode (called during mode transitions).
 */
export function setShellServicesAppMode(mode: AppMode): void {
  _currentAppMode = mode;
}

/**
 * Set the server client instance (called during initialization).
 */
export function setShellServicesServerClient(client: import("../serverClient.js").ServerClient | null): void {
  _serverClient = client;
}

function requirePanelManager(): import("../panelManager.js").PanelManager {
  if (!_panelManager) {
    throw new Error("Panel operations not available in workspace chooser mode");
  }
  return _panelManager;
}

/**
 * Refresh AI providers after settings changes.
 * Sends a reinitialize RPC to the server process.
 */
async function refreshAiProviders(): Promise<void> {
  if (!_serverClient) return;
  try {
    await _serverClient.call("ai", "reinitialize", []);
  } catch (error) {
    console.error("[Settings] Failed to refresh AI providers:", error);
  }
}

/**
 * Check if any AI providers are configured.
 */
function hasConfiguredProviders(): boolean {
  const providers = getSupportedProviders();
  const secrets = loadSecrets();

  return providers.some((providerId) => {
    if (usesCliAuth(providerId)) {
      return secrets[providerId] === "enabled";
    }
    return hasProviderApiKey(providerId);
  });
}

/**
 * Get the API key for a provider from environment or secrets.
 */
function getApiKeyForProvider(
  providerId: SupportedProvider,
  envVars: Record<SupportedProvider, string>,
  secrets: Record<string, string>
): string | undefined {
  const envVar = envVars[providerId];
  // Check process.env first (from .env or shell), then secrets
  return process.env[envVar] || secrets[providerId];
}

// =============================================================================
// App Service Handler
// =============================================================================

export async function handleAppService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case "getInfo":
      return { version: app.getVersion() };

    case "getSystemTheme":
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";

    case "setThemeMode": {
      const mode = args[0] as ThemeMode;
      nativeTheme.themeSource = mode;
      return;
    }

    case "openDevTools": {
      const vm = getViewManager();
      vm.openDevTools("shell");
      return;
    }

    case "getPanelPreloadPath":
      return path.join(__dirname, "..", "panelPreload.cjs");

    case "clearBuildCache": {
      // Invalidate @natstack types FIRST to prevent stale reads during cache clearing
      const { getTypeDefinitionService } = await import("../typecheck/service.js");
      await getTypeDefinitionService().invalidateNatstackTypes();
      // Then clear all other caches (same as automatic invalidation on package changes)
      const { clearAllCaches } = await import("../cacheUtils.js");
      await clearAllCaches({
        buildCache: true,
        buildArtifacts: true,
        typesCache: true,
        verdaccioStorage: true, // Clear Verdaccio to avoid stale @natstack packages
        npmCache: false,
        pnpmStore: false,
      });
      // Clear Verdaccio's in-memory caches (version cache, package discovery, ESM transformer)
      if (_serverClient) {
        try { await _serverClient.call("verdaccio", "clearCaches", []); } catch {}
      }
      // Invalidate ready panels: reset state AND unload WebContents
      try {
        const pm = requirePanelManager();
        pm.invalidateReadyPanels();
      } catch (error) {
        console.warn("[App] Failed to invalidate panel states:", error);
      }
      return;
    }

    case "getMode":
      return _currentAppMode;

    case "getShellPages":
      // Return shell pages available for the launcher (excludes "new" itself)
      return getShellPagesForLauncher();

    default:
      throw new Error(`Unknown app method: ${method}`);
  }
}

// =============================================================================
// Panel Service Handler
// =============================================================================

export async function handlePanelService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const pm = requirePanelManager();
  const vm = getViewManager();

  switch (method) {
    case "getTree":
      return pm.getSerializablePanelTree();

    case "notifyFocused": {
      const panelId = args[0] as string;

      // Only send focus event if panel has a view - otherwise we get
      // "Render frame was disposed" errors for unloaded panels
      if (vm.hasView(panelId)) {
        pm.sendPanelEvent(panelId, { type: "focus" });
      }

      // Update the selected path in both in-memory tree and database
      // for breadcrumb navigation, and log focused event for analytics
      try {
        // Update in-memory tree first
        pm.updateSelectedPath(panelId);
        // Persist to database
        const persistence = getPanelPersistence();
        persistence.updateSelectedPath(panelId);
        persistence.logEvent(panelId, "focused");
        getPanelSearchIndex().incrementAccessCount(panelId);
        // Notify UI of the selected path change
        pm.notifyPanelTreeUpdate();

        // Refresh the visible panel to recover from potential compositor stalls.
        // The remove/add cycle in bringToFront can help restore painting when
        // Chromium's compositor has stopped rendering the view.
        vm.refreshVisiblePanel();

        // If panel was unloaded (pending state), rebuild it on focus
        // This is async but we don't need to wait for it
        void pm.rebuildUnloadedPanel(panelId);
      } catch (error) {
        console.error(`[Panel] Failed to update selected path for ${panelId}:`, error);
      }
      return;
    }

    case "updateTheme": {
      const theme = args[0] as ThemeAppearance;
      pm.setCurrentTheme(theme);
      pm.broadcastTheme(theme);
      return;
    }

    case "openDevTools": {
      const panelId = args[0] as string;
      if (!vm.hasView(panelId)) {
        throw new Error(`No view found for panel ${panelId}`);
      }
      vm.openDevTools(panelId);
      return;
    }

    case "reload": {
      const panelId = args[0] as string;
      if (!vm.hasView(panelId)) {
        // Panel may have been unloaded - try to rebuild it
        await pm.rebuildUnloadedPanel(panelId);
        return;
      }
      vm.reload(panelId);
      return;
    }

    case "unload": {
      const panelId = args[0] as string;
      log.verbose(` Unload requested for panel: ${panelId}`);
      log.verbose(` Unload call stack:`, new Error().stack);
      await pm.unloadPanel(panelId);
      return;
    }

    case "archive": {
      const panelId = args[0] as string;
      await pm.closePanel(panelId);  // closePanel already archives
      return;
    }

    case "retryDirtyBuild": {
      const panelId = args[0] as string;
      await pm.retryBuild(panelId);
      return;
    }

    case "initGitRepo": {
      const panelId = args[0] as string;
      await pm.initializeGitRepo(panelId);
      return;
    }

    case "updateBrowserState": {
      const [browserId, state] = args as [string, {
        url?: string;
        pageTitle?: string;
        isLoading?: boolean;
        canGoBack?: boolean;
        canGoForward?: boolean;
      }];
      pm.updateBrowserState(browserId, state);
      return;
    }

    case "createShellPanel": {
      const page = args[0] as ShellPage;
      return pm.createShellPanel(page);
    }

    case "movePanel": {
      const { panelId, newParentId, targetPosition } = args[0] as {
        panelId: string;
        newParentId: string | null;
        targetPosition: number;
      };
      pm.movePanel(panelId, newParentId, targetPosition);
      return;
    }

    case "getChildrenPaginated": {
      const { parentId, offset, limit } = args[0] as {
        parentId: string;
        offset: number;
        limit: number;
      };
      return pm.getChildrenPaginated(parentId, offset, limit);
    }

    case "getRootPanelsPaginated": {
      const { offset, limit } = args[0] as { offset: number; limit: number };
      return pm.getRootPanelsPaginated(offset, limit);
    }

    case "getCollapsedIds": {
      return pm.getCollapsedIds();
    }

    case "setCollapsed": {
      const [panelId, collapsed] = args as [string, boolean];
      pm.setCollapsed(panelId, collapsed);
      return;
    }

    case "expandIds": {
      const [panelIds] = args as [string[]];
      pm.expandIds(panelIds);
      return;
    }

    default:
      throw new Error(`Unknown panel method: ${method}`);
  }
}

// =============================================================================
// View Service Handler
// =============================================================================

export async function handleViewService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const pm = requirePanelManager();
  const vm = getViewManager();

  switch (method) {
    case "setBounds": {
      const [viewId, bounds] = args as [string, { x: number; y: number; width: number; height: number }];
      vm.setViewBounds(viewId, bounds);
      return;
    }

    case "setVisible": {
      const [viewId, visible] = args as [string, boolean];
      vm.setViewVisible(viewId, visible);
      return;
    }

    case "setThemeCss": {
      const css = args[0] as string;
      vm.setThemeCss(css);
      return;
    }

    case "updateLayout": {
      const layoutUpdate = args[0] as { titleBarHeight?: number; sidebarVisible?: boolean; sidebarWidth?: number };
      vm.updateLayout(layoutUpdate);
      return;
    }

    case "browserNavigate": {
      const [browserId, url] = args as [string, string];
      await vm.navigateView(browserId, url);
      return;
    }

    case "browserGoBack": {
      const browserId = args[0] as string;
      await pm.goBack(browserId);
      return;
    }

    case "browserGoForward": {
      const browserId = args[0] as string;
      await pm.goForward(browserId);
      return;
    }

    case "browserReload": {
      const browserId = args[0] as string;
      vm.reload(browserId);
      return;
    }

    case "browserStop": {
      const browserId = args[0] as string;
      vm.stop(browserId);
      return;
    }

    default:
      throw new Error(`Unknown view method: ${method}`);
  }
}

// =============================================================================
// Menu Service Handler
// =============================================================================

export async function handleMenuService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const vm = getViewManager();

  switch (method) {
    case "showHamburger": {
      const position = args[0] as { x: number; y: number };
      const shellContents = vm.getShellWebContents();

      const clearBuildCache = async () => {
        // Use the same logic as the clearBuildCache IPC handler (app.clearBuildCache)
        const { getTypeDefinitionService } = await import("../typecheck/service.js");
        await getTypeDefinitionService().invalidateNatstackTypes();
        const { clearAllCaches } = await import("../cacheUtils.js");
        await clearAllCaches({
          buildCache: true,
          buildArtifacts: true,
          typesCache: true,
          verdaccioStorage: true, // Clear Verdaccio to avoid stale @natstack packages
          npmCache: false,
          pnpmStore: false,
        });
        // Clear Verdaccio's in-memory caches (version cache, package discovery, ESM transformer)
        if (_serverClient) {
          try { await _serverClient.call("verdaccio", "clearCaches", []); } catch {}
        }
        // Invalidate ready panels: reset state AND unload WebContents
        try {
          const pm = requirePanelManager();
          pm.invalidateReadyPanels();
        } catch (error) {
          console.warn("[App] Failed to invalidate panel states:", error);
        }
        console.log("[App] Build cache cleared via hamburger menu");
      };

      const pm = requirePanelManager();
      const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache, {
        onHistoryBack: () => {
          const panelId = pm.getFocusedPanelId();
          if (!panelId || !pm.getPanel(panelId)) return;
          void pm.goBack(panelId).catch((error) => {
            console.error(`[Menu] Failed to navigate back for ${panelId}:`, error);
          });
        },
        onHistoryForward: () => {
          const panelId = pm.getFocusedPanelId();
          if (!panelId || !pm.getPanel(panelId)) return;
          void pm.goForward(panelId).catch((error) => {
            console.error(`[Menu] Failed to navigate forward for ${panelId}:`, error);
          });
        },
      });
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: vm.getWindow(), x: position.x, y: position.y });
      return;
    }

    case "showContext": {
      const [items, position] = args as [
        Array<{ id: string; label: string }>,
        { x: number; y: number }
      ];
      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = items.map((item) => ({
          label: item.label,
          click: () => resolve(item.id),
        }));

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window: vm.getWindow(),
          x: position.x,
          y: position.y,
          callback: () => resolve(null),
        });
      });
    }

    case "showPanelContext": {
      const [_panelId, panelType, position] = args as [
        string,
        string,
        { x: number; y: number }
      ];

      return new Promise<PanelContextMenuAction | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];

        if (panelType === "app" || panelType === "browser" || panelType === "shell") {
          template.push({
            label: "Reload",
            click: () => resolve("reload"),
          });
          template.push({ type: "separator" });
        }

        template.push({
          label: "Unload",
          click: () => resolve("unload"),
        });

        template.push({ type: "separator" });

        template.push({
          label: "Archive",
          click: () => resolve("archive"),
        });

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window: vm.getWindow(),
          x: position.x,
          y: position.y,
          callback: () => resolve(null),
        });
      });
    }

    default:
      throw new Error(`Unknown menu method: ${method}`);
  }
}

// =============================================================================
// Workspace Service Handler
// =============================================================================

export async function handleWorkspaceService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case "validatePath": {
      const workspacePath = args[0] as string;
      const resolvedPath = path.resolve(workspacePath);
      const configPath = path.join(resolvedPath, "natstack.yml");

      // Check if directory exists
      if (!fs.existsSync(resolvedPath)) {
        return {
          path: resolvedPath,
          name: path.basename(resolvedPath),
          isValid: false,
          hasConfig: false,
          error: "Directory does not exist",
        } as WorkspaceValidation;
      }

      // Check if it's a directory
      try {
        const stats = fs.statSync(resolvedPath);
        if (!stats.isDirectory()) {
          return {
            path: resolvedPath,
            name: path.basename(resolvedPath),
            isValid: false,
            hasConfig: false,
            error: "Path is not a directory",
          } as WorkspaceValidation;
        }
      } catch (error) {
        return {
          path: resolvedPath,
          name: path.basename(resolvedPath),
          isValid: false,
          hasConfig: false,
          error: error instanceof Error ? error.message : "Failed to access path",
        } as WorkspaceValidation;
      }

      // Check for natstack.yml
      const hasConfig = fs.existsSync(configPath);
      let name = path.basename(resolvedPath);
      let errorMessage: string | undefined;

      if (hasConfig) {
        try {
          const config = loadWorkspaceConfig(resolvedPath, { createIfMissing: false });
          name = config.id || name;
        } catch (error) {
          errorMessage = `Invalid workspace config: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      return {
        path: resolvedPath,
        name,
        isValid: !errorMessage,
        hasConfig,
        error: errorMessage,
      } as WorkspaceValidation;
    }

    case "openFolderDialog": {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Select Workspace Folder",
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    }

    case "create": {
      const [workspacePath, name] = args as [string, string];
      const resolvedPath = path.resolve(workspacePath);

      try {
        // Ensure directory exists
        fs.mkdirSync(resolvedPath, { recursive: true });

        // Create workspace structure
        fs.mkdirSync(path.join(resolvedPath, "panels"), { recursive: true });
        fs.mkdirSync(path.join(resolvedPath, ".cache"), { recursive: true });

        // Create natstack.yml with a random port
        const randomPort = 49152 + Math.floor(Math.random() * 16383);
        const configContent = `# NatStack Workspace Configuration
id: ${name}

git:
  port: ${randomPort}
`;
        fs.writeFileSync(path.join(resolvedPath, "natstack.yml"), configContent, "utf-8");

        return {
          path: resolvedPath,
          name,
          isValid: true,
          hasConfig: true,
        } as WorkspaceValidation;
      } catch (error) {
        return {
          path: resolvedPath,
          name,
          isValid: false,
          hasConfig: false,
          error: error instanceof Error ? error.message : String(error),
        } as WorkspaceValidation;
      }
    }

    case "select": {
      const workspacePath = args[0] as string;
      // Add to recent workspaces
      const centralData = getCentralData();
      try {
        const config = loadWorkspaceConfig(workspacePath, { createIfMissing: false });
        centralData.addRecentWorkspace(workspacePath, config.id);
      } catch {
        centralData.addRecentWorkspace(workspacePath, path.basename(workspacePath));
      }

      // Re-launch the app with the selected workspace
      app.relaunch({ args: [...process.argv.slice(1), `--workspace=${workspacePath}`] });
      app.exit(0);
      return;
    }

    default:
      throw new Error(`Unknown workspace method: ${method}`);
  }
}

// =============================================================================
// Central Service Handler (recent workspaces)
// =============================================================================

export async function handleCentralService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const centralData = getCentralData();

  switch (method) {
    case "getRecentWorkspaces":
      return centralData.getRecentWorkspaces();

    case "addRecentWorkspace": {
      const workspacePath = args[0] as string;
      centralData.addRecentWorkspace(workspacePath, path.basename(workspacePath));
      return;
    }

    case "removeRecentWorkspace": {
      const workspacePath = args[0] as string;
      centralData.removeRecentWorkspace(workspacePath);
      return;
    }

    default:
      throw new Error(`Unknown central method: ${method}`);
  }
}

// =============================================================================
// Settings Service Handler
// =============================================================================

export async function handleSettingsService(
  _ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case "getData": {
      const centralConfig = loadCentralConfig();
      const supportedProviders = getSupportedProviders();
      const envVars = getProviderEnvVars();
      const secrets = loadSecrets();

      // Fetch models dynamically for configured providers (in parallel)
      const fetchedModels = new Map<SupportedProvider, FetchedModel[]>();
      const fetchPromises = supportedProviders.map(async (providerId) => {
        const cliAuth = usesCliAuth(providerId);
        const hasKey = hasProviderApiKey(providerId);
        const isEnabled = cliAuth ? secrets[providerId] === "enabled" : false;

        // Only fetch for providers with API keys or enabled CLI providers
        if (hasKey || (cliAuth && isEnabled)) {
          const apiKey = getApiKeyForProvider(providerId, envVars, secrets);
          if (apiKey || cliAuth) {
            try {
              const models = await fetchModelsForProvider(providerId, apiKey ?? "");
              if (models && models.length > 0) {
                fetchedModels.set(providerId, models);
              }
            } catch (error) {
              console.warn(`[Settings] Failed to fetch models for ${providerId}:`, error);
            }
          }
        }
      });

      // Wait for all fetches with a timeout
      await Promise.race([
        Promise.all(fetchPromises),
        new Promise((resolve) => setTimeout(resolve, 15000)), // 15s overall timeout
      ]);

      // Build provider info list with fetched or default models
      const providers: ProviderInfo[] = supportedProviders.map((providerId) => {
        const cliAuth = usesCliAuth(providerId);
        const fetched = fetchedModels.get(providerId);
        const models = fetched
          ? fetched.map((m) => m.id)
          : getDefaultModelsForProvider(providerId).map((m) => m.id);

        return {
          id: providerId,
          name: getProviderDisplayName(providerId),
          hasApiKey: hasProviderApiKey(providerId),
          models,
          usesCliAuth: cliAuth,
          isEnabled: cliAuth ? secrets[providerId] === "enabled" : undefined,
        };
      });

      // Build available providers list
      const availableProviders: AvailableProvider[] = supportedProviders.map((providerId) => ({
        id: providerId,
        name: getProviderDisplayName(providerId),
        envVar: envVars[providerId],
        usesCliAuth: usesCliAuth(providerId),
      }));

      // Get model roles
      const modelRoles: ModelRoleConfig = {};
      if (centralConfig.models) {
        for (const [role, value] of Object.entries(centralConfig.models)) {
          if (typeof value === "string") {
            modelRoles[role] = value;
          } else if (value && typeof value === "object" && "provider" in value && "model" in value) {
            modelRoles[role] = `${value.provider}:${value.model}`;
          }
        }
      }

      return {
        providers,
        modelRoles,
        availableProviders,
        hasConfiguredProviders: hasConfiguredProviders(),
      } as SettingsData;
    }

    case "setApiKey": {
      const [providerId, apiKey] = args as [string, string];
      const secrets = loadSecrets();
      secrets[providerId] = apiKey;
      saveSecrets(secrets);

      // Update process.env
      const envVars = getProviderEnvVars();
      const envVar = envVars[providerId as SupportedProvider];
      if (envVar) {
        process.env[envVar] = apiKey;
      }

      await refreshAiProviders();
      return;
    }

    case "removeApiKey": {
      const providerId = args[0] as string;
      const secrets = loadSecrets();
      delete secrets[providerId];
      saveSecrets(secrets);

      // Remove from process.env
      const envVars = getProviderEnvVars();
      const envVar = envVars[providerId as SupportedProvider];
      if (envVar) {
        delete process.env[envVar];
      }

      await refreshAiProviders();
      return;
    }

    case "setModelRole": {
      const [role, modelSpec] = args as [string, string];
      const config = loadCentralConfig();
      if (!config.models) {
        config.models = {};
      }
      config.models[role] = modelSpec;
      saveCentralConfig(config);

      await refreshAiProviders();
      return;
    }

    case "enableProvider": {
      const providerId = args[0] as string;
      if (!usesCliAuth(providerId as SupportedProvider)) {
        console.warn(`[Settings] Cannot enable provider ${providerId} - not a CLI-auth provider`);
        return;
      }

      const secrets = loadSecrets();
      secrets[providerId] = "enabled";
      saveSecrets(secrets);

      await refreshAiProviders();
      return;
    }

    case "disableProvider": {
      const providerId = args[0] as string;
      if (!usesCliAuth(providerId as SupportedProvider)) {
        console.warn(`[Settings] Cannot disable provider ${providerId} - not a CLI-auth provider`);
        return;
      }

      const secrets = loadSecrets();
      delete secrets[providerId];
      saveSecrets(secrets);

      await refreshAiProviders();
      return;
    }

    default:
      throw new Error(`Unknown settings method: ${method}`);
  }
}
