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
import { parseWorkspaceConfigContentWithId } from "./configParser.js";
export { resolveDeclaredApps, resolveDeclaredExtensions } from "./configParser.js";

const log = createDevLogger("Workspace");
import type {
  Workspace,
  WorkspaceConfig,
  CentralConfig,
  CentralConfigPaths,
  WorkspaceEntry,
  WorkspaceAppTarget,
} from "./types.js";
import type { CentralDataManager } from "../centralData.js";
import { assertGitAvailable, execGitFileSync } from "../gitRuntime.js";
import { writeProductSeedSourceRecord } from "../productSeedTrust.js";
import { getExistingWorkspaceTemplateDir, getWorkspaceTemplateCandidates } from "../runtimePaths.js";
import {
  WORKSPACE_GIT_INIT_PATTERNS,
  WORKSPACE_SOURCE_DIRS,
  WORKSPACE_STATE_DIRS,
} from "./sourceDirs.js";

const WORKSPACE_CONFIG_FILE = "meta/natstack.yml";
const WORKSPACE_TEMPLATE_SOURCE_FILE = "meta/.natstack-template-source.json";
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

// Central-config dir management lives in `centralAuth.ts` because it is a
// central-data concern, not a workspace concern.
import { ensureCentralConfigDir } from "../centralAuth.js";

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
 * Packaged builds ship workspace-template/ as an Electron resource. Dev uses
 * workspace/ at the app root. The candidate selection is shared with the rest
 * of runtime path resolution so dev and packaged follow the same contract.
 *
 * Returns null if no template directory exists.
 */
export function resolveWorkspaceTemplateDir(appRoot: string): string | null {
  const debug = process.env["NATSTACK_DEBUG_PATHS"] === "1";
  const templateDir = getExistingWorkspaceTemplateDir(appRoot, WORKSPACE_CONFIG_FILE);
  if (debug) {
    console.log(
      `[Workspace] resolveWorkspaceTemplateDir appRoot=${appRoot} candidates=${JSON.stringify(
        getWorkspaceTemplateCandidates(appRoot),
      )} selected=${templateDir ?? "(none)"}`,
    );
  }
  return templateDir;
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
  let templateSourceKind: "template" | "fork" | null = null;

  if (opts?.templateDir) {
    templateSrc = opts.templateDir;
    templateSourceKind = "template";
  } else if (opts?.forkFrom) {
    templateSrc = path.join(getWorkspaceDir(opts.forkFrom), "source");
    templateSourceKind = "fork";
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
    writeCanonicalWorkspaceUnits(sourceRoot);
    const configContent = `# NatStack Workspace Configuration
extensions:
  - source: extensions/react-native
apps:
  - source: apps/shell
    target: electron
  - source: apps/mobile
    target: react-native
initPanels:
  - source: panels/chat
`;
    fs.writeFileSync(configPath, configContent, "utf-8");
  }

  if (templateSrc && templateSourceKind) {
    writeTemplateSourceMarker(sourceRoot, templateSrc, templateSourceKind);
  }

  // Initialize git repos for all source subdirectories (panels, packages, etc.)
  // so the build system can extract source and compute effective versions.
  initGitRepos(sourceRoot);

  log.info(`[Workspace] Created managed workspace "${name}" at ${wsDir}`);
}

