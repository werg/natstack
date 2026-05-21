import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import {
  getPanelHtml,
  getPanelText,
  getPanelTree,
  launchTestApp,
  createManagedTestWorkspace,
  removeManagedTestWorkspace,
  type TestApp,
} from "../../setup/electronSetup";

function replaceInitPanels(workspacePath: string): void {
  const configPath = path.join(workspacePath, "source", "meta", "natstack.yml");
  const original = fs.readFileSync(configPath, "utf8");
  const marker = "# =============================================================================\n# Stable Durable Object singletons.";
  const markerIndex = original.indexOf(marker);
  if (markerIndex < 0) throw new Error("Could not find natstack.yml singleton marker");
  const replacement = `# NatStack Workspace Configuration
# This file configures the workspace for deterministic chat transcript E2E tests

initPanels:
  - source: panels/chat
    stateArgs:
      initialPrompt: "E2E initial prompt from natstack.yml"
      agentSource: "workers/test-agent"
      agentClass: "TestAgentWorker"
      agentConfig:
        deterministicResponse: true
        responseText: "Deterministic agent reply from the test worker."
        code: "read('skills/onboarding/SKILL.md')"
        delayMs: 500

`;
  fs.writeFileSync(configPath, replacement + original.slice(markerIndex));
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

async function waitForChatPanel(app: TestApp): Promise<string> {
  await expect.poll(async () => flattenPanels(await getPanelTree(app.app)).length, {
    timeout: 30000,
  }).toBeGreaterThan(0);
  const panels = flattenPanels(await getPanelTree(app.app));
  const chat = panels.find((panel) => panel.snapshot?.source === "panels/chat" || panel.source === "panels/chat");
  if (!chat?.id) throw new Error(`Chat panel not found: ${JSON.stringify(panels, null, 2)}`);
  return chat.id as string;
}

test.describe("Chat transcript UX", () => {
  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("renders initial prompt, pending/complete tool bead, and agent response through the real panel", async () => {
    workspacePath = createManagedTestWorkspace();
    replaceInitPanels(workspacePath);

    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180000 });
    const panelId = await waitForChatPanel(testApp);

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("E2E initial prompt from natstack.yml");

    await expect.poll(() => getPanelHtml(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain('data-invocation-status="pending"');

    await expect.poll(() => getPanelText(testApp!.app, panelId), {
      timeout: 60000,
    }).toContain("Deterministic agent reply from the test worker.");

    const finalText = await getPanelText(testApp.app, panelId);
    expect(finalText).toContain("Eval");
    expect(finalText).toContain("code: SKILL.md')");
    expect(finalText).not.toContain("[tool call:");
    expect(finalText).not.toContain("[eval] Console:");
    expect(finalText).not.toContain('{"ok":true}');

    const finalHtml = await getPanelHtml(testApp.app, panelId);
    expect(finalHtml).toContain('data-invocation-name="eval"');
    expect(finalHtml).toContain('data-invocation-status="complete"');
  });
});
