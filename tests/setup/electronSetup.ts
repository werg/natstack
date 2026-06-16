/**
 * Electron E2E test setup utilities.
 *
 * Provides helpers for launching the app with isolated test workspaces,
 * waiting for panels, and cleaning up after tests.
 */

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFileSync } from "child_process";
import { WORKSPACE_SOURCE_DIRS, WORKSPACE_STATE_DIRS } from "@natstack/shared/workspace/sourceDirs";
import type { PanelLifecycleResult } from "@natstack/shared/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

export interface TestApp {
  /** The Playwright Electron application handle */
  app: ElectronApplication;
  /** The main window's Page object */
  window: Page;
  /** Path to the isolated test workspace */
  workspacePath: string;
  /** Clean up the app and test workspace */
  cleanup: () => Promise<void>;
}

export const ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE =
  "Electron E2E tests require an X11 or Wayland display. Run them from a desktop session or under xvfb-run.";

export function hasElectronDisplay(): boolean {
  if (process.platform !== "linux") {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export interface LaunchOptions {
  /** Use an existing managed workspace directory instead of creating a new one */
  workspace?: string;
  /** Initial panel source to load (defaults to shell:new launcher if no panels exist) */
  initialPanel?: string;
  /** Open DevTools on launch (dev mode only) */
  devTools?: boolean;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout for app launch in milliseconds (default: 30000) */
  launchTimeout?: number;
}

interface ManagedWorkspaceInfo {
  workspaceName: string;
  testRoot: string;
  env: Record<string, string>;
}

function getTestEnv(testRoot: string): Record<string, string> {
  switch (process.platform) {
    case "win32":
      return { APPDATA: path.join(testRoot, "appdata") };
    case "darwin":
      return { HOME: path.join(testRoot, "home") };
    default:
      return {
        HOME: path.join(testRoot, "home"),
        XDG_CONFIG_HOME: path.join(testRoot, "xdg"),
      };
  }
}

function getCentralDataDirFromEnv(env: Record<string, string>): string {
  switch (process.platform) {
    case "win32":
      return path.join(env.APPDATA!, "natstack");
    case "darwin":
      return path.join(env.HOME!, "Library", "Application Support", "natstack");
    default:
      return path.join(env.XDG_CONFIG_HOME!, "natstack");
  }
}

function getWorkspaceInfo(workspaceDir: string): ManagedWorkspaceInfo {
  const workspaceName = path.basename(workspaceDir);
  let testRoot: string;

  switch (process.platform) {
    case "win32":
      testRoot = path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir))));
      break;
    case "darwin":
      testRoot = path.dirname(
        path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir)))))
      );
      break;
    default:
      testRoot = path.dirname(path.dirname(path.dirname(path.dirname(workspaceDir))));
      break;
  }

  return {
    workspaceName,
    testRoot,
    env: getTestEnv(testRoot),
  };
}

function getWorkspaceTemplateDir(projectRoot: string): string {
  const templateDir = path.join(projectRoot, "workspace");
  if (!fs.existsSync(path.join(templateDir, "meta/natstack.yml"))) {
    throw new Error(`Workspace template not found at ${templateDir}`);
  }
  return templateDir;
}

function collectUnitDirs(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      const child = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(child, "package.json"))) {
        result.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return result;
}

function initializeUnitGitRepos(sourceRoot: string): void {
  for (const unitDir of collectUnitDirs(sourceRoot)) {
    execFileSync("git", ["init", "-b", "main"], { cwd: unitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@example.invalid"], {
      cwd: unitDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "NatStack E2E"], { cwd: unitDir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: unitDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial e2e workspace snapshot"], {
      cwd: unitDir,
      stdio: "ignore",
    });
  }
}

