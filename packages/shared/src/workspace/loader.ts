/**
 * Configuration loading for NatStack.
 *
 * Two configuration sources:
 * 1. Central config (~/.config/natstack/): Models, secrets, env vars (shared)
 * 2. Workspace (~/.config/natstack/workspaces/{name}/): natstack.yml, panels, etc.
 *
 * Workspace resolution: CLI --workspace=name → NATSTACK_WORKSPACE env → null (show init UI)
 */

import * as fs from "fs";
import * as path from "path";
import { getCentralDataPath, getWorkspacesDir, getWorkspaceDir } from "@natstack/env-paths";
import YAML from "yaml";
import dotenv from "dotenv";
import { createDevLogger } from "@natstack/dev-log";
import { execFileSync } from "child_process";

const log = createDevLogger("Workspace");
import type { Workspace, WorkspaceConfig, CentralConfig, CentralConfigPaths, WorkspaceEntry } from "./types.js";
import type { CentralDataManager } from "../centralData.js";
import { WORKSPACE_GIT_INIT_PATTERNS, WORKSPACE_SOURCE_DIRS, WORKSPACE_STATE_DIRS } from "./sourceDirs.js";

const WORKSPACE_CONFIG_FILE = "meta/natstack.yml";
const CENTRAL_CONFIG_FILE = "config.yml";
const SECRETS_FILE = ".secrets.yml";
const ENV_FILE = ".env";

// =============================================================================
// Central Config
// =============================================================================

/**
 * Get the central config directory path (shared across all workspaces).
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 */
export function getCentralConfigDir(): string {
  return getCentralDataPath();
}

// Central-config dir management + admin-token helpers live in `centralAuth.ts`
// (they're central-data concerns, not workspace concerns). Re-exported here
// for backwards compatibility with existing importers.
import {
  ensureCentralConfigDir,
  getAdminTokenPath,
  loadPersistedAdminToken,
  savePersistedAdminToken,
} from "../centralAuth.js";
export {
  ensureCentralConfigDir,
  getAdminTokenPath,
  loadPersistedAdminToken,
  savePersistedAdminToken,
};

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
 * Map old `claude-agent:*` model role values to their Pi-compatible
 * `anthropic:*` equivalents. Pi handles all provider routing now, so the
 * Claude Agent CLI provider was deleted in Phase 5; older user configs are
 * silently upgraded on first load and persisted back to disk.
 *
 * Returns the migrated value or null if the input was not a claude-agent ref.
 */
function migrateClaudeAgentModelValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^claude-agent:(.+)$/);
  if (!match) return null;
  const suffix = match[1]!;
  switch (suffix) {
    case "opus":
      return "anthropic:claude-opus-4-5";
    case "sonnet":
      return "anthropic:claude-sonnet-4-20250514";
    case "haiku":
      return "anthropic:claude-haiku-4-5-20251001";
    default:
      return `anthropic:${suffix}`;
  }
}

/**
 * Walk parsed.models.* and migrate any claude-agent:* values to anthropic:*.
 * Mutates the input object. Returns true if any value was changed.
 */
function migrateClaudeAgentModelsConfig(parsed: CentralConfig): boolean {
  if (!parsed.models || typeof parsed.models !== "object") return false;
  let mutated = false;
  for (const [role, value] of Object.entries(parsed.models)) {
    const migrated = migrateClaudeAgentModelValue(value);
    if (migrated !== null) {
      console.warn(
        `[NatStack] Migrated old model role 'claude-agent:${(value as string).slice("claude-agent:".length)}' → '${migrated}' in models.${role}`,
      );
      (parsed.models as Record<string, unknown>)[role] = migrated;
      mutated = true;
    }
  }
  return mutated;
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
    const parsed = (YAML.parse(content) as CentralConfig) ?? {};

    // One-time silent migration: rewrite claude-agent:* values to anthropic:*
    // and persist the result so the warning doesn't repeat on every load.
    const mutated = migrateClaudeAgentModelsConfig(parsed);
    if (mutated) {
      try {
        // Audit finding #51: secret-bearing config writes must be 0o600
        // regardless of dir perms.
        fs.writeFileSync(paths.configPath, YAML.stringify(parsed), { encoding: "utf-8", mode: 0o600 });
        try { fs.chmodSync(paths.configPath, 0o600); } catch { /* best-effort */ }
      } catch (writeErr) {
        console.warn(
          `[Config] Failed to persist migrated config back to ${paths.configPath}:`,
          writeErr,
        );
      }
    }

    return parsed;
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
  return loadSecretsFromPath(paths.secretsPath);
}

