import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import {
  createManagedTestWorkspace,
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  getPanelDiagnostics,
  getPanelHtml,
  getPanelText,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  removeManagedTestWorkspace,
  startPanelDiagnostics,
  executePanelScript,
  type TestApp,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

type PendingApproval = {
  approvalId: string;
  kind: string;
  title?: string;
  credentialLabel?: string;
  units?: Array<{ unitKind: string; unitName: string }>;
};

const OPENAI_CODEX_CREDENTIAL_ID = "e2e-openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function centralDataDirForWorkspace(workspaceDir: string): string {
  return path.dirname(path.dirname(workspaceDir));
}

function envForCentralDataDir(centralDataDir: string): Partial<NodeJS.ProcessEnv> {
  switch (process.platform) {
    case "win32":
      return { APPDATA: path.dirname(centralDataDir) };
    case "darwin":
      return {
        HOME: path.dirname(path.dirname(path.dirname(centralDataDir))),
      };
    default:
      return {
        XDG_CONFIG_HOME: path.dirname(centralDataDir),
        HOME: path.join(path.dirname(path.dirname(centralDataDir)), "home"),
      };
  }
}

async function withCredentialStoreEnv<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const overrides = envForCentralDataDir(centralDataDirForWorkspace(workspaceDir));
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function seedOpenAiCodexCredential(workspaceDir: string): Promise<void> {
  await withCredentialStoreEnv(workspaceDir, async () => {
    const store = new CredentialStore({
      basePath: path.join(centralDataDirForWorkspace(workspaceDir), "credentials"),
    });
    await store.saveUrlBound({
      id: OPENAI_CODEX_CREDENTIAL_ID,
      label: "ChatGPT Codex model credential",
      providerId: "url-bound",
      connectionId: OPENAI_CODEX_CREDENTIAL_ID,
      connectionLabel: "ChatGPT Codex model credential",
      accountIdentity: {
        providerUserId: "e2e-openai-account",
        email: "e2e@example.invalid",
      },
      accessToken: "e2e-openai-token",
      scopes: ["openid", "profile", "email", "offline_access"],
      bindings: [
        {
          id: "fetch",
          use: "fetch",
          audience: [{ url: OPENAI_CODEX_BASE_URL, match: "path-prefix" }],
          injection: {
            type: "header",
            name: "Authorization",
            valueTemplate: "Bearer {token}",
            stripIncoming: ["authorization"],
          },
        },
      ],
      metadata: {
        modelProviderId: "openai-codex",
        materialType: "bearer-token",
      },
    });
  });
}

async function listPendingApprovals(testApp: TestApp): Promise<PendingApproval[]> {
  return rpcCall(testApp, "shellApproval", "listPending", []) as Promise<PendingApproval[]>;
}

async function rpcCall(
  testApp: TestApp,
  service: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return testApp.app.evaluate(async (_electron, request) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    return testApi.rpcCall(request.service, request.method, request.args);
  }, { service, method, args });
}

async function shellHasApprovalBar(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `Boolean(
            document.querySelector(".approval-bar")
              && (document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]'))
          )`,
          true
        );
        if (result) return true;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return false;
  });
}