export function createManagedTestWorkspace(projectRoot?: string): string {
  const resolvedProjectRoot = projectRoot ?? path.resolve(__dirname, "../..");
  const templateDir = getWorkspaceTemplateDir(resolvedProjectRoot);
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-e2e-"));
  const env = getTestEnv(testRoot);
  const workspaceName = `e2e_${crypto.randomBytes(6).toString("hex")}`;
  const workspaceDir = path.join(getCentralDataDirFromEnv(env), "workspaces", workspaceName);
  const sourceRoot = path.join(workspaceDir, "source");
  const stateRoot = path.join(workspaceDir, "state");

  for (const dir of Object.values(env)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  for (const dir of WORKSPACE_SOURCE_DIRS) {
    const src = path.join(templateDir, dir);
    const dest = path.join(sourceRoot, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.mkdirSync(dest, { recursive: true });
    }
  }

  initializeUnitGitRepos(sourceRoot);

  for (const dir of WORKSPACE_STATE_DIRS) {
    fs.mkdirSync(path.join(stateRoot, dir), { recursive: true });
  }

  return workspaceDir;
}

export function removeManagedTestWorkspace(workspaceDir: string): void {
  const { testRoot } = getWorkspaceInfo(workspaceDir);
  fs.rmSync(testRoot, { recursive: true, force: true });
}

/**
 * Launch the Natstack Electron app with an isolated test workspace.
 *
 * @example
 * ```typescript
 * const { app, window, cleanup } = await launchTestApp();
 * try {
 *   // Run tests
 *   await window.click('[data-testid="some-button"]');
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export async function launchTestApp(options: LaunchOptions = {}): Promise<TestApp> {
  const { workspace, initialPanel, devTools = false, env = {}, launchTimeout = 120000 } = options;

  const projectRoot = path.resolve(__dirname, "../..");
  const workspacePath = workspace ?? createManagedTestWorkspace(projectRoot);
  const workspaceInfo = getWorkspaceInfo(workspacePath);
  const ownsWorkspace = workspace === undefined;

  // Determine the main entry point
  const mainPath = path.resolve(projectRoot, "dist", "main.cjs");

  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Main entry point not found at ${mainPath}. Make sure to run 'pnpm build' before running E2E tests.`
    );
  }

  // Get the electron binary path
  const electronPath = require("electron") as string;

  if (!hasElectronDisplay()) {
    throw new Error(ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);
  }

  // Build electron args - first arg is the app entry point
  const electronUserDataDir = path.join(workspaceInfo.testRoot, "electron-user-data");
  const args = [
    "--no-sandbox",
    `--user-data-dir=${electronUserDataDir}`,
    mainPath,
    `--workspace=${workspaceInfo.workspaceName}`,
  ];
  if (initialPanel) {
    args.push(`--panel=${initialPanel}`);
  }

  // Launch the app using the electron binary
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    env: {
      ...process.env,
      NODE_ENV: "development",
      NATSTACK_TEST_MODE: "1",
      // Disable GPU acceleration for CI environments
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      ...workspaceInfo.env,
      ...env,
    },
    timeout: launchTimeout,
  });
  const output: string[] = [];
  const child = app.process();
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));

  // Get the first window
  let window: Page;
  try {
    window = await app.firstWindow({ timeout: launchTimeout });
  } catch (error) {
    const details = output.join("").trim();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        details ? `\n\nElectron output before first window:\n${details}` : ""
      }`
    );
  }

  // Wait for the app to initialize
  await window.waitForLoadState("domcontentloaded");

  // Optionally open DevTools
  if (devTools) {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.openDevTools();
    });
  }

  // Cleanup function with timeout to prevent hanging
  const cleanup = async () => {
    const appProcess = child;
    const mainPid = appProcess.pid;
    // Use a timeout to prevent hanging on app.close()
    const closeWithTimeout = async (timeoutMs: number): Promise<void> => {
      return Promise.race([
        app.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("App close timed out")), timeoutMs)
        ),
      ]);
    };

    try {
      // Try graceful close first with 5 second timeout
      await closeWithTimeout(5000);
    } catch (error) {
      console.warn("[TestSetup] Graceful close failed, force killing:", error);
      // Force kill the whole process tree if graceful close fails. Killing only the Electron
      // parent can orphan workerd/extension children under the user session.
      try {
        killProcessTree(mainPid, "SIGKILL");
      } catch {
        // Process may already be dead
      }
    }

    cleanupKnownChildProcesses(mainPid);

    if (ownsWorkspace) {
      try {
        removeManagedTestWorkspace(workspacePath);
      } catch (error) {
        console.warn("[TestSetup] Error removing workspace:", error);
      }
    }
  };

  return { app, window, workspacePath, cleanup };
}

function cleanupKnownChildProcesses(mainPid: number | undefined): void {
  if (!mainPid) return;
  if (process.platform === "win32") return;
  const workerdConfigDir = `/tmp/natstack-workerd-${mainPid}/config.capnp`;
  for (const pid of findPidsByCommand(workerdConfigDir)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  for (const childPid of collectChildPids(pid)) {
    try {
      process.kill(childPid, signal);
    } catch {
      // already gone
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function collectChildPids(rootPid: number): number[] {
  const result: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stdout = "";
    try {
      stdout = execFileSync("ps", ["-o", "pid=", "--ppid", String(current)], {
        encoding: "utf8",
      });
    } catch {
      continue;
    }
    for (const token of stdout.trim().split(/\s+/)) {
      if (!token) continue;
      const childPid = Number(token);
      if (!Number.isInteger(childPid) || childPid <= 0) continue;
      result.unshift(childPid);
      stack.push(childPid);
    }
  }
  return result;
}

function findPidsByCommand(needle: string): number[] {
  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes(needle)) continue;
    const match = line.match(/^\s*(\d+)\s+/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Wait for a panel to appear in the UI.
 *
 * @param window - The Playwright Page object
 * @param panelIdPattern - A string or regex to match the panel ID
 * @param timeout - Maximum time to wait in milliseconds (default: 10000)
 */
export async function waitForPanel(
  window: Page,
  panelIdPattern: string | RegExp,
  timeout = 10000
): Promise<void> {
  const selector =
    typeof panelIdPattern === "string" ? `[data-panel-id="${panelIdPattern}"]` : `[data-panel-id]`;

  await window.waitForSelector(selector, { timeout });

  if (panelIdPattern instanceof RegExp) {
    // Verify the pattern matches
    const panelId = await window.getAttribute(selector, "data-panel-id");
    if (!panelId || !panelIdPattern.test(panelId)) {
      throw new Error(`No panel matching pattern ${panelIdPattern} found`);
    }
  }
}

/**
 * Get the panel tree from the main process via TestApi.
 */
export async function getPanelTree(
  app: ElectronApplication
): Promise<
  Array<{ id: string; title: string; children: unknown[]; snapshot?: { source?: string } }>
> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelTree();
  }) as Promise<
    Array<{ id: string; title: string; children: unknown[]; snapshot?: { source?: string } }>
  >;
}

