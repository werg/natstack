/**
 * Configuration loading for NatStack.
 *
 * Two configuration sources:
 * 1. Central config (~/.config/natstack/): Models, secrets, env vars (shared)
 * 2. Workspace (project with natstack.yml): ID, git port, root panel, panels
 *
 * Discovery priority for workspace:
 * 1. CLI argument: --workspace=/path/to/workspace
 * 2. Environment variable: NATSTACK_WORKSPACE
 * 3. Walk up from cwd looking for natstack.yml
 * 4. Fall back to default workspace in userData directory
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app } from "electron";
import YAML from "yaml";
import dotenv from "dotenv";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("Workspace");
import type { Workspace, WorkspaceConfig, CentralConfig, CentralConfigPaths } from "./types.js";

const WORKSPACE_CONFIG_FILE = "natstack.yml";
const CENTRAL_CONFIG_FILE = "config.yml";
const SECRETS_FILE = ".secrets.yml";
const ENV_FILE = ".env";

// =============================================================================
// Central Config
// =============================================================================

/**
 * Get the central config directory path.
 * Uses Electron's userData path which is platform-specific:
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 */
export function getCentralConfigDir(): string {
  try {
    return app.getPath("userData");
  } catch {
    // Fallback if app not ready
    const home = os.homedir();
    switch (process.platform) {
      case "win32": {
        const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
        return path.join(appData, "natstack");
      }
      case "darwin":
        return path.join(home, "Library", "Application Support", "natstack");
      default: {
        const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
        return path.join(xdgConfig, "natstack");
      }
    }
  }
}

const DATA_FILE = "data.json";

/**
 * Get all central config paths
 */
export function getCentralConfigPaths(): CentralConfigPaths {
  const configDir = getCentralConfigDir();
  return {
    configDir,
    configPath: path.join(configDir, CENTRAL_CONFIG_FILE),
    secretsPath: path.join(configDir, SECRETS_FILE),
    envPath: path.join(configDir, ENV_FILE),
    dataPath: path.join(configDir, DATA_FILE),
  };
}

/**
 * Load central config from ~/.config/natstack/config.yml
 */
export function loadCentralConfig(): CentralConfig {
  const paths = getCentralConfigPaths();

  if (!fs.existsSync(paths.configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(paths.configPath, "utf-8");
    return (YAML.parse(content) as CentralConfig) ?? {};
  } catch (error) {
    console.warn(`[Config] Failed to load ${paths.configPath}:`, error);
    return {};
  }
}

/**
 * Load secrets from central .secrets.yml
 * Format: providername: secret (flat key-value)
 */
export function loadSecrets(): Record<string, string> {
  const paths = getCentralConfigPaths();

  if (!fs.existsSync(paths.secretsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(paths.secretsPath, "utf-8");
    const secrets = YAML.parse(content) as Record<string, string>;
    return secrets ?? {};
  } catch (error) {
    console.warn(`[Config] Failed to load ${paths.secretsPath}:`, error);
    return {};
  }
}

/**
 * Load environment from central .env file into process.env
 */
export function loadCentralEnvFile(): void {
  const paths = getCentralConfigPaths();

  if (fs.existsSync(paths.envPath)) {
    dotenv.config({ path: paths.envPath });
  }
}

/**
 * Map secrets to standard environment variable names for providers
 */
function mapSecretsToEnv(secrets: Record<string, string>): void {
  const providerEnvMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    groq: "GROQ_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    together: "TOGETHER_API_KEY",
    replicate: "REPLICATE_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
    github: "GITHUB_TOKEN", // For transparent GitHub repo cloning
  };

  for (const [provider, secret] of Object.entries(secrets)) {
    const envVar = providerEnvMap[provider.toLowerCase()];
    if (envVar && secret) {
      // Only set if not already set (env file takes precedence over secrets file)
      if (!process.env[envVar]) {
        process.env[envVar] = secret;
      }
    }
  }
}

/**
 * Load all central environment (both .env file and .secrets.yml)
 */
export function loadCentralEnv(): void {
  // 1. Load .env file first
  loadCentralEnvFile();

  // 2. Load secrets and map to env vars
  const secrets = loadSecrets();
  mapSecretsToEnv(secrets);
}

/**
 * Save secrets to central .secrets.yml
 */
export function saveSecrets(secrets: Record<string, string>): void {
  const paths = getCentralConfigPaths();

  try {
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.secretsPath, YAML.stringify(secrets), "utf-8");

    // Update process.env with new secrets
    mapSecretsToEnv(secrets);
  } catch (error) {
    console.error("[Config] Failed to save secrets:", error);
    throw error;
  }
}

/**
 * Save central config to ~/.config/natstack/config.yml
 */
export function saveCentralConfig(config: CentralConfig): void {
  const paths = getCentralConfigPaths();

  try {
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configPath, YAML.stringify(config), "utf-8");
  } catch (error) {
    console.error("[Config] Failed to save central config:", error);
    throw error;
  }
}

// =============================================================================
// Workspace
// =============================================================================

/**
 * Parse --workspace=<path> from command line arguments
 */
export function parseCliWorkspacePath(): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) {
      return arg.slice("--workspace=".length);
    }
  }
  // Handle --workspace <path> format
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1) {
    const nextArg = process.argv[idx + 1];
    if (nextArg && !nextArg.startsWith("--")) {
      return nextArg;
    }
  }
  return undefined;
}

/**
 * Walk up the directory tree looking for natstack.yml
 */
