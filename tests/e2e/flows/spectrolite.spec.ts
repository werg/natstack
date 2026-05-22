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

function initializeLargeVaultRepo(workspacePath: string): void {
  const repo = path.join(workspacePath, "source", "projects", "default");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "Hub.mdx"),
    [
      "---",
      "title: Large Hub",
      "---",
      "",
      "# Large Hub",
      "",
      "This file is linked from many generated notes.",
      "",
    ].join("\n")
  );

  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    const area = Math.floor(i / 50).toString().padStart(2, "0");
    const dir = path.join(repo, "bulk", `area-${area}`);
    fs.mkdirSync(dir, { recursive: true });
    const relTitle = `Bulk-${i.toString().padStart(4, "0")}`;
    const linksHub = i % 100 === 0 || i === total - 1;
    fs.writeFileSync(
      path.join(dir, `${relTitle}.mdx`),
      [
        "---",
        `title: ${relTitle}`,
        "---",
        "",
        `# ${relTitle}`,
        "",
        linksHub ? `This generated note links to [[Hub]].` : "This generated note has no hub backlink.",
        "",
      ].join("\n")
    );
  }

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
  }
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@natstack.local"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial large vault"], { cwd: repo, stdio: "ignore" });
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
  expect(await clickPanelSelector(app.app, panelId, '[data-testid="spectrolite-branch-trigger"]')).toBe(true);
  await expect.poll(() => getPanelHtml(app.app, panelId), {
    timeout: 10000,
  }).toContain(`data-branch-name="${branch}"`);
  const clicked = await executePanelScript<boolean>(app.app, panelId, `
    (() => {
      const target = ${JSON.stringify(branch)};
      const marker = document.querySelector('[data-branch-name="' + target + '"]');
      const node = marker instanceof HTMLElement
        ? marker.closest('[role="menuitem"], [data-radix-collection-item]')
        : null;
      if (!(node instanceof HTMLElement)) return false;
      node.click();
      return true;
    })()
  `);
  expect(clicked).toBe(true);
}

async function clickAgentOption(app: TestApp, panelId: string, className?: string): Promise<void> {
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
  test.describe.configure({ timeout: 180000 });

  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("opens a preselected vault and renders the requested document", async () => {
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

    const html = await getPanelHtml(testApp.app, panelId);
    expect(html).toContain('data-testid="spectrolite-editor"');
    expect(html).not.toContain("/projects/&lt;not-selected-yet&gt;");
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
    }).toContain("Select a file from the sidebar");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("@scribe");
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
    }).toContain("@scribe");
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

    expect(await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-switch-vault"]')).toBe(true);
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

    const openedSecond = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("Second.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedSecond).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Second Vault");

    const openedProof = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("AgentProof.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedProof).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Deterministic agent wrote this in /projects/second.");

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

  test("surfaces external write conflicts and missing active files", async () => {
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
    await typePanelText(testApp.app, panelId, "\nUser keeps this unflushed line");

    const installedE2EHook = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const install = globalThis.__spectroliteInstallE2E__;
        return typeof install === "function" ? install() : false;
      })()
    `);
    expect(installedE2EHook).toBe(true);

    const externalWrite = await executePanelScript<boolean>(testApp.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return false;
        await api.writeFile("E2E.mdx", [
          "---",
          "title: E2E",
          "---",
          "",
          "# E2E Note",
          "",
          "External agent edit.",
          ""
        ].join("\\n"));
        return true;
      })()
    `);
    expect(externalWrite).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-disk-conflict"');

    const keptMine = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Keep my edits"));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()
    `);
    expect(keptMine).toBe(true);

    const openedLinked = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("Linked.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedLinked).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("This note points at");

    const externalDelete = await executePanelScript<boolean>(testApp.app, panelId, `
      (async () => {
        const api = globalThis.__spectroliteE2E__;
        if (!api) return false;
        await api.unlink("Linked.mdx");
        return true;
      })()
    `);
    expect(externalDelete).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-file-missing"');
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Your in-memory buffer is the only copy");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Recreate file");
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

    await setCommitMessage(testApp, panelId, "E2E commit");
    expect(await clickPanelSelector(testApp.app, panelId, '[data-testid="spectrolite-commit-button"]')).toBe(true);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("0 dirty");
  });

  test("shows backlinks, recovers around broken MDX/live JSX, and switches branches", async () => {
    workspacePath = createManagedTestWorkspace();
    initializeDefaultVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "E2E.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-backlink-Linked.mdx"');

    await clickBranch(testApp, panelId, "branch-e2e");
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("branch-e2e");

    const openedBroken = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("Broken.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedBroken).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Error parsing markdown");
    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);

    const openedLiveError = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('button, a')).find((node) => node instanceof HTMLElement && node.textContent?.includes("LiveError.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedLiveError).toBe(true);
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-testid="spectrolite-live-jsx-error"');
    expect(await clickPanelSelector(testApp.app, panelId, '[contenteditable="true"]')).toBe(true);
  });

  test("keeps discovery and backlinks responsive in a large vault", async () => {
    test.setTimeout(240000);
    workspacePath = createManagedTestWorkspace();
    initializeLargeVaultRepo(workspacePath);
    replaceInitPanels(workspacePath, {
      repoRoot: "/projects/default",
      openPath: "Hub.mdx",
    });

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForSpectrolitePanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Large Hub");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Bulk-1999.mdx");
    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("spectrolite-backlink-bulk/area-39/Bulk-1999.mdx");

    const metrics = await executePanelScript<{ files: number; backlinks: number; responsive: boolean }>(testApp.app, panelId, `
      (() => {
        const fileButtons = Array.from(document.querySelectorAll("button"))
          .filter((node) => node instanceof HTMLElement && node.textContent?.includes(".mdx"));
        const backlinkLinks = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'));
        const refresh = document.querySelector('[aria-label="Refresh"]');
        if (refresh instanceof HTMLElement) refresh.click();
        return {
          files: fileButtons.length,
          backlinks: backlinkLinks.length,
          responsive: document.querySelector('[data-testid="spectrolite-editor"]') instanceof HTMLElement,
        };
      })()
    `);
    expect(metrics.files).toBeGreaterThanOrEqual(2001);
    expect(metrics.backlinks).toBeGreaterThanOrEqual(21);
    expect(metrics.responsive).toBe(true);

    const openedFarBacklink = await executePanelScript<boolean>(testApp.app, panelId, `
      (() => {
        const link = Array.from(document.querySelectorAll('[data-testid^="spectrolite-backlink-"]'))
          .find((node) => node instanceof HTMLElement && node.textContent?.includes("Bulk-1999.mdx"));
        if (!(link instanceof HTMLElement)) return false;
        link.click();
        return true;
      })()
    `);
    expect(openedFarBacklink).toBe(true);
    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Bulk-1999");
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