/**
 * Get the focused panel ID from the main process.
 */
export async function getFocusedPanelId(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getFocusedPanelId: () => string | null } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getFocusedPanelId();
  });
}

/**
 * Get the panel whose WebContents currently has Electron focus.
 */
export async function getFocusedPanelWebContentsId(
  app: ElectronApplication
): Promise<string | null> {
  return app.evaluate(() => {
    const testApi = (
      globalThis as { __testApi?: { getFocusedPanelWebContentsId: () => string | null } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getFocusedPanelWebContentsId();
  });
}

/**
 * Create a panel via the TestApi.
 */
export async function createPanel(
  app: ElectronApplication,
  parentId: string,
  source: string,
  options?: {
    name?: string;
    env?: Record<string, string>;
    focus?: boolean;
    stateArgs?: Record<string, unknown>;
  }
): Promise<{ id: string; type: string; title: string }> {
  return app.evaluate(
    async (_electron, { parentId, source, options }) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            createPanel: (
              p: string,
              s: string,
              o?: unknown
            ) => Promise<{ id: string; type: string; title: string }>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.createPanel(parentId, source, options);
    },
    { parentId, source, options }
  );
}

/**
 * Close a panel via the TestApi.
 */
export async function closePanel(app: ElectronApplication, panelId: string): Promise<void> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (globalThis as { __testApi?: { closePanel: (id: string) => Promise<void> } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.closePanel(id);
  }, panelId);
}

/**
 * Reload a panel via the TestApi.
 */
export async function reloadPanel(
  app: ElectronApplication,
  panelId: string
): Promise<PanelLifecycleResult> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: { reloadPanel: (id: string) => Promise<PanelLifecycleResult> };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.reloadPanel(id);
  }, panelId);
}

/**
 * Check if a panel's view is loaded.
 */
export async function isPanelLoaded(app: ElectronApplication, panelId: string): Promise<boolean> {
  return app.evaluate((_electron, id) => {
    const testApi = (globalThis as { __testApi?: { isPanelLoaded: (id: string) => boolean } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.isPanelLoaded(id);
  }, panelId);
}

export async function getPanelText(app: ElectronApplication, panelId: string): Promise<string> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelText: (id: string) => Promise<string> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelText(id);
  }, panelId);
}

export async function getPanelHtml(app: ElectronApplication, panelId: string): Promise<string> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelHtml: (id: string) => Promise<string> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelHtml(id);
  }, panelId);
}

export type PanelDiagnostic = {
  type: "console" | "did-fail-load" | "render-process-gone" | "unresponsive";
  level?: string;
  message: string;
  timestamp: number;
};

export interface PanelLayoutAudit {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  horizontalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    left: number;
    right: number;
    width: number;
  }>;
  verticalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    top: number;
    bottom: number;
    height: number;
  }>;
}

