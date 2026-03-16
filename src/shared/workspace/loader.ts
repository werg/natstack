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
import type { Workspace, WorkspaceConfig, CentralConfig, CentralConfigPaths } from "./types.js";

const WORKSPACE_CONFIG_FILE = "natstack.yml";
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

/** Source directories (live under source/) — copied when forking or creating from template. */
const SOURCE_DIRS = ["panels", "packages", "agents", "workers", "skills", "about"];

/** State directories (live under state/) — never copied, always scaffolded fresh. */
const STATE_DIRS = [".cache", ".databases", ".contexts"];

/**
 * Initialize a new managed workspace directory.
 *
 * Source options (mutually exclusive, at most one):
 * - `gitUrl`:     Clone from a remote git template
 * - `templateDir`: Copy source dirs from a local directory (e.g., the shipped workspace template)
 * - `forkFrom`:   Copy source dirs from another managed workspace by name
 *
 * If none are provided, creates a bare workspace with scaffolding.
 * Fails if the directory already exists on disk.
 */
export function initWorkspace(
  name: string,
  opts?: { gitUrl?: string; templateDir?: string; forkFrom?: string }
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

  if (opts?.gitUrl) {
    // Clone from remote into source/ — use execFileSync with argv to prevent shell injection
    try {
      execFileSync("git", ["clone", opts.gitUrl, sourceRoot], {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch (error) {
      fs.rmSync(wsDir, { recursive: true, force: true });
      throw new Error(`Failed to clone template: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (opts?.templateDir) {
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
    for (const dir of SOURCE_DIRS) {
      const src = path.join(templateSrc, dir);
      if (fs.existsSync(src)) {
        copyDirRecursive(src, path.join(sourceRoot, dir));
      }
    }
    // Copy natstack.yml if present (will be rewritten below)
    const srcConfig = path.join(templateSrc, WORKSPACE_CONFIG_FILE);
    if (fs.existsSync(srcConfig)) {
      fs.copyFileSync(srcConfig, path.join(sourceRoot, WORKSPACE_CONFIG_FILE));
    }
  } else if (!opts?.gitUrl) {
    // Bare workspace
    fs.mkdirSync(sourceRoot, { recursive: true });
  }

  // Scaffold source directories
  for (const dir of SOURCE_DIRS) {
    fs.mkdirSync(path.join(sourceRoot, dir), { recursive: true });
  }

  // Scaffold state directories
  fs.mkdirSync(stateRoot, { recursive: true });
  for (const dir of STATE_DIRS) {
    fs.mkdirSync(path.join(stateRoot, dir), { recursive: true });
  }

  // Write/rewrite natstack.yml — always regenerate instance-specific fields
  const configPath = path.join(sourceRoot, WORKSPACE_CONFIG_FILE);
  const randomPort = 49152 + Math.floor(Math.random() * 16383);

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    const config = YAML.parse(content) as WorkspaceConfig;
    config.id = name;
    if (!config.git) config.git = {};
    config.git.port = randomPort;
    fs.writeFileSync(configPath, YAML.stringify(config), "utf-8");
  } else {
    const configContent = `# NatStack Workspace Configuration
id: ${name}

rootPanel: panels/chat

git:
  port: ${randomPort}
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
 * Mirrors the commit-workspace.sh pattern: each panel/package/agent/worker/skill/about-page
 * becomes its own git repo with an initial commit.
 */
function initGitRepos(wsDir: string): void {
  // Verify git is available before attempting repo initialization
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error("git is required but not found on PATH — cannot initialize workspace");
  }

  for (const sourceDir of SOURCE_DIRS) {
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

  // Ensure required fields
  if (!config.id) {
    config.id = `workspace-${Date.now().toString(36)}`;
  }

  return config;
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

  // Ensure directory structure exists
  fs.mkdirSync(panelsPath, { recursive: true });
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
  };
}
