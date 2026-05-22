/**
 * Mobile panel chrome smoke tests.
 *
 * These run the real Electron shell at a phone-sized native window and assert
 * that shell chrome and all shipped panels stay within the viewport.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getPanelLayoutAudit,
  createPanel,
  hasElectronDisplay,
  isPanelLoaded,
  launchTestApp,
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
        panelId = await app.evaluate((_electron, panelSource) => {
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
        }, source);
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
  expect(audit.titleBarText).toContain("NatStack");
}

async function expectPanelFitsMobileViewport(
  app: ElectronApplication,
  panelId: string
): Promise<void> {
  const audit = await getPanelLayoutAudit(app, panelId);
  expect(audit.viewport.width).toBeGreaterThan(0);
  expect(audit.viewport.width).toBeLessThanOrEqual(MOBILE_BOUNDS.width);
  expect(audit.document.scrollWidth).toBeLessThanOrEqual(audit.viewport.width + 2);
  expect(audit.verticalOverflow).toEqual([]);
}

test.describe("Mobile Panels", () => {
  let testApp: TestApp | undefined;

  test.afterEach(async () => {
    if (testApp) await testApp.cleanup();
    testApp = undefined;
  });

  test("shell chrome exposes mobile panel tree without horizontal overflow", async () => {
    testApp = await launchTestApp({ initialPanel: "about/new", launchTimeout: 120_000 });
    await setMobileWindow(testApp.app);
    await testApp.window.waitForTimeout(500);

    await expectShellFitsMobileViewport(testApp.window);

    await testApp.window.getByLabel("Open panel tree").click();
    await expect(testApp.window.getByRole("heading", { name: "Panels" })).toBeVisible();
    await expectShellFitsMobileViewport(testApp.window);

    await testApp.window.getByLabel("Close panel tree").click();
    await expect(testApp.window.getByLabel("Open panel tree")).toBeVisible();
  });

  for (const source of SHIPPED_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      testApp = await launchTestApp({ initialPanel: source, launchTimeout: 120_000 });
      await setMobileWindow(testApp.app);
      const panelId = await waitForSourcePanel(testApp.app, source);
      await testApp.window.waitForTimeout(500);

      await expectShellFitsMobileViewport(testApp.window);
      await expectPanelFitsMobileViewport(testApp.app, panelId);
    });
  }

  for (const { source, stateArgs } of STATEFUL_PANELS) {
    test(`${source} fits a phone-width panel viewport`, async () => {
      testApp = await launchTestApp({ initialPanel: "about/new", launchTimeout: 120_000 });
      await setMobileWindow(testApp.app);
      const parentId = await waitForAnyPanel(testApp.app);
      const created = await createPanel(testApp.app, parentId, source, {
        focus: true,
        stateArgs,
      });
      await testApp.window.waitForTimeout(500);

      await expectShellFitsMobileViewport(testApp.window);
      await expectPanelFitsMobileViewport(testApp.app, created.id);
    });
  }
});
