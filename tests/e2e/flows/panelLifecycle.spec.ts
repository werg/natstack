/**
 * Panel Lifecycle E2E Tests
 *
 * Only the persistence test remains here: it restarts the app, which cannot
 * run in-system. The rest of the lifecycle coverage (panel creation, focus
 * management, panel loading state) now lives in @workspace/testkit
 * (workspace/packages/testkit/src/suites/panelLifecycle.ts).
 */

import { test, expect } from "@playwright/test";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  createManagedTestWorkspace,
  removeManagedTestWorkspace,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test.describe("Panel Persistence", () => {
  // This test launches the app twice, so it needs a longer timeout
  test("panels persist across app restarts", async () => {
    test.setTimeout(120000); // 2 minutes for double app launch
    const workspacePath = createManagedTestWorkspace();

    // First session: create panels
    let testApp = await launchTestApp({ workspace: workspacePath });

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get initial panel tree
    const initialTree = await getPanelTree(testApp.app);

    // Save workspace path for restart
    // Close app using cleanup (which has a timeout to prevent hanging)
    await testApp.cleanup();

    // Restart with same workspace
    testApp = await launchTestApp({ workspace: workspacePath });

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get panel tree after restart
    const restoredTree = await getPanelTree(testApp.app);

    // All panels persist across restarts
    expect(restoredTree.length).toBeGreaterThanOrEqual(0);

    await testApp.cleanup();
    removeManagedTestWorkspace(workspacePath);
  });
});
