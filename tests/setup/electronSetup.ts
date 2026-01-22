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

export interface LaunchOptions {
  /** Use an existing workspace path instead of creating a new one */
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

/**
 * Create a minimal test workspace with required config files.
 * Note: On startup with no existing panels, the app shows shell:new (panel launcher).
 */
function createTestWorkspace(basePath?: string): string {
  const workspacePath =
    basePath ?? fs.mkdtempSync(path.join(os.tmpdir(), "natstack-e2e-test-"));

  // Create .natstack directory for config
  const natstackDir = path.join(workspacePath, ".natstack");
  fs.mkdirSync(natstackDir, { recursive: true });

  // Create panels directory
  fs.mkdirSync(path.join(workspacePath, "panels"), { recursive: true });

  // Create minimal natstack.yml config
  const workspaceId = `test-${crypto.randomBytes(8).toString("hex")}`;
  const config = `id: ${workspaceId}
name: E2E Test Workspace
`;
  fs.writeFileSync(path.join(workspacePath, "natstack.yml"), config);

  return workspacePath;
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
  const { workspace, initialPanel, devTools = false, env = {}, launchTimeout = 30000 } = options;

  // Determine the project root and default workspace
  const projectRoot = path.resolve(__dirname, "../..");
  const defaultWorkspace = path.join(projectRoot, "workspace");

  // Use specified workspace, or default to the project's real workspace/ directory
  // This ensures tests use real panels with proper git repos
  const workspacePath = workspace ?? defaultWorkspace;

  // Only cleanup if an explicit custom workspace was provided (not the default)
  const shouldCleanupWorkspace = workspace !== undefined && workspace !== defaultWorkspace;

  // Determine the main entry point
  const mainPath = path.resolve(projectRoot, "dist", "main.cjs");

  if (!fs.existsSync(mainPath)) {
    throw new Error(
      `Main entry point not found at ${mainPath}. Make sure to run 'pnpm build' before running E2E tests.`
    );
  }

  // Get the electron binary path
  const electronPath = require("electron") as string;

  // Build electron args - first arg is the app entry point
  const args = [mainPath, `--workspace=${workspacePath}`];
  if (initialPanel) {
    args.push(`--panel=${initialPanel}`);
  }

  // Launch the app using the electron binary
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NATSTACK_TEST_MODE: "1",
      // Disable GPU acceleration for CI environments
      ELECTRON_DISABLE_GPU: "1",
      ...env,
    },
    timeout: launchTimeout,
  });

  // Get the first window
  const window = await app.firstWindow();

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
      // Force kill the process if graceful close fails
      try {
        const pid = await app.evaluate(() => process.pid);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may already be dead
      }
    }

    if (shouldCleanupWorkspace) {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      } catch (error) {
        console.warn("[TestSetup] Error removing workspace:", error);
      }
    }
  };

  return { app, window, workspacePath, cleanup };
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
    typeof panelIdPattern === "string"
      ? `[data-panel-id="${panelIdPattern}"]`
      : `[data-panel-id]`;

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
): Promise<Array<{ id: string; title: string; children: unknown[] }>> {
  return app.evaluate(() => {
    const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.getPanelTree();
  }) as Promise<Array<{ id: string; title: string; children: unknown[] }>>;
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
  }
): Promise<{ id: string; type: string; title: string }> {
  return app.evaluate(
    async ({ parentId, source, options }) => {
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
  return app.evaluate(async (id) => {
    const testApi = (globalThis as { __testApi?: { closePanel: (id: string) => Promise<void> } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.closePanel(id);
  }, panelId);
}

/**
 * Check if a panel's view is loaded.
 */
export async function isPanelLoaded(app: ElectronApplication, panelId: string): Promise<boolean> {
  return app.evaluate((id) => {
    const testApi = (globalThis as { __testApi?: { isPanelLoaded: (id: string) => boolean } })
      .__testApi;
    if (!testApi) {
      throw new Error("Test API not available. Make sure NATSTACK_TEST_MODE=1 is set.");
    }
    return testApi.isPanelLoaded(id);
  }, panelId);
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
export async function takeScreenshot(
  window: Page,
  name: string
): Promise<Buffer> {
  const projectRoot = path.resolve(__dirname, "../..");
  const screenshotDir = path.join(projectRoot, "test-results", "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });
  return window.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
  });
}
