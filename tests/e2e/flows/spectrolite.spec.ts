/**
 * Spectrolite E2E tests.
 *
 * Core editor coverage is ported in-system to @workspace/testkit
 * (workspace/packages/testkit/src/suites/spectrolite.ts): preselected vault
 * render, wikilink follow, broken-MDX resilience, external-write surfacing,
 * and large-vault responsiveness/profiling. This file keeps only the flows
 * that are not portable: first-run vault selection, vault switching with
 * agent scope add/remove, empty-vault recovery, flush/commit dirty-state,
 * branch switching, and the mobile-viewport layout check.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  clickPanelSelector,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  executePanelScript,
  getPanelHtml,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  type TestApp,
  createManagedTestWorkspace,
  typePanelText,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

function replaceInitPanels(workspacePath: string, stateArgs: Record<string, unknown>): void {
  const configPath = path.join(workspacePath, "source", "meta", "natstack.yml");
  const original = fs.readFileSync(configPath, "utf8");
  const marker = "# =============================================================================\n# Stable Durable Object singletons.";
  const markerIndex = original.indexOf(marker);
  if (markerIndex < 0) throw new Error("Could not find natstack.yml singleton marker");
  const indentedStateArgs = JSON.stringify(stateArgs, null, 2)
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  const replacement = `# NatStack Workspace Configuration
# This file configures the workspace for deterministic Spectrolite E2E tests

initPanels:
  - source: panels/spectrolite
    stateArgs: ${indentedStateArgs.trimStart()}

`;
  fs.writeFileSync(configPath, replacement + original.slice(markerIndex));
}

function initializeDefaultVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "default");
  fs.writeFileSync(
    path.join(repo, "E2E.mdx"),
    [
      "---",
      "title: E2E",
      "tags: [e2e]",
      "---",
      "",
      "# E2E Note",
      "",
      "A simple note for end-to-end editor interactions.",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "Linked.mdx"),
    [
      "---",
      "title: Linked",
      "---",
      "",
      "# Linked",
      "",
      "This note points at [[E2E]].",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "Broken.mdx"),
    [
      "---",
      "title: Broken",
      "---",
      "",
      "# Broken",
      "",
      "This document keeps the editor usable around malformed JSX.",
      "",
      "<BrokenWidget",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "LiveError.mdx"),
    [
      "---",
      "title: Live Error",
      "---",
      "",
      "# Live Error",
      "",
      "The editor should stay usable when a JSX preview fails.",
      "",
      "<MissingWidget />",
      "",
    ].join("\n")
  );
  fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
  }
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@natstack.local"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial default vault"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "branch-e2e"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(
    path.join(repo, "E2E.mdx"),
    [
      "---",
      "title: E2E",
      "tags: [e2e, branch]",
      "---",
      "",
      "# E2E Note",
      "",
      "This text only exists on the branch-e2e branch.",
      "",
    ].join("\n")
  );
  execFileSync("git", ["add", "E2E.mdx"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Branch fixture"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
}

function initializeSecondVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "second");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "Second.mdx"),
    [
      "---",
      "title: Second Vault",
      "---",
      "",
      "# Second Vault",
      "",
      "This note proves Spectrolite switched vault roots.",
      "",
    ].join("\n")
  );
  fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
  }
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@natstack.local"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial second vault"], { cwd: repo, stdio: "ignore" });
}

function flattenPanels(nodes: Array<Record<string, any>>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const node of nodes) {
    out.push(node);
    const children = Array.isArray(node.children) ? node.children : [];
    out.push(...flattenPanels(children));
  }
  return out;
}

async function waitForSpectrolitePanel(app: TestApp): Promise<string> {
  await expect.poll(async () => {
    try {
      return flattenPanels(await getPanelTree(app.app)).length;
    } catch {
      return 0;
    }
  }, {
    timeout: 30000,
  }).toBeGreaterThan(0);
  await expect.poll(async () => {
    try {
      const panels = flattenPanels(await getPanelTree(app.app));
      const panel = panels.find((candidate) => candidate.snapshot?.source === "panels/spectrolite" || candidate.source === "panels/spectrolite");
      return typeof panel?.id === "string" ? panel.id : "";
    } catch {
      return "";
    }
  }, {
    timeout: 30000,
  }).not.toBe("");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const panels = flattenPanels(await getPanelTree(app.app));
      const panel = panels.find((candidate) => candidate.snapshot?.source === "panels/spectrolite" || candidate.source === "panels/spectrolite");
      if (typeof panel?.id === "string") {
        await startPanelDiagnostics(app.app, panel.id);
        return panel.id;
      }
    } catch {
      // The app can still be swapping Electron execution contexts here.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Spectrolite panel not found after panel tree stabilized");
}

async function setCommitMessage(app: TestApp, panelId: string, message: string): Promise<void> {
  await executePanelScript(app.app, panelId, `
    (() => {
      const input = document.querySelector('[aria-label="Commit message"]');
      if (!(input instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, ${JSON.stringify(message)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

async function clickBranch(app: TestApp, panelId: string, branch: string): Promise<void> {
  const hasVisibleTrigger = await executePanelScript<boolean>(app.app, panelId, `
    document.querySelector('[data-testid="spectrolite-branch-trigger"]') instanceof HTMLElement
  `);
  if (!hasVisibleTrigger) {
    await openWorkspaceSettings(app, panelId);
  }
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain('data-testid="spectrolite-branch-trigger"');
  expect(await clickPanelSelector(app.app, panelId, '[data-testid="spectrolite-branch-trigger"]')).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 10000,
  }).toContain(`data-branch-name="${branch}"`);
  const clicked = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const target = ${JSON.stringify(branch)};
      const marker = document.querySelector('[data-branch-name="' + target + '"]');
      const node = marker instanceof HTMLElement
        ? marker.closest('[role="menuitem"], [data-radix-collection-item]') ?? marker
        : null;
      if (!(node instanceof HTMLElement)) return false;
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, buttons: 1 }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    })()
  `);
  expect(clicked).toBe(true);
}

async function clickPanelElement(app: TestApp, panelId: string, selector: string): Promise<boolean> {
  return executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLElement)) return false;
      node.click();
      return true;
    })()
  `);
}

async function openFilesDrawer(app: TestApp, panelId: string): Promise<void> {
  const alreadyOpen = await executePanelScript<boolean>(app.app, panelId, `
    document.querySelector('[data-testid="spectrolite-files-drawer"]') instanceof HTMLElement
  `);
  if (alreadyOpen) return;
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain('data-testid="spectrolite-files-trigger"');
  expect(await clickPanelElement(app, panelId, '[data-testid="spectrolite-files-trigger"]')).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 10000,
  }).toContain('data-testid="spectrolite-files-drawer"');
}

async function openFileFromFilesDrawer(app: TestApp, panelId: string, fileName: string): Promise<void> {
  await openFilesDrawer(app, panelId);
  expect(await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const button = document.querySelector('[data-testid="spectrolite-files-drawer"] [aria-label="Refresh"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `)).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 60000,
  }).toContain(fileName);
  const opened = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const target = ${JSON.stringify(fileName)};
      const drawer = document.querySelector('[data-testid="spectrolite-files-drawer"]');
      if (!(drawer instanceof HTMLElement)) return false;
      const link = Array.from(drawer.querySelectorAll('button, a'))
        .find((node) => node instanceof HTMLElement && node.textContent?.includes(target));
      if (!(link instanceof HTMLElement)) return false;
      link.click();
      return true;
    })()
  `);
  expect(opened).toBe(true);
}

async function openWorkspaceSettings(app: TestApp, panelId: string): Promise<void> {
  const opened = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const button = document.querySelector('[aria-label="Workspace settings"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `);
  expect(opened).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 10000,
  }).toContain('data-testid="spectrolite-workspace-settings-drawer"');
}

async function closeTopDialog(app: TestApp, panelId: string): Promise<void> {
  const closed = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const buttons = Array.from(document.querySelectorAll('[aria-label="Close"]'))
        .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
      const button = buttons.at(-1);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `);
  expect(closed).toBe(true);
  await expect.poll(() => executePanelScript<boolean>(app.app, panelId, `
    !document.querySelector('[data-testid="spectrolite-files-drawer"], [data-testid="spectrolite-backlinks-drawer"], [data-testid="spectrolite-workspace-settings-drawer"]')
  `), {
    timeout: 10000,
  }).toBe(true);
}

async function clickAgentOption(app: TestApp, panelId: string, className?: string): Promise<void> {
  const hasVisibleTrigger = await executePanelScript<boolean>(app.app, panelId, `
    document.querySelector('[data-testid="spectrolite-agent-add-trigger"]') instanceof HTMLElement
  `);
  if (!hasVisibleTrigger) {
    await openWorkspaceSettings(app, panelId);
  }
  expect(await clickPanelSelector(app.app, panelId, '[data-testid="spectrolite-agent-add-trigger"]')).toBe(true);
  const selector = className
    ? `[data-testid="spectrolite-agent-option-${className}"]`
    : '[data-testid^="spectrolite-agent-option-"]';
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 10000,
  }).toContain(className ? `spectrolite-agent-option-${className}` : "spectrolite-agent-option-");
  const clicked = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const item = node instanceof HTMLElement
        ? node.closest('[role="menuitem"], [data-radix-collection-item]')
        : null;
      if (!(item instanceof HTMLElement)) return false;
      item.click();
      return true;
    })()
  `);
  expect(clicked).toBe(true);
}

async function getPanelLayoutIssues(app: TestApp, panelId: string): Promise<string[]> {
  return executePanelScript<string[]>(app.app, panelId, `
    (() => {
      const issues = [];
      for (const selector of [
        '[data-testid="spectrolite-editor"]',
        '[data-testid="spectrolite-mobile-actions"]',
        '[aria-label="Open files"]'
      ]) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) {
          issues.push(selector + " missing");
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) issues.push(selector + " has no visible area");
        if (rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) {
          issues.push(selector + " overflows viewport");
        }
      }
      const editor = document.querySelector('[data-testid="spectrolite-editor"]');
      const actions = document.querySelector('[data-testid="spectrolite-mobile-actions"]');
      if (editor instanceof HTMLElement && actions instanceof HTMLElement) {
        const e = editor.getBoundingClientRect();
        const a = actions.getBoundingClientRect();
        if (e.bottom > a.top + 1) issues.push("editor overlaps mobile actions");
      }
      return issues;
    })()
  `);
}

test.describe("Spectrolite", () => {
  test.describe.configure({ timeout: 240000 });

  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("lets the user pick the default vault from first-run state", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {});

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-vault-default"');
    expect(await getPanelText(testApp.app, panelId)).not.toContain("@scribe");

    expect(await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-vault-default"]')).toBe(true);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Open a file to start editing.");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Agents using projects/default");
  });

  test("switches vaults, updates agent scope status, and supports manual agent add/remove", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    initializeSecondVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Agents using projects/default");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('contenteditable="true"');

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nOld vault dirty line must stay in default");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Old vault dirty line must stay in default");

    await clickAgentOption(testApp, panelId, "TestAgentWorker");
    await expect.poll(async () => executePanelScript<number>(testApp!.app, panelId, `
      document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
    `), {
      timeout: 60000,
    }).toBeGreaterThan(1);
    await closeTopDialog(testApp, panelId);

    expect(await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-toolbar-switch-vault"]')).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-vault-second"');

    expect(await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-vault-second"]')).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("projects/second");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Agents using projects/second");

    const installedE2EHook = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const install = globalThis.__spectroliteInstallE2E__;
        return typeof install === "function" ? install() : false;
      })()
    `);
    expect(installedE2EHook).toBe(true);

    const leakedOldVaultFile = await executePanelScript<string | null>(testApp.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return "missing-api";
        try {
          return await api.readFile("E2E.mdx");
        } catch {
          return null;
        }
      })()
    `);
    expect(leakedOldVaultFile).toBeNull();

    await expect.poll(async () => executePanelScript<string | null>(testApp!.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return null;
        try {
          return await api.readFile("AgentProof.mdx");
        } catch {
          return null;
        }
      })()
    `), {
      timeout: 60000,
    }).toContain("Deterministic agent wrote this in /projects/second.");

    await openFilesDrawer(testApp, panelId);
    expect(await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = document.querySelector('[aria-label="Refresh"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `)).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("AgentProof.mdx");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Second.mdx");

    await openFileFromFilesDrawer(testApp, panelId, "Second.mdx");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Second Vault");

    await openFileFromFilesDrawer(testApp, panelId, "AgentProof.mdx");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Deterministic agent wrote this in /projects/second.");

    await openWorkspaceSettings(testApp, panelId);
    const removedManualAgent = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]'))
          .find((node) => node instanceof HTMLElement && !node.getAttribute("data-testid")?.endsWith("-scribe"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(removedManualAgent).toBe(true);
    await expect.poll(async () => executePanelScript<number>(testApp!.app, panelId, `
      document.querySelectorAll('[data-testid^="spectrolite-agent-remove-"]').length
    `), {
      timeout: 60000,
    }).toBe(1);
  });

  test("recovers from an empty vault by creating a starter note", async () => {
    workspacePath = createManagedTestWorkspace();
    const repo = path.join(workspacePath, "source", "projects", "empty");
    fs.mkdirSync(repo, { recursive: true });
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "E2E"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@natstack.local"], { cwd: repo, stdio: "ignore" });
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/empty",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("This vault is empty");
    const createdStarter = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Create starter note"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(createdStarter).toBe(true);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Welcome to Spectrolite");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Welcome.mdx");
  });

  test("flushes edits and updates the commit dirty indicator", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nE2E Spectrolite edit");

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Spectrolite edit");

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("1 dirty");
  });

  test("commits an edit and returns the vault to a clean state", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nCommitted by e2e");

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("1 dirty");

    await clickBranch(testApp, panelId, "branch-e2e");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Commit or discard changes before switching branches.");
    await closeTopDialog(testApp, panelId);

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nImmediate pre-commit line");
    await setCommitMessage(testApp, panelId, "E2E commit");
    await expect.poll(() => executePanelScript<boolean>(testApp!.app, panelId, `
      (() => {
        const input = document.querySelector('[aria-label="Commit message"]');
        const button = document.querySelector('[data-testid="spectrolite-commit-button"]');
        return input instanceof HTMLTextAreaElement
          && input.value.startsWith("E2E commit")
          && button instanceof HTMLButtonElement
          && !button.disabled;
      })()
    `), {
      timeout: 10000,
    }).toBe(true);
    expect(await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-commit-button"]')).toBe(true);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("0 dirty");
    const repo = path.join(workspacePath, "source", "projects", "default");
    const committed = execFileSync("git", ["show", "HEAD:E2E.mdx"], { cwd: repo, encoding: "utf8" });
    expect(committed).toContain("Committed by e2e");
    expect(committed).toContain("Immediate pre-commit line");
  });

  test("blocks branch switching after immediate unflushed typing", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
    await typePanelText(testApp.app, panelId, "\nUnflushed branch guard line");
    await clickBranch(testApp, panelId, "branch-e2e");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Commit or discard changes before switching branches.");
    const repo = path.join(workspacePath, "source", "projects", "default");
    expect(fs.readFileSync(path.join(repo, "E2E.mdx"), "utf8")).toContain("Unflushed branch guard line");
  });

  // Backlinks and broken-MDX/live-JSX recovery are ported in-system
  // (workspace/packages/testkit/src/suites/spectrolite.ts); branch switching
  // is not, so only that part of the original test remains here.
  test("switches branches", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E Note");

    expect(await clickPanelElement(testApp, panelId, '[data-testid="spectrolite-quick-open-trigger"]')).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 10000,
    }).toContain('data-testid="spectrolite-quick-open-input"');
    const quickOpened = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const input = document.querySelector('[data-testid="spectrolite-quick-open-input"]');
        if (!(input instanceof HTMLInputElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "Linked");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    expect(quickOpened).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("This note points at");

    await clickBranch(testApp, panelId, "branch-e2e");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("branch-e2e");
    await closeTopDialog(testApp, panelId);
  });

  test("keeps core controls usable in a mobile-sized viewport", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);
    await testApp.app.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0]?.setSize(390, 740);
    });
    await testApp.window.setViewportSize({ width: 390, height: 740 });
    await testApp.window.waitForTimeout(1000);

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-mobile-actions"');
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-editor"');
    const issues = await getPanelLayoutIssues(testApp, panelId);
    expect(issues).toEqual([]);

    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Open files"]')).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Files");
    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close files"]')).toBe(true);

    const openedSettings = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = document.querySelector('[aria-label="Workspace settings"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(openedSettings).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Workspace");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Agents");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-branch-trigger"');

    expect(await clickPanelSelector(testApp.app, panelId, '[aria-label="Close"]')).toBe(true);
    const openedCommit = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const actions = document.querySelector('[data-testid="spectrolite-mobile-actions"]');
        const button = actions?.querySelector("button");
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(openedCommit).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Commit");
  });
});
