/**
 * App Startup E2E Tests
 *
 * Tests that the Natstack app launches correctly and the shell initializes.
 */

import { test, expect } from "@playwright/test";
import { launchTestApp, waitForAppReady, getPanelTree, type TestApp } from "../../setup/electronSetup";

test.describe("App Startup", () => {
  let testApp: TestApp;

  test.afterEach(async () => {
    if (testApp) {
      await testApp.cleanup();
    }
  });

  test("launches successfully with test workspace", async () => {
    testApp = await launchTestApp();

    // App should have launched and window should be visible
    expect(testApp.app).toBeDefined();
    expect(testApp.window).toBeDefined();
    expect(testApp.workspacePath).toBeDefined();
  });

  test("shell loads and displays initial content", async () => {
    testApp = await launchTestApp();
    const { window } = testApp;

    // Wait for the DOM to be fully loaded
    await window.waitForLoadState("domcontentloaded");

    // The shell should have loaded (check for any content)
    const content = await window.content();
    expect(content).toBeTruthy();
  });

  test("test API is available when NATSTACK_TEST_MODE=1", async () => {
    testApp = await launchTestApp();

    // The test API should be exposed on the global object
    const hasTestApi = await testApp.app.evaluate(() => {
      return typeof (globalThis as { __testApi?: unknown }).__testApi !== "undefined";
    });

    expect(hasTestApi).toBe(true);
  });

  test("panel tree is accessible via test API", async () => {
    testApp = await launchTestApp();

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Should be able to get the panel tree
    const panelTree = await getPanelTree(testApp.app);

    // Panel tree should exist (may be empty initially)
    expect(Array.isArray(panelTree)).toBe(true);
  });
});