function writeCanonicalWorkspaceUnits(sourceRoot: string): void {
  writeSeededExtension(
    path.join(sourceRoot, "extensions", "react-native"),
    {
      name: "@workspace-extensions/react-native",
      displayName: "React Native Build Provider",
      streamingMethods: ["buildArtifact"],
    },
    [
      "import { spawn } from 'node:child_process';",
      "import { randomUUID } from 'node:crypto';",
      "import * as fs from 'node:fs';",
      "import * as os from 'node:os';",
      "import * as path from 'node:path';",
      "import { createRequire } from 'node:module';",
      "import type { BuildProviderInput, BuildProviderOutput } from '@natstack/shared/buildProvider';",
      "",
      "interface ArtifactFile {",
      "  filePath: string;",
      "  tempDir: string;",
      "}",
      "",
      "const require = createRequire(import.meta.url);",
      "",
      "export async function activate() {",
      "  const artifactFiles = new Map<string, ArtifactFile>();",
      "  const tempDirRefs = new Map<string, number>();",
      "  return {",
      "    async build(input: BuildProviderInput): Promise<BuildProviderOutput> {",
      "      if (input.target !== 'react-native') {",
      "        throw new Error(`react-native provider cannot build target: ${input.target}`);",
      "      }",
      "      const appManifest = input.manifest['app'] && typeof input.manifest['app'] === 'object'",
      "        ? input.manifest['app'] as Record<string, unknown>",
      "        : input.manifest;",
      "      const entry = String(appManifest['renderer'] ?? 'index.tsx');",
      "      const entryPath = path.resolve(input.sourcePath, entry);",
      "      const rnHostAbi = typeof appManifest['rnHostAbi'] === 'string'",
      "        ? appManifest['rnHostAbi']",
      "        : null;",
      "      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natstack-rn-provider-'));",
      "      const artifacts: BuildProviderOutput['artifacts'] = [];",
      "      for (const platform of ['android', 'ios'] as const) {",
      "        const bundlePath = path.join(tempDir, `index.${platform}.bundle`);",
      "        const assetsDir = path.join(tempDir, `${platform}-assets`);",
      "        fs.mkdirSync(assetsDir, { recursive: true });",
      "        await runReactNativeBundle(input, platform, entryPath, bundlePath, assetsDir);",
      "        const bundleArtifactId = randomUUID();",
      "        artifactFiles.set(bundleArtifactId, { filePath: bundlePath, tempDir });",
      "        artifacts.push({",
      "          path: `index.${platform}.bundle`,",
      "          role: 'primary',",
      "          contentType: 'application/javascript; charset=utf-8',",
      "          encoding: 'utf8',",
      "          platform,",
      "          stream: { method: 'buildArtifact', args: [bundleArtifactId] },",
      "        });",
      "        for (const assetPath of walkFiles(assetsDir)) {",
      "          const assetArtifactId = randomUUID();",
      "          artifactFiles.set(assetArtifactId, { filePath: assetPath, tempDir });",
      "          artifacts.push({",
      "            path: `assets/${platform}/${path.relative(assetsDir, assetPath).replace(/\\\\/g, '/')}`,",
      "            role: 'asset',",
      "            contentType: contentTypeForPath(assetPath),",
      "            encoding: 'base64',",
      "            platform,",
      "            stream: { method: 'buildArtifact', args: [assetArtifactId] },",
      "          });",
      "        }",
      "      }",
      "      tempDirRefs.set(tempDir, artifacts.length);",
      "      return {",
      "        artifacts,",
      "        metadata: { rnHostAbi },",
      "      };",
      "    },",
      "    buildArtifact(artifactId: string): ReadableStream<Uint8Array> {",
      "      const artifact = artifactFiles.get(artifactId);",
      "      if (!artifact) {",
      "        throw new Error('Unknown React Native build artifact');",
      "      }",
      "      artifactFiles.delete(artifactId);",
      "      const source = fs.createReadStream(artifact.filePath);",
      "      return new ReadableStream<Uint8Array>({",
      "        start(controller) {",
      "          source.on('data', (chunk) => {",
      "            controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));",
      "          });",
      "          source.on('error', (error) => controller.error(error));",
      "          source.on('end', () => {",
      "            controller.close();",
      "            releaseTempDir(artifact.tempDir, tempDirRefs);",
      "          });",
      "        },",
      "        cancel() {",
      "          source.destroy();",
      "          releaseTempDir(artifact.tempDir, tempDirRefs);",
      "        },",
      "      });",
      "    },",
      "  };",
      "}",
      "",
      "async function runReactNativeBundle(input: BuildProviderInput, platform: 'android' | 'ios', entryPath: string, bundlePath: string, assetsDir: string): Promise<void> {",
      "  const repoRoot = resolveRepoRoot(input.workspaceRoot);",
      "  const bundleScript = require.resolve('react-native/scripts/bundle.js', { paths: [repoRoot, process.cwd()] });",
      "  const cliPath = require.resolve('react-native/cli.js', { paths: [repoRoot, process.cwd()] });",
      "  const metroConfig = path.join(repoRoot, 'apps', 'mobile', 'metro.config.js');",
      "  const args = [",
      "    bundleScript,",
      "    '--platform',",
      "    platform,",
      "    '--dev',",
      "    'false',",
      "    '--entry-file',",
      "    entryPath,",
      "    '--bundle-output',",
      "    bundlePath,",
      "    '--assets-dest',",
      "    assetsDir,",
      "    '--config',",
      "    metroConfig,",
      "    '--reset-cache',",
      "    '--config-cmd',",
      "    `${process.execPath} ${cliPath} config`,",
      "  ];",
      "  await run(process.execPath, args, {",
      "    cwd: path.join(repoRoot, 'apps', 'mobile'),",
      "    env: {",
      "      ...process.env,",
      "      NATSTACK_WORKSPACE_APP_ROOT: input.sourcePath,",
      "    },",
      "  });",
      "}",
      "",
      "function run(",
      "  command: string,",
      "  args: string[],",
      "  opts: { cwd: string; env: NodeJS.ProcessEnv },",
      "): Promise<void> {",
      "  return new Promise((resolve, reject) => {",
      "    const child = spawn(command, args, {",
      "      cwd: opts.cwd,",
      "      env: opts.env,",
      "      stdio: ['ignore', 'pipe', 'pipe'],",
      "    });",
      "    let stderr = '';",
      "    child.stderr?.on('data', (chunk) => {",
      "      stderr += chunk.toString();",
      "    });",
      "    child.on('error', reject);",
      "    child.on('exit', (code) => {",
      "      if (code === 0) resolve();",
      "      else reject(new Error(`${command} ${args.join(' ')} failed with code ${code}\\n${stderr.trim()}`));",
      "    });",
      "  });",
      "}",
      "",
      "function resolveRepoRoot(workspaceRoot: string): string {",
      "  for (const start of [process.env['NATSTACK_REPO_ROOT'], process.cwd(), workspaceRoot]) {",
      "    if (!start) continue;",
      "    let current = path.resolve(start);",
      "    while (true) {",
      "      if (fs.existsSync(path.join(current, 'apps', 'mobile', 'metro.config.js')) && fs.existsSync(path.join(current, 'node_modules', 'react-native', 'cli.js'))) {",
      "        return current;",
      "      }",
      "      const parent = path.dirname(current);",
      "      if (parent === current) break;",
      "      current = parent;",
      "    }",
      "  }",
      "  throw new Error('Could not locate NatStack repo root for React Native provider');",
      "}",
      "",
      "function walkFiles(dir: string): string[] {",
      "  if (!fs.existsSync(dir)) return [];",
      "  const out: string[] = [];",
      "  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {",
      "    const full = path.join(dir, entry.name);",
      "    if (entry.isDirectory()) out.push(...walkFiles(full));",
      "    else if (entry.isFile()) out.push(full);",
      "  }",
      "  return out;",
      "}",
      "",
      "function contentTypeForPath(filePath: string): string {",
      "  switch (path.extname(filePath).toLowerCase()) {",
      "    case '.png':",
      "      return 'image/png';",
      "    case '.jpg':",
      "    case '.jpeg':",
      "      return 'image/jpeg';",
      "    case '.webp':",
      "      return 'image/webp';",
      "    case '.gif':",
      "      return 'image/gif';",
      "    case '.json':",
      "      return 'application/json; charset=utf-8';",
      "    default:",
      "      return 'application/octet-stream';",
      "  }",
      "}",
      "",
      "function releaseTempDir(tempDir: string, refs: Map<string, number>): void {",
      "  const remaining = (refs.get(tempDir) ?? 1) - 1;",
      "  if (remaining > 0) {",
      "    refs.set(tempDir, remaining);",
      "    return;",
      "  }",
      "  refs.delete(tempDir);",
      "  fs.rmSync(tempDir, { recursive: true, force: true });",
      "}",
      "",
    ].join("\n"),
  );
  writeSeededApp(
    path.join(sourceRoot, "apps", "shell"),
    {
      name: "@workspace-apps/shell",
      target: "electron",
      renderer: "index.tsx",
      capabilities: [
        "native-menus",
        "notifications",
        "open-external",
        "window-management",
        "panel-hosting",
        "incoming-pair-links",
        "connection-management",
      ],
    },
    [
      "const root = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));",
      "root.id = 'root';",
      "root.textContent = 'NatStack';",
      "",
    ].join("\n"),
  );
  writeSeededApp(
    path.join(sourceRoot, "apps", "mobile"),
    {
      name: "@workspace-apps/mobile",
      target: "react-native",
      renderer: "App.tsx",
      rnComponentName: "NatStack",
      rnHostAbi: "rn-host-1",
      capabilities: ["notifications", "camera", "keychain", "clipboard", "open-external"],
    },
    [
      "import { AppRegistry } from 'react-native';",
      "",
      "function App() {",
      "  return null;",
      "}",
      "",
      "AppRegistry.registerComponent('NatStack', () => App);",
      "",
      "export default App;",
      "",
    ].join("\n"),
  );
}