export function loadSecretsFromPath(secretsPath: string): Record<string, string> {
  if (!fs.existsSync(secretsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(secretsPath, "utf-8");
    const secrets = YAML.parse(content) as Record<string, string>;
    return secrets ?? {};
  } catch (error) {
    console.warn(`[Config] Failed to load ${secretsPath}:`, error);
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
 * Load central environment from ~/.config/natstack/.env into process.env
 */
export function loadCentralEnv(): void {
  loadCentralEnvFile();
}

/**
 * Save secrets to central .secrets.yml
 */
export function saveSecrets(secrets: Record<string, string>): void {
  const paths = getCentralConfigPaths();
  saveSecretsToPath(paths.secretsPath, secrets);
}

export function saveSecretsToPath(secretsPath: string, secrets: Record<string, string>): void {
  try {
    // Audit finding #51 (cross-cutting), F-04 / F-17 (creds + filesystem
    // reports): `.secrets.yml` was previously written with default umask
    // (0o644), relying on the parent dir being 0o700. Force 0o600 explicitly
    // and re-chmod after write to repair files created with looser modes by
    // older code.
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsPath, YAML.stringify(secrets), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(secretsPath, 0o600); } catch { /* best-effort */ }
    }
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
    ensureCentralConfigDir();
    // Audit finding #51: central config may carry provider references that
    // imply token presence; treat as secret-adjacent and lock to 0o600.
    fs.writeFileSync(paths.configPath, YAML.stringify(config), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(paths.configPath, 0o600); } catch { /* best-effort */ }
    }
  } catch (error) {
    console.error("[Config] Failed to save central config:", error);
    throw error;
  }
}

// =============================================================================
// Workspace
// =============================================================================

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const WORKSPACE_NAME_MAX_LENGTH = 64;

/**
 * Resolve workspace name from CLI --workspace=name or NATSTACK_WORKSPACE env var.
 * Returns the validated name string or null if neither is set.
 * Throws if the name is present but invalid (prevents path traversal).
 */
export function resolveWorkspaceName(): string | null {
  let raw: string | undefined;

  // 1. CLI argument: --workspace=name or --workspace name
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) {
      raw = arg.slice("--workspace=".length);
      break;
    }
  }
  if (!raw) {
    const idx = process.argv.indexOf("--workspace");
    if (idx !== -1) {
      const nextArg = process.argv[idx + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        raw = nextArg;
      }
    }
  }

  // 2. Environment variable
  if (!raw) {
    raw = process.env["NATSTACK_WORKSPACE"];
  }

  if (!raw) return null;

  // Validate to prevent path traversal (e.g., "../otherdir")
  validateWorkspaceName(raw);
  return raw;
}

/**
 * Validate a workspace name.
 * Must be alphanumeric with hyphens/underscores, max 64 chars.
 */
function validateWorkspaceName(name: string): void {
  if (!name) throw new Error("Workspace name cannot be empty");
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new Error(`Workspace name too long (max ${WORKSPACE_NAME_MAX_LENGTH} chars)`);
  }
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new Error("Workspace name must contain only letters, numbers, hyphens, and underscores");
  }
}

/**
 * Resolve the workspace template directory for first-run workspace creation.
 *
 * In development (NODE_ENV=development): workspace/ at app root (the dev workspace)
 * In production: workspace-template/ in resources directory (or app root for headless)
 *
 * Returns null if no template directory exists.
 */
export function resolveWorkspaceTemplateDir(appRoot: string): string | null {
  const isDev = process.env["NODE_ENV"] === "development";
  if (isDev) {
    const devPath = path.join(appRoot, "workspace");
    return fs.existsSync(path.join(devPath, WORKSPACE_CONFIG_FILE)) ? devPath : null;
  }
  // Production: Electron sets process.resourcesPath; headless falls back to appRoot
  const resourcesPath = "resourcesPath" in process ? (process.resourcesPath as string) : appRoot;
  const prodPath = path.join(resourcesPath, "workspace-template");
  return fs.existsSync(path.join(prodPath, WORKSPACE_CONFIG_FILE)) ? prodPath : null;
}

/**
 * Initialize a new managed workspace directory.
 *
 * Source options (mutually exclusive, at most one):
 * - `templateDir`: Copy source dirs from a local directory (e.g., the shipped workspace template)
 * - `forkFrom`:   Copy source dirs from another managed workspace by name
 *
 * If none are provided, creates a bare workspace with scaffolding.
 * Fails if the directory already exists on disk.
 */