export async function startPanelDiagnostics(
  app: ElectronApplication,
  panelId: string
): Promise<void> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { startPanelDiagnostics: (id: string) => Promise<void> } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.startPanelDiagnostics(id);
  }, panelId);
}

export async function getPanelDiagnostics(
  app: ElectronApplication,
  panelId: string
): Promise<PanelDiagnostic[]> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as { __testApi?: { getPanelDiagnostics: (id: string) => PanelDiagnostic[] } }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelDiagnostics(id);
  }, panelId);
}

export async function getPanelLayoutAudit(
  app: ElectronApplication,
  panelId: string
): Promise<PanelLayoutAudit> {
  return app.evaluate(async (_electron, id) => {
    const testApi = (
      globalThis as {
        __testApi?: { getPanelLayoutAudit: (id: string) => Promise<PanelLayoutAudit> };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelLayoutAudit(id);
  }, panelId);
}

export async function getNativePanelSlotDebugInfo(app: ElectronApplication): Promise<
  Array<{
    nativeSlotId: string;
    panelId: string;
    bounds: { x: number; y: number; width: number; height: number };
    focused: boolean;
    ownerViewId: string;
    ownerGeneration: number;
  }>
> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          getNativePanelSlotDebugInfo: () => Array<{
            nativeSlotId: string;
            panelId: string;
            bounds: { x: number; y: number; width: number; height: number };
            focused: boolean;
            ownerViewId: string;
            ownerGeneration: number;
          }>;
        };
      }
    ).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getNativePanelSlotDebugInfo();
  });
}

export async function clickPanelSelector(
  app: ElectronApplication,
  panelId: string,
  selector: string
): Promise<boolean> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: { clickPanelSelector: (id: string, selector: string) => Promise<boolean> };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.clickPanelSelector(args.panelId, args.selector);
    },
    { panelId, selector }
  );
}

export async function clickPanelText(
  app: ElectronApplication,
  panelId: string,
  selector: string,
  text: string
): Promise<boolean> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            clickPanelText: (id: string, selector: string, text: string) => Promise<boolean>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.clickPanelText(args.panelId, args.selector, args.text);
    },
    { panelId, selector, text }
  );
}

export async function executePanelScript<T = unknown>(
  app: ElectronApplication,
  panelId: string,
  script: string
): Promise<T> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            executePanelScript: <T = unknown>(id: string, script: string) => Promise<T>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.executePanelScript<T>(args.panelId, args.script);
    },
    { panelId, script }
  );
}

export async function getPanelSelectorWindowPoint(
  app: ElectronApplication,
  panelId: string,
  selector: string
): Promise<{ x: number; y: number } | null> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getPanelSelectorWindowPoint: (
              id: string,
              selector: string
            ) => Promise<{ x: number; y: number } | null>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.getPanelSelectorWindowPoint(args.panelId, args.selector);
    },
    { panelId, selector }
  );
}

export async function typePanelText(
  app: ElectronApplication,
  panelId: string,
  text: string
): Promise<void> {
  return app.evaluate(
    async (_electron, args) => {
      const testApi = (
        globalThis as {
          __testApi?: { typePanelText: (id: string, text: string) => Promise<void> };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.typePanelText(args.panelId, args.text);
    },
    { panelId, text }
  );
}

export async function setElectronClipboardText(
  app: ElectronApplication,
  text: string
): Promise<void> {
  return app.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, text);
}

export async function getElectronClipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

export async function callTerminalPanel<T = unknown>(
  app: ElectronApplication,
  panelId: string,
  method: string,
  args?: unknown
): Promise<T> {
  return app.evaluate(
    async (_electron, request) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            callTerminalPanel: (id: string, method: string, args?: unknown) => Promise<unknown>;
          };
        }
      ).__testApi;
      if (!testApi) {
        throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
      }
      return testApi.callTerminalPanel(request.panelId, request.method, request.args) as Promise<T>;
    },
    { panelId, method, args }
  );
}

/**
 * Wait for the app to be ready (shell loaded and initial panels rendered).
 */
export async function waitForAppReady(window: Page, timeout = 15000): Promise<void> {
  // Wait for the shell to load
  await window.waitForSelector('[data-testid="panel-tree"]', { timeout });
}

/**
 * Take a screenshot of the current window for debugging.
 */
export async function takeScreenshot(window: Page, name: string): Promise<Buffer> {
  const projectRoot = path.resolve(__dirname, "../..");
  const screenshotDir = path.join(projectRoot, "test-results", "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });
  return window.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
  });
}