export function reseedCanonicalShellApp(
  sourceRoot: string,
  opts: { templateDir: string }
): { source: string; commit: string | null } {
  assertGitAvailable();
  const relativeSource = path.join("apps", "shell");
  const templateAppDir = path.join(opts.templateDir, relativeSource);
  if (!fs.existsSync(path.join(templateAppDir, "package.json"))) {
    throw new Error(`Canonical shell app template not found: ${templateAppDir}`);
  }
  const targetAppDir = path.join(sourceRoot, relativeSource);
  fs.mkdirSync(targetAppDir, { recursive: true });
  clearDirExceptGit(targetAppDir);
  copyDirRecursive(templateAppDir, targetAppDir);
  if (!fs.existsSync(path.join(targetAppDir, ".natstack-seed.json"))) {
    writeProductSeedSourceRecord({
      unitDir: targetAppDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: relativeSource,
    });
  }
  ensureUnitGitRepo(targetAppDir, "Reseed canonical shell app");
  return { source: relativeSource.replace(/\\/g, "/"), commit: readGitHead(targetAppDir) };
}

function writeSeededExtension(
  extensionDir: string,
  extension: {
    name: string;
    displayName: string;
    streamingMethods?: string[];
  },
  source: string,
): void {
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, "package.json"),
    `${JSON.stringify({
      name: extension.name,
      version: "0.1.0",
      private: true,
      type: "module",
      natstack: {
        displayName: extension.displayName,
        entry: "index.ts",
        sourcemap: true,
        extension: {
          activationEvents: ["*"],
          dependencyMode: "external",
          ...(extension.streamingMethods ? { streamingMethods: extension.streamingMethods } : {}),
          contributes: { buildTargets: ["react-native"] },
        },
      },
      dependencies: {
        "@natstack/shared": "workspace:*",
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(extensionDir, "index.ts"), source, "utf-8");
  writeProductSeedSourceRecord({
    unitDir: extensionDir,
    unitKind: "extension",
    name: extension.name,
    sourceRepo: seedSourceRepoForUnitDir(extensionDir),
  });
}

function writeSeededApp(
  appDir: string,
  app: {
    name: string;
    target: WorkspaceAppTarget;
    renderer: string;
    capabilities: string[];
    rnComponentName?: string;
    rnHostAbi?: string;
  },
  source: string,
): void {
  fs.mkdirSync(appDir, { recursive: true });
  const appManifest = {
    target: app.target,
    renderer: app.renderer,
    capabilities: app.capabilities,
    ...(app.rnComponentName ? { rnComponentName: app.rnComponentName } : {}),
    ...(app.rnHostAbi ? { rnHostAbi: app.rnHostAbi } : {}),
  };
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    `${JSON.stringify({
      name: app.name,
      version: "0.1.0",
      private: true,
      type: "module",
      natstack: { app: appManifest },
    }, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(appDir, app.renderer), source, "utf-8");
  writeProductSeedSourceRecord({
    unitDir: appDir,
    unitKind: "app",
    name: app.name,
    sourceRepo: seedSourceRepoForUnitDir(appDir),
  });
}