export function initWorkspace(
  name: string,
  opts?: { templateDir?: string; forkFrom?: string }
): void {
  validateWorkspaceName(name);

  const wsDir = getWorkspaceDir(name);
  const sourceRoot = path.join(wsDir, "source");
  const stateRoot = path.join(wsDir, "state");

  if (fs.existsSync(wsDir)) {
    throw new Error(`Workspace directory already exists: ${wsDir}`);
  }

  // Ensure parent workspaces/ dir exists
  fs.mkdirSync(getWorkspacesDir(), { recursive: true });

  // Resolve template source directory for template/fork
  let templateSrc: string | null = null;

  if (opts?.templateDir) {
    templateSrc = opts.templateDir;
  } else if (opts?.forkFrom) {
    templateSrc = path.join(getWorkspaceDir(opts.forkFrom), "source");
    if (!fs.existsSync(path.join(templateSrc, WORKSPACE_CONFIG_FILE))) {
      throw new Error(`Source workspace "${opts.forkFrom}" does not exist`);
    }
  }

  // If we have a local source dir (template or fork), copy source dirs into source/
  if (templateSrc) {
    fs.mkdirSync(sourceRoot, { recursive: true });
    for (const dir of WORKSPACE_SOURCE_DIRS) {
      const src = path.join(templateSrc, dir);
      if (fs.existsSync(src)) {
        copyDirRecursive(src, path.join(sourceRoot, dir));
      }
    }
  } else {
    // Bare workspace
    fs.mkdirSync(sourceRoot, { recursive: true });
  }

  // Scaffold source directories
  for (const dir of WORKSPACE_SOURCE_DIRS) {
    fs.mkdirSync(path.join(sourceRoot, dir), { recursive: true });
  }

  // Scaffold state directories
  fs.mkdirSync(stateRoot, { recursive: true });
  for (const dir of WORKSPACE_STATE_DIRS) {
    fs.mkdirSync(path.join(stateRoot, dir), { recursive: true });
  }

  // Write natstack.yml for bare workspaces. Template/forked workspaces keep
  // their copied config as-is.
  const configPath = path.join(sourceRoot, WORKSPACE_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    const configContent = `# NatStack Workspace Configuration
initPanels:
  - source: panels/chat
`;
    fs.writeFileSync(configPath, configContent, "utf-8");
  }

  // Initialize git repos for all source subdirectories (panels, packages, etc.)
  // so the build system can extract source and compute effective versions.
  initGitRepos(sourceRoot);

  log.info(`[Workspace] Created managed workspace "${name}" at ${wsDir}`);
}

/** Recursively copy a directory, skipping .git, node_modules, and .cache. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".cache") continue;
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Initialize git repos for all immediate subdirectories within each source dir.
 * Each panel/package/agent/worker/skill/about-page/project becomes its own
 * git repo with an initial commit.
 */
function initGitRepos(wsDir: string): void {
  // Verify git is available before attempting repo initialization
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error("git is required but not found on PATH — cannot initialize workspace");
  }

  for (const sourceDir of WORKSPACE_SOURCE_DIRS) {
    const parentDir = path.join(wsDir, sourceDir);
    if (!fs.existsSync(parentDir)) continue;

    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const repoDir = path.join(parentDir, entry.name);

      // Skip if already a git repo
      if (fs.existsSync(path.join(repoDir, ".git"))) continue;

      // Skip empty directories
      const contents = fs.readdirSync(repoDir);
      if (contents.length === 0) continue;

      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync(
        "git",
        ["-c", "user.email=natstack@local", "-c", "user.name=natstack", "commit", "-m", "Initial workspace"],
        { cwd: repoDir, stdio: "pipe" },
      );
    }
  }
}

export { WORKSPACE_GIT_INIT_PATTERNS, WORKSPACE_SOURCE_DIRS, WORKSPACE_STATE_DIRS };

/**
 * Delete a managed workspace directory.
 */
export function deleteWorkspaceDir(name: string): void {
  const wsDir = getWorkspaceDir(name);
  if (fs.existsSync(wsDir)) {
    fs.rmSync(wsDir, { recursive: true, force: true });
    log.info(`[Workspace] Deleted workspace directory "${name}"`);
  }
}

/**
 * Load and parse natstack.yml from a workspace directory
 */