function findWorkspaceByWalkUp(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    const configPath = path.join(current, WORKSPACE_CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Get the default workspace path in the user's config directory
 */
function getDefaultWorkspacePath(): string {
  try {
    return path.join(app.getPath("userData"), "default-workspace");
  } catch {
    // Fallback if app not ready
    return path.join(process.cwd(), ".natstack-workspace");
  }
}

/**
 * Create a default workspace configuration with full scaffolding.
 * This is the first-run experience for new users.
 */
function createDefaultWorkspaceConfig(workspacePath: string): WorkspaceConfig {
  const configPath = path.join(workspacePath, WORKSPACE_CONFIG_FILE);

  // Generate a simple ID
  const id = `workspace-${Date.now().toString(36)}`;

  // Create workspace config that references shipped panels
  // In production, these will be loaded from pre-built bundles
  const config: WorkspaceConfig = {
    id,
    // Root panel to show when workspace opens (uses shipped chat-launcher)
    rootPanel: "panels/chat-launcher",
  };

  console.log(`[Workspace] Creating default workspace at ${workspacePath}`);

  // Create workspace directory structure
  fs.mkdirSync(workspacePath, { recursive: true });

  // Core directories
  fs.mkdirSync(path.join(workspacePath, "panels"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "workers"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "packages"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "contexts"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".cache"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".databases"), { recursive: true });

  // Write config with helpful comments
  const configContent = `# NatStack Workspace Configuration
# Generated: ${new Date().toISOString()}

# Unique workspace identifier
id: ${id}

# Default panel to open when workspace loads
# In production, this uses the shipped chat-launcher panel
rootPanel: panels/chat-launcher

# Git server configuration (optional)
# git:
#   port: 7878
#   github:
#     token: \${GITHUB_TOKEN}  # Can use environment variable

# Custom panels can be added to the panels/ directory
# Each panel needs a package.json with a natstack configuration
`;

  fs.writeFileSync(configPath, configContent, "utf-8");

  console.log(`[Workspace] Default workspace created successfully`);

  return config;
}

/**
 * Discover the workspace directory.
 *
 * Priority:
 * 1. CLI argument (--workspace=<path>)
 * 2. Environment variable (NATSTACK_WORKSPACE)
 * 3. Walk up from cwd looking for natstack.yml
 * 4. Default workspace in userData
 */
export function discoverWorkspace(cliPath?: string): string {
  // 1. CLI argument
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(path.join(resolved, WORKSPACE_CONFIG_FILE))) {
      return resolved;
    }
    // If the path exists but no config, we'll create one
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    console.warn(`[Workspace] CLI path ${cliPath} does not exist, ignoring`);
  }

  // 2. Environment variable
  const envPath = process.env["NATSTACK_WORKSPACE"];
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    console.warn(`[Workspace] NATSTACK_WORKSPACE path ${envPath} does not exist, ignoring`);
  }

  // 3. Walk up from cwd
  const walkUpResult = findWorkspaceByWalkUp(process.cwd());
  if (walkUpResult) {
    return walkUpResult;
  }

  // 4. Default workspace
  return getDefaultWorkspacePath();
}

/**
 * Load and parse natstack.yml from a workspace directory
 */
export function loadWorkspaceConfig(
  workspacePath: string,
  options?: { createIfMissing?: boolean }
): WorkspaceConfig {
  const configPath = path.join(workspacePath, WORKSPACE_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    if (options?.createIfMissing) {
      log.verbose(` No ${WORKSPACE_CONFIG_FILE} found, creating default`);
      return createDefaultWorkspaceConfig(workspacePath);
    }
    throw new Error(`${WORKSPACE_CONFIG_FILE} not found at ${workspacePath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = YAML.parse(content) as WorkspaceConfig;

  // Ensure required fields
  if (!config.id) {
    config.id = `workspace-${Date.now().toString(36)}`;
  }

  return config;
}

/**
 * Create a fully resolved Workspace object
 */
export function createWorkspace(
  workspacePath: string,
  options?: { createIfMissing?: boolean }
): Workspace {
  const resolvedPath = path.resolve(workspacePath);

  // Workspace directories (no state/ prefix)
  const panelsPath = path.join(resolvedPath, "panels");
  const workersPath = path.join(resolvedPath, "workers");
  const packagesPath = path.join(resolvedPath, "packages");
  const contextsPath = path.join(resolvedPath, "contexts");
  const gitReposPath = resolvedPath;
  const cachePath = path.join(resolvedPath, ".cache");

  // Only create directories/config when explicitly allowed
  const configPath = path.join(resolvedPath, WORKSPACE_CONFIG_FILE);
  const configExists = fs.existsSync(configPath);
  if (!configExists && !options?.createIfMissing) {
    throw new Error(`Workspace config not found at ${configPath}`);
  }

  // Ensure directory structure when creating/loading explicitly
  if (options?.createIfMissing || configExists) {
    fs.mkdirSync(panelsPath, { recursive: true });
    fs.mkdirSync(contextsPath, { recursive: true });
    fs.mkdirSync(gitReposPath, { recursive: true });
    fs.mkdirSync(cachePath, { recursive: true });
    // Note: workersPath and packagesPath are not created automatically
    // They're optional and users create them when needed
  }

  // Load config (creates default if missing)
  const config = loadWorkspaceConfig(resolvedPath, { createIfMissing: options?.createIfMissing });

  return {
    path: resolvedPath,
    config,
    panelsPath,
    workersPath,
    packagesPath,
    contextsPath,
    gitReposPath,
    cachePath,
  };
}
