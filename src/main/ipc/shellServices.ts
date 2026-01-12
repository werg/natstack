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
} from "../../shared/ipc/types.js";
import type { SupportedProvider } from "../workspace/types.js";
import { getViewManager } from "../viewManager.js";
import { getMainCacheManager } from "../cacheManager.js";
import { getBuildArtifactsDirectory } from "../paths.js";
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

// These will be set during initialization to avoid circular dependencies
let _panelManager: import("../panelManager.js").PanelManager | null = null;
let _currentAppMode: AppMode = "chooser";
let _aiHandler: import("../ai/aiHandler.js").AIHandler | null = null;

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
 * Set the AI handler instance (called during initialization).
 */
export function setShellServicesAiHandler(handler: import("../ai/aiHandler.js").AIHandler | null): void {
  _aiHandler = handler;
}

function requirePanelManager(): import("../panelManager.js").PanelManager {
  if (!_panelManager) {
    throw new Error("Panel operations not available in workspace chooser mode");
  }
  return _panelManager;
}

/**
 * Refresh AI providers after settings changes.
 */
async function refreshAiProviders(): Promise<void> {
  if (!_aiHandler) return;
  try {
    await _aiHandler.initialize();
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
      const cacheManager = getMainCacheManager();
      await cacheManager.clear();
      const artifactsDir = getBuildArtifactsDirectory();
      if (fs.existsSync(artifactsDir)) {
        fs.rmSync(artifactsDir, { recursive: true, force: true });
      }
      console.log("[App] Build cache and artifacts cleared");
      return;
    }

    case "getMode":
      return _currentAppMode;

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
      pm.sendPanelEvent(panelId, { type: "focus" });
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
        throw new Error(`No view found for panel ${panelId}`);
      }
      vm.reload(panelId);
      return;
    }

    case "close": {
      const panelId = args[0] as string;
      await pm.closePanel(panelId);
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

    case "browserNavigate": {
      const [browserId, url] = args as [string, string];
      await vm.navigateView(browserId, url);
      return;
    }

    case "browserGoBack": {
      const browserId = args[0] as string;
      vm.goBack(browserId);
      return;
    }

    case "browserGoForward": {
      const browserId = args[0] as string;
      vm.goForward(browserId);
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
        const cacheManager = getMainCacheManager();
        await cacheManager.clear();
        console.log("[App] Build cache cleared via menu");
      };

      const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache);
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

        if (panelType === "app" || panelType === "browser") {
          template.push({
            label: "Reload",
            click: () => resolve("reload"),
          });
          template.push({ type: "separator" });
        }

        template.push({
          label: "Close",
          click: () => resolve("close"),
        });
        template.push({
          label: "Close Siblings",
          click: () => resolve("close-siblings"),
        });
        template.push({
          label: "Close Subtree",
          click: () => resolve("close-subtree"),
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

root-panel: panels/root
`;
        fs.writeFileSync(path.join(resolvedPath, "natstack.yml"), configContent, "utf-8");

        // Create a minimal root panel
        const rootPanelPath = path.join(resolvedPath, "panels", "root");
        fs.mkdirSync(rootPanelPath, { recursive: true });

        const packageJson = {
          name: "@natstack-panels/root",
          type: "module",
          natstack: {
            title: "Root Panel",
            entry: "index.tsx",
          },
        };
        fs.writeFileSync(
          path.join(rootPanelPath, "package.json"),
          JSON.stringify(packageJson, null, 2),
          "utf-8"
        );

        const indexTsx = `import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { usePanelTheme, usePanelId } from "@natstack/react";

export default function RootPanel() {
  const theme = usePanelTheme();
  const panelId = usePanelId();

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3">
        <Flex direction="column" gap="4">
          <Heading size="6">Hello NatStack!</Heading>
          <Text>Theme: {theme.appearance}</Text>
          <Text>Panel ID: {panelId}</Text>
          <Button>Click me</Button>
        </Flex>
      </Card>
    </div>
  );
}
`;
        fs.writeFileSync(path.join(rootPanelPath, "index.tsx"), indexTsx, "utf-8");

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

      // Build provider info list
      const providers: ProviderInfo[] = supportedProviders.map((providerId) => {
        const cliAuth = usesCliAuth(providerId);
        return {
          id: providerId,
          name: getProviderDisplayName(providerId),
          hasApiKey: hasProviderApiKey(providerId),
          models: getDefaultModelsForProvider(providerId).map((m) => m.id),
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
