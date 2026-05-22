/**
 * Mobile panel chrome smoke tests.
 *
 * These run the real Electron shell at a phone-sized native window and assert
 * that shell chrome and all shipped panels stay within the viewport.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
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
const SHIPPED_PANELS = [
  "about/about",
  "about/new",
  "about/help",
  "about/keyboard-shortcuts",
  "about/adblock",
  "panels/chat",
  "panels/gad-browser",
  "panels/terminal",
] as const;
const STATEFUL_PANELS = [
  { source: "about/dirty-repo", stateArgs: { repoPath: "panels/chat" } },
  { source: "about/git-init", stateArgs: { repoPath: "panels/chat" } },
] as const;

function writeInitPanelsConfig(
  workspacePath: string,
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }>
): void {
  const lines = ["initPanels:"];
  for (const panel of panels) {
    lines.push(`  - source: ${panel.source}`);
    if (panel.stateArgs) {
      lines.push(`    stateArgs: ${JSON.stringify(panel.stateArgs)}`);
    }
  }
  lines.push("");
  fs.writeFileSync(path.join(workspacePath, "source", "meta", "natstack.yml"), lines.join("\n"));
}

async function launchMobileTestApp(
  panels: Array<{ source: string; stateArgs?: Record<string, unknown> }> = [
    { source: "about/new" },
  ]
): Promise<TestApp> {
  const workspacePath = createManagedTestWorkspace();
  writeInitPanelsConfig(workspacePath, panels);
  const testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 120_000 });
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

async function approveShellPrompts(window: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clicked = await window
      .getByRole("button", { name: /Install and run|Allow|Run once|Allow for session/i })
      .click({ timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) return;
  }
}

test.describe("Mobile Panels", () => {
  test.setTimeout(180_000);

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

  test("terminal mobile drawer and alerts fit the panel viewport", async () => {
    testApp = await launchMobileTestApp([{ source: "panels/terminal" }]);
    await setMobileWindow(testApp.app);
    await ensureShellStackMode(testApp.window);
    const panelId = await ensurePanelSource(testApp.app, "panels/terminal");
    await approveShellPrompts(testApp.window);

    await expect
      .poll(async () => getPanelText(testApp!.app, panelId), {
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      })
      .toContain("Sessions");

    expect(await clickPanelText(testApp.app, panelId, "button", "Sessions")).toBe(true);
    await expect
      .poll(async () => getPanelText(testApp!.app, panelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toContain("No matching sessions");
    await expectPanelFitsMobileViewport(testApp.app, panelId);

    expect(
      await clickPanelSelector(testApp.app, panelId, 'button[aria-label="Hide terminal sidebar"]')
    ).toBe(true);
    await expect
      .poll(async () => getPanelText(testApp!.app, panelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .not.toContain("No matching sessions");

    expect(await clickPanelText(testApp.app, panelId, "button", "Alerts")).toBe(true);
    await expect
      .poll(async () => getPanelText(testApp!.app, panelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toContain("Notifications");
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

  for (const { source, stateArgs } of STATEFUL_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      testApp = await launchMobileTestApp([{ source: "about/new" }]);
      await setMobileWindow(testApp.app);
      await ensureShellStackMode(testApp.window);
      const panelId = await ensurePanelSource(testApp.app, source, { stateArgs });
      await testApp.window.waitForTimeout(500);

      await expectShellFitsMobileViewport(testApp.window);
      await expectPanelFitsMobileViewport(testApp.app, panelId);
    });
  }
});