export function loadWorkspaceConfig(workspacePath: string): WorkspaceConfig {
  const configPath = path.join(workspacePath, WORKSPACE_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(`${WORKSPACE_CONFIG_FILE} not found at ${workspacePath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = YAML.parse(content) as WorkspaceConfig;

  // Workspace id is not read from disk. Managed workspaces derive it from the
  // data-dir folder name; explicit external workspaces derive it from their
  // absolute workspace root path.
  config.id = deriveWorkspaceId(workspacePath);

  return config;
}

function deriveWorkspaceId(workspacePath: string): string {
  const sourceRoot = path.resolve(workspacePath);
  const workspaceRoot = path.basename(sourceRoot) === "source"
    ? path.dirname(sourceRoot)
    : sourceRoot;
  const workspacesDir = path.resolve(getWorkspacesDir());

  if (path.dirname(workspaceRoot) === workspacesDir) {
    return path.basename(workspaceRoot);
  }
  return workspaceRoot;
}

/**
 * Create a fully resolved Workspace object from a managed workspace directory.
 * The wsDir contains source/ (git repos, natstack.yml) and state/ (runtime data).
 */
export function createWorkspace(wsDir: string): Workspace {
  const resolvedDir = path.resolve(wsDir);
  const sourceRoot = path.join(resolvedDir, "source");
  const stateRoot = path.join(resolvedDir, "state");

  const panelsPath = path.join(sourceRoot, "panels");
  const packagesPath = path.join(sourceRoot, "packages");
  const contextsPath = path.join(stateRoot, ".contexts");
  const gitReposPath = sourceRoot;
  const cachePath = path.join(stateRoot, ".cache");
  const agentsPath = path.join(sourceRoot, "agents");
  const projectsPath = path.join(sourceRoot, "projects");

  // Ensure directory structure exists
  fs.mkdirSync(panelsPath, { recursive: true });
  fs.mkdirSync(projectsPath, { recursive: true });
  fs.mkdirSync(contextsPath, { recursive: true });
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  const config = loadWorkspaceConfig(sourceRoot);

  return {
    path: sourceRoot,
    statePath: stateRoot,
    config,
    panelsPath,
    packagesPath,
    contextsPath,
    gitReposPath,
    cachePath,
    agentsPath,
    projectsPath,
  };
}

// =============================================================================
// Workspace Resolution (shared between Electron and headless server)
// =============================================================================

export interface ResolveWorkspaceOpts {
  /** Explicit managed workspace root path */
  wsDir?: string;
  /** Workspace name (resolved via getWorkspaceDir) */
  name?: string;
  /** App root for template resolution (required when init is true) */
  appRoot?: string;
  /** Auto-create from template if workspace doesn't exist */
  init?: boolean;
}

export interface ResolvedWorkspace {
  /** Managed workspace root directory */
  wsDir: string;
  /** Fully resolved workspace object */
  workspace: Workspace;
  /** Workspace name (derived from dir basename if not provided) */
  name: string;
  /** Whether workspace was newly created during this call */
  created: boolean;
}

/**
 * Resolve a workspace by name or path, optionally creating from template.
 *
 * Used by both Electron main and headless server to share workspace
 * initialization logic.
 *
 * Throws if workspace doesn't exist and init is false.
 */
export function resolveOrCreateWorkspace(opts: ResolveWorkspaceOpts): ResolvedWorkspace {
  let wsDir = opts.wsDir;
  let name = opts.name;

  if (!wsDir && name) {
    wsDir = getWorkspaceDir(name);
  }
  if (!wsDir) {
    throw new Error("No workspace specified (provide wsDir or name)");
  }
  if (!name) {
    name = path.basename(wsDir);
  }

  const configPath = path.join(wsDir, "source", WORKSPACE_CONFIG_FILE);
  let created = false;

  if (!fs.existsSync(configPath)) {
    if (!opts.init) {
      throw new Error(`Workspace not found at ${wsDir}`);
    }
    // Clean up partial directory from a previously interrupted create
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
    const templateDir = opts.appRoot ? resolveWorkspaceTemplateDir(opts.appRoot) : null;
    initWorkspace(name, templateDir ? { templateDir } : undefined);
    created = true;
    log.info(`[Workspace] Created "${name}"${templateDir ? " from template" : ""}`);
  }

  const workspace = createWorkspace(wsDir);
  return { wsDir, workspace, name, created };
}

/**
 * Create a new workspace and register it in the central data store.
 * Used for user-initiated workspace creation (UI wizard, CLI).
 * Fails if the workspace already exists in the registry.
 */
export function createAndRegisterWorkspace(
  name: string,
  centralData: CentralDataManager,
  opts?: { templateDir?: string; forkFrom?: string },
): WorkspaceEntry {
  if (centralData.hasWorkspace(name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }
  initWorkspace(name, opts);
  centralData.addWorkspace(name);
  return { name, lastOpened: Date.now() };
}

/**
 * Manages atomic reads/writes of workspace config fields.
 * Updates both the in-memory config and disk (natstack.yml).
 */
export function createWorkspaceConfigManager(configPath: string, config: WorkspaceConfig) {
  return {
    get: () => config,
    set(key: "initPanels", value: unknown): void {
      // Write disk first — if I/O fails, in-memory config stays consistent
      const content = fs.readFileSync(configPath, "utf-8");
      const onDisk = (YAML.parse(content) as Record<string, unknown>) ?? {};
      onDisk[key] = value;
      fs.writeFileSync(configPath, YAML.stringify(onDisk), "utf-8");
      // Only mutate in-memory after successful disk write
      (config as unknown as Record<string, unknown>)[key] = value;
    },
  };
}