function seedSourceRepoForUnitDir(unitDir: string): string {
  return path.relative(path.resolve(unitDir, "..", ".."), unitDir).replace(/\\/g, "/");
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

function clearDirExceptGit(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function ensureUnitGitRepo(repoDir: string, message: string): void {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    execGitFileSync(["init", "-b", "main"], { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] });
  }
  execGitFileSync(["add", "-A"], { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] });
  try {
    execGitFileSync(
      [
        "-c",
        "user.name=NatStack",
        "-c",
        "user.email=natstack@local",
        "commit",
        "-m",
        message,
      ],
      { cwd: repoDir, stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch {
    // No changes to commit.
  }
}

function writeTemplateSourceMarker(
  sourceRoot: string,
  templateSrc: string,
  kind: "template" | "fork",
): void {
  const markerPath = path.join(sourceRoot, WORKSPACE_TEMPLATE_SOURCE_FILE);
  const marker = {
    kind,
    sourcePath: path.resolve(templateSrc),
    copiedAt: new Date().toISOString(),
    gitHead: readGitHead(templateSrc),
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
}

function readGitHead(cwd: string): string | null {
  try {
    return execGitFileSync(["rev-parse", "--verify", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Initialize git repos for all immediate subdirectories within each source dir.
 * Each panel/package/agent/worker/skill/about-page/project becomes its own
 * git repo with an initial commit.
 */
function initGitRepos(wsDir: string): void {
  assertGitAvailable();

  for (const sourceDir of WORKSPACE_SOURCE_DIRS) {
    const parentDir = path.join(wsDir, sourceDir);
    if (!fs.existsSync(parentDir)) continue;

    for (const repoDir of listWorkspaceUnitDirs(parentDir, sourceDir)) {

      // Skip if already a git repo
      if (fs.existsSync(path.join(repoDir, ".git"))) continue;

      // Skip empty directories
      const contents = fs.readdirSync(repoDir);
      if (contents.length === 0) continue;

      execGitFileSync(["init"], { cwd: repoDir, stdio: "pipe" });
      execGitFileSync(["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execGitFileSync(
        ["-c", "user.email=natstack@local", "-c", "user.name=natstack", "commit", "-m", "Initial workspace"],
        { cwd: repoDir, stdio: "pipe" },
      );
    }
  }
}

function listWorkspaceUnitDirs(parentDir: string, _sourceDir: string): string[] {
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(parentDir, entry.name);
    dirs.push(entryPath);
  }
  return dirs;
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
  return parseWorkspaceConfigContent(content, workspacePath);
}

export function parseWorkspaceConfigContent(content: string, workspacePath: string): WorkspaceConfig {
  // Workspace id is not read from disk. Managed workspaces derive it from the
  // data-dir folder name; explicit external workspaces derive it from their
  // absolute workspace root path.
  return parseWorkspaceConfigContentWithId(content, deriveWorkspaceId(workspacePath));
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