async function clickShellButton(testApp: TestApp, label: RegExp): Promise<boolean> {
  return testApp.app.evaluate(
    async ({ webContents }, labelSource) => {
      const label = new RegExp(labelSource, "i");
      const candidates: Array<{ contents: Electron.WebContents; priority: number }> = [];
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          const priority = await contents.executeJavaScript(
            `(() => {
              const hasHostedShellChrome = Boolean(document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]'));
              const hasApprovalBar = Boolean(document.querySelector(".approval-bar"));
              if (hasHostedShellChrome && hasApprovalBar) return 0;
              if (hasApprovalBar) return 1;
              if (hasHostedShellChrome) return 2;
              return 3;
            })()`,
            true
          );
          candidates.push({ contents, priority });
        } catch {
          // Ignore non-DOM webContents.
        }
      }
      candidates.sort((a, b) => a.priority - b.priority);
      for (const { contents } of candidates) {
        if (contents.isDestroyed()) continue;
        try {
          const clicked = await contents.executeJavaScript(
            `(() => {
              const label = new RegExp(${JSON.stringify(labelSource)}, "i");
              const buttons = Array.from(document.querySelectorAll("button"));
              const button = buttons.find((item) => label.test(item.textContent ?? ""));
              if (!button) return false;
              button.click();
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
    },
    label.source
  );
}

async function listShellDomSnapshots(testApp: TestApp): Promise<
  Array<{
    id: number;
    url: string;
    title: string;
    text: string;
    hasTitlebar: boolean;
    hasApprovalBar: boolean;
    approvalText: string;
  }>
> {
  return testApp.app.evaluate(async ({ webContents }) => {
    const snapshots = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      if (!url.includes("/_a/") && !url.endsWith("/index.html")) continue;
      try {
        const dom = await contents.executeJavaScript(
          `(() => {
            const approval = document.querySelector(".approval-bar");
            return {
              text: document.body?.innerText?.slice(0, 4000) ?? "",
              hasTitlebar: Boolean(document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')),
              hasApprovalBar: Boolean(approval),
              approvalText: approval?.textContent ?? "",
            };
          })()`,
          true
        );
        snapshots.push({
          id: contents.id,
          url,
          title: contents.getTitle(),
          ...dom,
        });
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return snapshots;
  });
}

async function attachStartupDiagnostics(testApp: TestApp): Promise<void> {
  const pending = await listPendingApprovals(testApp).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const shellDom = await listShellDomSnapshots(testApp).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const panels = await getPanelTree(testApp.app).catch(() => []);
  const panelDetails = [];
  const channelNames: string[] = [];
  for (const panel of panels) {
    const id = panel.id;
    const text = await getPanelText(testApp.app, id).catch((error: unknown) =>
      error instanceof Error ? `ERROR: ${error.message}` : `ERROR: ${String(error)}`
    );
    const channelName = text.match(/\bchat-[a-z0-9]+\b/)?.[0];
    if (channelName) channelNames.push(channelName);
    panelDetails.push({
      id,
      title: panel.title,
      snapshot: panel.snapshot,
      source: panel.snapshot?.source,
      text,
      htmlSummary: await getPanelHtml(testApp.app, id)
        .then((html) => ({
          length: html.length,
          hasLoader: html.includes("/__loader.js"),
          hasBundle: html.includes("./bundle.js"),
          hasTransport: html.includes("/__transport.js"),
          hasActionBar: html.includes("chat-action-bar"),
        }))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
      diagnostics: await getPanelDiagnostics(testApp.app, id).catch(() => []),
    });
  }
  const channelParticipants = [];
  const channelReplays = [];
  const agentDebugStates = [];
  for (const channelName of channelNames) {
    const resolved = await rpcCall(testApp, "workers", "resolveService", [
      "natstack.channel.v1",
      channelName,
    ]).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const targetId =
      typeof resolved === "object" &&
      resolved !== null &&
      "targetId" in resolved &&
      typeof resolved.targetId === "string"
        ? resolved.targetId
        : null;
    const firstPanelId = panels[0]?.id;
    const participants =
      targetId && firstPanelId
        ? await executePanelScript(
            testApp.app,
            firstPanelId,
            `globalThis.__natstackRequire__("@workspace/runtime").rpc.call(${JSON.stringify(targetId)}, "getParticipants", [])`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    const replay =
      targetId && firstPanelId
        ? await executePanelScript(
            testApp.app,
            firstPanelId,
            `(() => globalThis.__natstackRequire__("@workspace/runtime").rpc.call(${JSON.stringify(targetId)}, "getReplayAfter", [0]).then((replay) => ({
              ready: replay?.ready,
              snapshots: replay?.snapshots,
              logEvents: (replay?.logEvents ?? []).map((event) => ({
                id: event.id,
                type: event.type,
                senderId: event.senderId,
                senderMetadata: event.senderMetadata,
                payloadKind: event.payload?.kind,
                agenticKind: event.payload?.payload?.kind,
                role: event.payload?.payload?.message?.role ?? event.payload?.message?.role,
                content: String(event.payload?.payload?.message?.content ?? event.payload?.message?.content ?? event.payload?.content ?? "").slice(0, 300),
              })),
            })))()`
          ).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
    channelReplays.push({ channelName, replay });
    const agentParticipants = Array.isArray(participants)
      ? participants.filter((participant: { participantId?: unknown }) =>
          typeof participant.participantId === "string" &&
          participant.participantId.startsWith("do:workers/agent-worker:AiChatWorker:")
        )
      : [];
    for (const agent of agentParticipants) {
      const agentId = (agent as { participantId: string }).participantId;
      const debugState =
        firstPanelId
          ? await executePanelScript(
              testApp.app,
              firstPanelId,
              `globalThis.__natstackRequire__("@workspace/runtime").rpc.call(${JSON.stringify(agentId)}, "getDebugState", [${JSON.stringify(channelName)}])`
            ).catch((error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
            }))
          : null;
      agentDebugStates.push({ channelName, agentId, debugState });
    }
    channelParticipants.push({ channelName, resolved, participants });
  }
  const workerLogs = await rpcCall(testApp, "workspace", "units.logs", [
    "workers/agent-worker",
    { limit: 200 },
  ]).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const diagnostics = {
    pending,
    shellDom,
    panels: panelDetails,
    channelParticipants,
    channelReplays,
    agentDebugStates,
    workerLogs,
  };
  await fs.writeFile("/tmp/startup-approvals-diagnostics.json", JSON.stringify(diagnostics, null, 2));
  console.log("STARTUP_APPROVALS_DIAGNOSTICS", JSON.stringify(diagnostics, null, 2).slice(0, 80_000));
  await test.info().attach("startup-approvals-diagnostics.json", {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: "application/json",
  });
}

function isExtensionInstallApproval(approval: PendingApproval): boolean {
  return (
    approval.kind === "unit-batch" &&
    !!approval.units?.some((unit) => unit.unitKind === "extension")
  );
}

function isOpenAiCredentialApproval(approval: PendingApproval): boolean {
  return approval.kind === "credential" && approval.credentialLabel === "ChatGPT Codex model credential";
}

test.describe("Desktop Startup Approvals", () => {
  test.setTimeout(240_000);

  let testApp: TestApp | undefined;
  let workspaceDir: string | undefined;

  test.afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
    if (workspaceDir) {
      removeManagedTestWorkspace(workspaceDir);
      workspaceDir = undefined;
    }
  });

  test("shows extension install prompts, then OpenAI credential prompts for initial chats", async () => {
    workspaceDir = createManagedTestWorkspace();
    await seedOpenAiCodexCredential(workspaceDir);

    testApp = await launchTestApp({
      workspace: workspaceDir,
      env: { NATSTACK_WORKSPACE_CREATED_FROM_TEMPLATE: "1" },
      launchTimeout: 240_000,
    });

    await expect
      .poll(
        async () => {
          const pending = await listPendingApprovals(testApp!);
          return pending.some(isExtensionInstallApproval) && (await shellHasApprovalBar(testApp!));
        },
        { timeout: 90_000, intervals: [500, 1000, 2000] }
      )
      .toBe(true);

    expect(await clickShellButton(testApp, /^Approve all$/)).toBe(true);

    for (const panel of await getPanelTree(testApp.app)) {
      await startPanelDiagnostics(testApp.app, panel.id).catch(() => {});
    }

    try {
      await expect
        .poll(
          async () => {
            const pending = await listPendingApprovals(testApp!);
            return pending.filter(isOpenAiCredentialApproval).length;
          },
          { timeout: 60_000, intervals: [1000, 2000, 5000] }
        )
        .toBeGreaterThanOrEqual(2);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    for (let index = 0; index < 2; index += 1) {
      await expect
        .poll(
          async () => (await listPendingApprovals(testApp!)).some(isOpenAiCredentialApproval),
          { timeout: 30_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
      expect(await clickShellButton(testApp, /^Use this session$/)).toBe(true);
    }

    await expect
      .poll(
        async () => (await listPendingApprovals(testApp!)).filter(isOpenAiCredentialApproval).length,
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(0);
  });
});
