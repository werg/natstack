/**
 * Mobile panel chrome smoke tests.
 *
 * These run the real Electron shell at a phone-sized native window and assert
 * shell-chrome behavior (titlebar, address bar, panel tree, stack mode) at
 * mobile size. The per-panel viewport-fit matrix lives in @workspace/testkit;
 * panels/chat keeps a targeted entry here because it exercises the agentic
 * panel chrome path in the desktop shell.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  clickPanelSelector,
  clickPanelText,
  createManagedTestWorkspace,
  getPanelLayoutAudit,
  getPanelText,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  isPanelLoaded,
  launchTestApp,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

const MOBILE_BOUNDS = { width: 390, height: 844 };
const SHIPPED_PANELS = ["panels/chat"] as const;

type PendingApproval = {
  approvalId: string;
  kind: string;
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeInitPanelsConfig(
  workspacePath: string,
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }>
): void {
  const configPath = path.join(workspacePath, "source", "meta", "natstack.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<
    string,
    unknown
  >;
  config.initPanels = panels;
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
}

async function launchMobileTestApp(
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }> = [
    { source: "about/new" },
  ]
): Promise<TestApp> {
  const workspacePath = createManagedTestWorkspace();
  writeInitPanelsConfig(workspacePath, panels);
  const testApp = await launchTestApp({
    workspace: workspacePath,
    launchTimeout: 240_000,
    env: { NATSTACK_AUTO_APPROVE: "1" },
  });
  const shellWindow = await waitForShellWindow(testApp.app);
  return {
    ...testApp,
    window: shellWindow,
    cleanup: async () => {
      try {
        await testApp.cleanup();
      } finally {
        removeManagedTestWorkspace(workspacePath);
      }
    },
  };
}

async function clickRecoveryApproval(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const clicked = await contents.executeJavaScript(
          `(() => {
            if (!document.querySelector('[data-bootstrap-launch-gate="true"]')) return false;
            const approveAll = Array.from(document.querySelectorAll("button"))
              .find((button) => (button.textContent ?? "").trim() === "Approve and start");
            if (!approveAll) return false;
            approveAll.click();
            return true;
          })()`,
          true
        );
        if (clicked) return true;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return false;
  });
}

async function waitForShellWindow(app: ElectronApplication): Promise<Page> {
  let shellWindow: Page | null = null;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const hasShellChrome = await page
            .getByLabel(/Open panel tree|Close panel tree|Show address bar|Hide address bar/)
            .count()
            .then((count) => count > 0)
            .catch(() => false);
          if (hasShellChrome) {
            shellWindow = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return shellWindow!;
}

async function setMobileWindow(app: ElectronApplication): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const hasWindow = await app.evaluate(
      ({ BaseWindow, BrowserWindow }) =>
        BaseWindow.getAllWindows().length + BrowserWindow.getAllWindows().length > 0
    );
    if (hasWindow) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await app.evaluate(({ BaseWindow, BrowserWindow }, bounds) => {
    const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No Electron window available");
    const current = win.getBounds();
    win.setBounds({ ...current, ...bounds });
  }, MOBILE_BOUNDS);
}

async function waitForSourcePanel(app: ElectronApplication, source: string): Promise<string> {
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app
          .evaluate((_electron, panelSource) => {
            const testApi = (
              globalThis as {
                __testApi?: {
                  getPanelTree: () => Array<{ id: string; snapshot?: { source?: string } }>;
                };
              }
            ).__testApi;
            if (!testApi) throw new Error("Test API not available");
            return (
              testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)?.id ??
              null
            );
          }, source)
          .catch(() => null);
        return panelId;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();

  await expect
    .poll(async () => (panelId ? isPanelLoaded(app, panelId).catch(() => false) : false), {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);

  return panelId!;
}

async function ensurePanelSource(
  app: ElectronApplication,
  source: string,
  options?: { stateArgs?: Record<string, unknown> }
): Promise<string> {
  const existingPanelId = await app
    .evaluate((_electron, panelSource) => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getPanelTree: () => Array<{ id: string; snapshot?: { source?: string } }>;
          };
        }
      ).__testApi;
      if (!testApi) throw new Error("Test API not available");
      return testApi.getPanelTree().find((panel) => panel.snapshot?.source === panelSource)?.id;
    }, source)
    .catch(() => null);

  if (existingPanelId) {
    await app.evaluate((_electron, panelId) => {
      const testApi = (globalThis as { __testApi?: { focusPanel: (id: string) => void } })
        .__testApi;
      if (!testApi) throw new Error("Test API not available");
      testApi.focusPanel(panelId);
    }, existingPanelId);
    await expect
      .poll(() => isPanelLoaded(app, existingPanelId).catch(() => false), {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    return existingPanelId;
  }

  const parentId = await waitForAnyPanel(app);
  const created = await createPanel(app, parentId, source, {
    focus: true,
    stateArgs: options?.stateArgs,
  });
  await expect
    .poll(() => isPanelLoaded(app, created.id).catch(() => false), {
      timeout: 60_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);
  return created.id;
}

async function waitForAnyPanel(app: ElectronApplication): Promise<string> {
  let panelId: string | null = null;
  await expect
    .poll(
      async () => {
        panelId = await app.evaluate(() => {
          const testApi = (
            globalThis as {
              __testApi?: {
                getPanelTree: () => Array<{ id: string }>;
              };
            }
          ).__testApi;
          if (!testApi) throw new Error("Test API not available");
          return testApi.getPanelTree()[0]?.id ?? null;
        });
        return panelId;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .not.toBeNull();
  return panelId!;
}

async function expectShellFitsMobileViewport(window: Page): Promise<void> {
  const audit = await window.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    titleBarText: document.body.innerText,
  }));
  expect(audit.viewportWidth).toBeLessThanOrEqual(MOBILE_BOUNDS.width + 4);
  expect(audit.scrollWidth).toBeLessThanOrEqual(audit.viewportWidth + 2);
  expect(audit.titleBarText).toContain("URL");
}

async function ensureShellStackMode(window: Page): Promise<void> {
  await window
    .getByRole("button", { name: "Close panel tree" })
    .first()
    .click({ timeout: 1_000 })
    .catch(() => {});
  await expect(window.getByRole("button", { name: "Open panel tree" })).toBeVisible();
}

async function expectPanelFitsMobileViewport(
  app: ElectronApplication,
  panelId: string
): Promise<void> {
  const audit = await getPanelLayoutAudit(app, panelId);
  expect(audit.viewport.width).toBeGreaterThan(0);
  expect(audit.viewport.width).toBeLessThanOrEqual(MOBILE_BOUNDS.width);
  expect(audit.document.scrollWidth).toBeLessThanOrEqual(audit.viewport.width + 2);
  expect(audit.horizontalOverflow).toEqual([]);
  expect(audit.verticalOverflow).toEqual([]);
}

async function listPendingApprovals(app: ElectronApplication): Promise<PendingApproval[]> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const pending = await testApi.rpcCall("shellApproval", "listPending", []) as Array<{
      approvalId: string;
      kind: string;
      options?: Array<{
        value: unknown;
        tone?: unknown;
        label?: unknown;
      }>;
    }>;
    return pending.map((approval) => ({
      approvalId: approval.approvalId,
      kind: approval.kind,
      options: Array.isArray(approval.options)
        ? approval.options.map((option) => ({
            value: String(option.value),
            tone: typeof option.tone === "string" ? option.tone : undefined,
            label: typeof option.label === "string" ? option.label : undefined,
          }))
        : undefined,
    }));
  });
}

async function resolveApproval(app: ElectronApplication, approval: PendingApproval): Promise<void> {
  await app.evaluate(async (_electron, pending) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    if (pending.kind === "userland") {
      const choice =
        pending.options?.find((option) => option.tone === "primary")?.value ??
        pending.options?.find((option) => option.tone !== "danger")?.value ??
        pending.options?.[0]?.value;
      if (!choice) {
        throw new Error(`Userland approval ${pending.approvalId} did not include any options`);
      }
      await testApi.rpcCall("shellApproval", "resolveUserland", [pending.approvalId, choice]);
      return;
    }
    await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, "session"]);
  }, approval);
}

async function approveShellPrompts(app: ElectronApplication, window: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clickedRecovery = await clickRecoveryApproval(app);
    const pending = await listPendingApprovals(app);
    for (const approval of pending) {
      await resolveApproval(app, approval);
    }
    const clicked = await window
      .getByRole("button", {
        name: /Approve and start|Approve all|Approve push|Approve|Dev session|Install and run|Allow|Run once|Allow for session|Use this session/i,
      })
      .click({ timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (!clickedRecovery && pending.length === 0 && !clicked) return;
    await delay(500);
  }
}

test.describe("Mobile Panels", () => {
  test.setTimeout(300_000);

  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    if (testApp) await testApp.cleanup();
    testApp = undefined;
  });

  test("shell chrome exposes mobile panel tree without horizontal overflow", async () => {
    testApp = await launchMobileTestApp([{ source: "about/new" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    await testApp.window.waitForTimeout(500);

    await expectShellFitsMobileViewport(testApp.window);

    await testApp.window.getByLabel("Open panel tree").click();
    await expect(testApp.window.getByRole("heading", { name: "Panels" })).toBeVisible();
    await expectShellFitsMobileViewport(testApp.window);

    await testApp.window.getByRole("button", { name: "Close panel tree" }).first().click();
    await expect(testApp.window.getByLabel("Open panel tree")).toBeVisible();
  });

  test("mobile titlebar toggles the address bar without overflow", async () => {
    testApp = await launchMobileTestApp([{ source: "about/help" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    await ensurePanelSource(testApp.app, "about/help");

    await testApp.window.getByLabel("Show address bar").click();
    await expect(testApp.window.getByLabel("Panel path")).toBeVisible();
    await expectShellFitsMobileViewport(testApp.window);

    await testApp.window.getByLabel("Hide address bar").click();
    await expect(testApp.window.getByLabel("Panel path")).toBeHidden();
    await expectShellFitsMobileViewport(testApp.window);
  });

  test("mobile titlebar creates a new panel", async () => {
    testApp = await launchMobileTestApp([{ source: "about/help" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    await waitForAnyPanel(testApp.app);
    const initialCount = (await getPanelTree(testApp.app)).length;

    await testApp.window.getByRole("button", { name: "New panel" }).first().click();

    await expect
      .poll(
        async () => {
          const panels = await getPanelTree(testApp!.app);
          return {
            count: panels.length,
            hasNewPanel: panels.some((panel) => panel.snapshot?.source === "about/new"),
          };
        },
        { timeout: 30_000, intervals: [250, 500, 1000] }
      )
      .toEqual({ count: initialCount + 1, hasNewPanel: true });
    await expectShellFitsMobileViewport(testApp.window);
  });

  test("mobile panel tree selection returns to stack mode", async () => {
    testApp = await launchMobileTestApp([{ source: "about/new" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    const parentId = await ensurePanelSource(testApp.app, "about/new");
    await createPanel(testApp.app, parentId, "about/help", { focus: false });
    await waitForSourcePanel(testApp.app, "about/help");

    await testApp.window.getByLabel("Open panel tree").click();
    await expect(testApp.window.getByRole("heading", { name: "Panels" })).toBeVisible();
    await testApp.window.getByText("Help", { exact: true }).click();

    await expect(testApp.window.getByLabel("Open panel tree")).toBeVisible();
    await expect(testApp.window.getByRole("heading", { name: "Panels" })).toBeHidden();
    await expectShellFitsMobileViewport(testApp.window);
  });

  test("terminal session fits the mobile panel viewport", async () => {
    testApp = await launchMobileTestApp([{ source: "panels/terminal" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    const panelId = await ensurePanelSource(testApp.app, "panels/terminal");
    await approveShellPrompts(testApp.app, testApp.window);

    await expect
      .poll(async () => getPanelText(testApp!.app, panelId), {
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      })
      .toMatch(/(?:\$|#|>\s*)|(?:\d+x\d+)/);
    await expectPanelFitsMobileViewport(testApp.app, panelId);
  });

  for (const source of SHIPPED_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      testApp = await launchMobileTestApp([{ source }]);
      await setMobileWindow(testApp.app);
      await ensureShellStackMode(testApp.window);
      const panelId = await ensurePanelSource(testApp.app, source);
      await testApp.window.waitForTimeout(500);

      await expectShellFitsMobileViewport(testApp.window);
      await expectPanelFitsMobileViewport(testApp.app, panelId);
    });
  }

});
