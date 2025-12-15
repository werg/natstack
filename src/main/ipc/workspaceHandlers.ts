/**
 * IPC handlers for workspace chooser, settings, and central data.
 */

import * as fs from "fs";
import * as path from "path";
import { app, dialog } from "electron";
import { handle } from "./handlers.js";
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
import type { SupportedProvider } from "../workspace/types.js";
import type {
  RecentWorkspace,
  WorkspaceValidation,
  SettingsData,
  ProviderInfo,
  AvailableProvider,
  AppMode,
  ModelRoleConfig,
} from "../../shared/ipc/types.js";
import { aiHandler } from "../index.js";

// App mode state
let currentAppMode: AppMode = "chooser";

/**
 * Set the current app mode
 */
export function setAppMode(mode: AppMode): void {
  currentAppMode = mode;
}

/**
 * Get the current app mode
 */
export function getAppMode(): AppMode {
  return currentAppMode;
}

/**
 * Check if any AI providers are configured (either in secrets file or environment).
 * This determines if the user needs to go through initial setup.
 *
 * We check both secrets file AND process.env because:
 * - Secrets file contains user-configured keys via UI
 * - process.env may contain keys from .env file or system environment
 * - CLI-auth providers (like claude-code) store "enabled" in secrets
 */
export function hasConfiguredProviders(): boolean {
  const providers = getSupportedProviders();
  const secrets = loadSecrets();

  // Check if any provider has an API key available (from any source)
  // OR is a CLI-auth provider that's been enabled
  return providers.some((providerId) => {
    if (usesCliAuth(providerId)) {
      return secrets[providerId] === "enabled";
    }
    return hasProviderApiKey(providerId);
  });
}

/**
 * Refresh AI providers and model roles after settings changes.
 */
async function refreshAiProviders(): Promise<void> {
  if (!aiHandler) return;
  try {
    await aiHandler.initialize();
  } catch (error) {
    console.error("[Settings] Failed to refresh AI providers:", error);
  }
}

// =============================================================================
// Central Data Handlers (Recent Workspaces)
// =============================================================================

handle("central:get-recent-workspaces", async (): Promise<RecentWorkspace[]> => {
  const centralData = getCentralData();
  return centralData.getRecentWorkspaces();
});

handle("central:add-recent-workspace", async (_event, workspacePath: string): Promise<void> => {
  const centralData = getCentralData();
  // Try to get the workspace name from config
  let name = path.basename(workspacePath);
  try {
    const config = loadWorkspaceConfig(workspacePath, { createIfMissing: false });
    name = config.id || name;
  } catch {
    // Use folder name as fallback
  }
  centralData.addRecentWorkspace(workspacePath, name);
});

handle("central:remove-recent-workspace", async (_event, workspacePath: string): Promise<void> => {
  const centralData = getCentralData();
  centralData.removeRecentWorkspace(workspacePath);
});

// =============================================================================
// Workspace Management Handlers
// =============================================================================

handle(
  "workspace:validate-path",
  async (_event, workspacePath: string): Promise<WorkspaceValidation> => {
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
      };
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
        };
      }
    } catch (error) {
      return {
        path: resolvedPath,
        name: path.basename(resolvedPath),
        isValid: false,
        hasConfig: false,
        error: error instanceof Error ? error.message : "Failed to access path",
      };
    }

    // Check for natstack.yml (configPath already declared above)
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
    };
  }
);

handle("workspace:open-folder-dialog", async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Select Workspace Folder",
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0] ?? null;
});

handle(
  "workspace:create",
  async (_event, workspacePath: string, name: string): Promise<WorkspaceValidation> => {
    const resolvedPath = path.resolve(workspacePath);

    try {
      // Ensure directory exists
      fs.mkdirSync(resolvedPath, { recursive: true });

      // Create workspace structure
      fs.mkdirSync(path.join(resolvedPath, "panels"), { recursive: true });
      fs.mkdirSync(path.join(resolvedPath, ".cache"), { recursive: true });

      // Create natstack.yml with a random port in a safe range
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
      };
    } catch (error) {
      return {
        path: resolvedPath,
        name,
        isValid: false,
        hasConfig: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

handle("workspace:select", async (_event, workspacePath: string): Promise<void> => {
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
});

// =============================================================================
// Settings Handlers
// =============================================================================

handle("settings:get-data", async (): Promise<SettingsData> => {
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
      // For CLI auth providers, check if enabled in secrets (stored as "enabled" value)
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

  // Get model roles (simplified to string format for UI)
  const modelRoles: ModelRoleConfig = {};
  if (centralConfig.models) {
    for (const [role, value] of Object.entries(centralConfig.models)) {
      if (typeof value === "string") {
        modelRoles[role] = value;
      } else if (value && typeof value === "object" && "provider" in value && "model" in value) {
        // Convert ModelConfig to string format
        modelRoles[role] = `${value.provider}:${value.model}`;
      }
    }
  }

  return {
    providers,
    modelRoles,
    availableProviders,
    hasConfiguredProviders: hasConfiguredProviders(),
  };
});

handle(
  "settings:set-api-key",
  async (_event, providerId: string, apiKey: string): Promise<void> => {
    const secrets = loadSecrets();
    secrets[providerId] = apiKey;
    saveSecrets(secrets);

    // Also update process.env so changes take effect immediately
    const envVars = getProviderEnvVars();
    const envVar = envVars[providerId as SupportedProvider];
    if (envVar) {
      process.env[envVar] = apiKey;
    }

    await refreshAiProviders();
  }
);

handle("settings:remove-api-key", async (_event, providerId: string): Promise<void> => {
  const secrets = loadSecrets();
  delete secrets[providerId];
  saveSecrets(secrets);

  // Also remove from process.env
  const envVars = getProviderEnvVars();
  const envVar = envVars[providerId as SupportedProvider];
  if (envVar) {
    delete process.env[envVar];
  }

  await refreshAiProviders();
});

handle(
  "settings:set-model-role",
  async (_event, role: string, modelSpec: string): Promise<void> => {
    const config = loadCentralConfig();
    if (!config.models) {
      config.models = {};
    }
    config.models[role] = modelSpec;
    saveCentralConfig(config);

    await refreshAiProviders();
  }
);

handle("settings:enable-provider", async (_event, providerId: string): Promise<void> => {
  // Only allow enabling CLI-auth providers
  if (!usesCliAuth(providerId as SupportedProvider)) {
    console.warn(`[Settings] Cannot enable provider ${providerId} - not a CLI-auth provider`);
    return;
  }

  const secrets = loadSecrets();
  secrets[providerId] = "enabled";
  saveSecrets(secrets);

  await refreshAiProviders();
});

handle("settings:disable-provider", async (_event, providerId: string): Promise<void> => {
  // Only allow disabling CLI-auth providers
  if (!usesCliAuth(providerId as SupportedProvider)) {
    console.warn(`[Settings] Cannot disable provider ${providerId} - not a CLI-auth provider`);
    return;
  }

  const secrets = loadSecrets();
  delete secrets[providerId];
  saveSecrets(secrets);

  await refreshAiProviders();
});

// =============================================================================
// App Mode Handlers
// =============================================================================

handle("app:get-mode", async (): Promise<AppMode> => {
  return currentAppMode;
});
