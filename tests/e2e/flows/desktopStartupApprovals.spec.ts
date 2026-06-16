import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

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
  units?: Array<{ unitKind: string; unitName: string; target?: string | null }>;
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

async function makeWorkspaceExtensionRequireApproval(workspaceDir: string): Promise<void> {
  const sourceRoot = path.join(workspaceDir, "source");
  const extensionDir = path.join(sourceRoot, "extensions", "e2e-approval");
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(
    path.join(extensionDir, "package.json"),
    JSON.stringify(
      {
        name: "@workspace-extensions/e2e-approval",
        version: "0.1.0",
        private: true,
        type: "module",
        natstack: {
          displayName: "E2E Approval Extension",
          entry: "index.ts",
          extension: { activationEvents: ["*"] },
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(extensionDir, "index.ts"),
    [
      "export async function activate() {",
      "  return {",
      "    ping() { return 'pong'; },",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  const configPath = path.join(sourceRoot, "meta", "natstack.yml");
  const config = (YAML.parse(await fs.readFile(configPath, "utf8")) ?? {}) as {
    extensions?: unknown[];
  };
  config.extensions = [
    ...(Array.isArray(config.extensions) ? config.extensions : []),
    { source: "extensions/e2e-approval" },
  ];
  await fs.writeFile(configPath, YAML.stringify(config), "utf8");
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

async function shellHasApprovalUi(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => {
            const hasHostedShellApproval = Boolean(
              document.querySelector(".approval-bar")
                && (document.querySelector(".titlebar-breadcrumb-scroll")
                  || document.querySelector('[aria-label="Menu"]'))
            );
            const bodyText = document.body?.innerText ?? "";
            const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && Array.from(document.querySelectorAll("button")).some((button) =>
                /^(Approve and start|Deny)$/i.test(button.textContent?.trim() ?? "")
              );
            return hasHostedShellApproval || hasLaunchGateApproval;
          })()`,
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

async function hostedShellHasApprovalUi(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => Boolean(
            document.querySelector(".approval-bar")
              && (document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]'))
          ))()`,
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

async function hostedShellHasChrome(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => Boolean(
            document.querySelector(".titlebar-breadcrumb-scroll")
              || document.querySelector('[aria-label="Menu"]')
          ))()`,
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

async function bootstrapLaunchGateHasCredentialApproval(testApp: TestApp): Promise<boolean> {
  return testApp.app.evaluate(async ({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const result = await contents.executeJavaScript(
          `(() => {
            const bodyText = document.body?.innerText ?? "";
            return Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && /credential|OpenAI|ChatGPT Codex model credential/i.test(bodyText);
          })()`,
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
              const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
                && Array.from(document.querySelectorAll("button")).some((button) =>
                  /^(Approve and start|Deny)$/i.test(button.textContent?.trim() ?? "")
                );
              if (hasHostedShellChrome && hasApprovalBar) return 0;
              if (hasApprovalBar) return 1;
              if (hasLaunchGateApproval) return 2;
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

async function clickShellButtonByPreference(testApp: TestApp, labels: RegExp[]): Promise<boolean> {
  for (const label of labels) {
    if (await clickShellButton(testApp, label)) return true;
  }
  return false;
}

async function listShellDomSnapshots(testApp: TestApp): Promise<
  Array<{
    id: number;
    url: string;
    title: string;
    text: string;
    hasTitlebar: boolean;
    hasApprovalBar: boolean;
    hasRecoveryApproval: boolean;
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
            const bodyText = document.body?.innerText ?? "";
            const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && Array.from(document.querySelectorAll("button")).some((button) =>
                /^(Approve and start|Deny)$/i.test(button.textContent?.trim() ?? "")
              );
            return {
              text: bodyText.slice(0, 4000),
              hasTitlebar: Boolean(document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')),
              hasApprovalBar: Boolean(approval),
              hasRecoveryApproval: hasLaunchGateApproval,
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
  const launchResult = await rpcCall(testApp, "workspace", "hostTargets.launch", [
    "electron",
  ]).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const hostView = await testApp.app
    .evaluate(() => {
      const testApi = (
        globalThis as {
          __testApi?: {
            getHostViewDebugInfo?: () => unknown;
          };
        }
      ).__testApi;
      return testApi?.getHostViewDebugInfo?.() ?? null;
    })
    .catch((error: unknown) => ({
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
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.channelName === "string"
        ? stateArgs.channelName
        : text.match(/\bchat-[a-z0-9]+\b/)?.[0];
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
    launchResult,
    hostView,
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

type StartupAgentCompletionState = {
  complete: boolean;
  channels: Array<{
    channelName: string;
    agentIds: string[];
    assistantCompleted: boolean;
    turnClosed: boolean;
    pendingWork: string[];
    failures: string[];
  }>;
  errors: string[];
};

async function collectStartupAgentCompletion(
  testApp: TestApp
): Promise<StartupAgentCompletionState> {
  const panels = await getPanelTree(testApp.app).catch(() => []);
  const firstPanelId = panels[0]?.id;
  const channelNames = new Set<string>();
  for (const panel of panels) {
    const stateArgs = panel.snapshot?.stateArgs as Record<string, unknown> | undefined;
    const channelName =
      typeof stateArgs?.channelName === "string"
        ? stateArgs.channelName
        : (await getPanelText(testApp.app, panel.id).catch(() => "")).match(/\bchat-[a-z0-9]+\b/)?.[0];
    if (channelName) channelNames.add(channelName);
  }
  if (!firstPanelId) {
    return { complete: false, channels: [], errors: ["No panel is available for RPC inspection"] };
  }

  const channels: StartupAgentCompletionState["channels"] = [];
  const errors: string[] = [];
  for (const channelName of channelNames) {
    const resolved = await rpcCall(testApp, "workers", "resolveService", [
      "natstack.channel.v1",
      channelName,
    ]).catch((error: unknown) => {
      errors.push(
        `${channelName}: resolveService failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    });
    const targetId =
      typeof resolved === "object" &&
      resolved !== null &&
      "targetId" in resolved &&
      typeof resolved.targetId === "string"
        ? resolved.targetId
        : null;
    if (!targetId) {
      channels.push({
        channelName,
        agentIds: [],
        assistantCompleted: false,
        turnClosed: false,
        pendingWork: [],
        failures: ["Channel service target was not resolved"],
      });
      continue;
    }

    const snapshot = await executePanelScript(
      testApp.app,
      firstPanelId,
      `(() => {
        const rpc = globalThis.__natstackRequire__("@workspace/runtime").rpc;
        const normalize = (event) => {
          const outer = event?.payload;
          const agentic = outer?.kind === "agentic.event" ? outer.payload : (outer?.payload?.kind ? outer.payload : outer);
          const body = agentic?.payload ?? agentic?.message ?? agentic ?? {};
          const message = body?.message ?? {};
          const rawBlocks = Array.isArray(body?.blocks)
            ? body.blocks
            : Array.isArray(message?.blocks)
              ? message.blocks
              : [];
          const blocks = Array.isArray(agentic?.payload?.blocks)
            ? agentic.payload.blocks.map((block) => ({
                type: block?.type,
                content: typeof block?.content === "string" ? block.content : "",
              }))
            : rawBlocks.map((block) => ({
                type: block?.type,
                content: typeof block?.content === "string" ? block.content : "",
              }));
          return {
            senderId: event?.senderId,
            kind: agentic?.kind ?? event?.payloadKind ?? event?.type,
            actorId: agentic?.actor?.id,
            actorKind: agentic?.actor?.kind,
            role: body?.role ?? message?.role,
            outcome: body?.outcome ?? message?.outcome,
            reason: body?.reason,
            recoverable: body?.recoverable,
            blocks,
          };
        };
        return Promise.all([
          rpc.call(${JSON.stringify(targetId)}, "getParticipants", []),
          rpc.call(${JSON.stringify(targetId)}, "getReplayAfter", [0]),
        ]).then(([participants, replay]) => ({
          participants,
          events: (replay?.logEvents ?? []).map(normalize),
        }));
      })()`
    ).catch((error: unknown) => {
      errors.push(
        `${channelName}: replay inspection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    });

    const participants = Array.isArray(
      (snapshot as { participants?: unknown } | null)?.participants
    )
      ? ((snapshot as { participants: Array<{ participantId?: unknown }> }).participants)
      : [];
    const agentIds = participants
      .map((participant) =>
        typeof participant.participantId === "string" ? participant.participantId : null
      )
      .filter(
        (participantId): participantId is string =>
          !!participantId &&
          participantId.startsWith("do:workers/agent-worker:AiChatWorker:")
      );
    const events = Array.isArray((snapshot as { events?: unknown } | null)?.events)
      ? ((snapshot as { events: Array<Record<string, unknown>> }).events)
      : [];
    const isAgentEvent = (event: Record<string, unknown>) =>
      agentIds.some(
        (agentId) => event["actorId"] === agentId || event["senderId"] === agentId
      );
    const assistantCompleted = events.some((event) => {
      if (event["kind"] !== "message.completed") return false;
      if (event["role"] !== "assistant" || event["outcome"] !== "completed") return false;
      if (!isAgentEvent(event)) return false;
      const blocks = Array.isArray(event["blocks"]) ? event["blocks"] : [];
      return blocks.some(
        (block) =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { content?: unknown }).content === "string" &&
          ((block as { content: string }).content.trim().length > 0)
      );
    });
    const turnClosed = events.some(
      (event) => event["kind"] === "turn.closed" && isAgentEvent(event)
    );
    const failures = events
      .filter((event) => {
        if (!isAgentEvent(event)) return false;
        if (event["kind"] === "message.failed" || event["kind"] === "invocation.failed") {
          return true;
        }
        return event["kind"] === "message.completed" && event["outcome"] === "empty";
      })
      .map((event) => `${String(event["kind"])}:${String(event["outcome"] ?? "")}`);
    const pendingWork: string[] = [];
    for (const agentId of agentIds) {
      const debugState = await executePanelScript(
        testApp.app,
        firstPanelId,
        `globalThis.__natstackRequire__("@workspace/runtime").rpc.call(${JSON.stringify(agentId)}, "getDebugState", [${JSON.stringify(channelName)}])`
      ).catch((error: unknown) => {
        pendingWork.push(
          `${agentId}: debug unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      });
      const state = (debugState as { result?: unknown } | null)?.result ?? debugState;
      const loop =
        state &&
        typeof state === "object" &&
        (state as { loops?: Record<string, unknown> }).loops
          ? (state as { loops: Record<string, unknown> }).loops[channelName]
          : null;
      if (loop && typeof loop === "object") {
        for (const key of ["pendingInvocations", "pendingApprovals", "pendingCredentialWaits"]) {
          const values = (loop as Record<string, unknown>)[key];
          if (Array.isArray(values) && values.length > 0) {
            pendingWork.push(`${agentId}:${key}:${values.join(",")}`);
          }
        }
      }
    }

    channels.push({
      channelName,
      agentIds,
      assistantCompleted,
      turnClosed,
      pendingWork,
      failures,
    });
  }

  const complete =
    channels.length >= 2 &&
    channels.every(
      (channel) =>
        channel.agentIds.length > 0 &&
        channel.assistantCompleted &&
        channel.turnClosed &&
        channel.pendingWork.length === 0 &&
        channel.failures.length === 0
    ) &&
    errors.length === 0;

  return { complete, channels, errors };
}

function isExtensionInstallApproval(approval: PendingApproval): boolean {
  return (
    approval.kind === "unit-batch" &&
    !!approval.units?.some((unit) => unit.unitKind === "extension")
  );
}

function isUnitBatchApproval(approval: PendingApproval): boolean {
  return approval.kind === "unit-batch";
}

function isElectronHostAppApproval(approval: PendingApproval): boolean {
  return (
    approval.kind === "unit-batch" &&
    !!approval.units?.some((unit) => unit.unitKind === "app" && unit.target === "electron")
  );
}

function isNonElectronHostAppApproval(approval: PendingApproval): boolean {
  return (
    approval.kind === "unit-batch" &&
    !!approval.units?.some((unit) => unit.unitKind === "app" && unit.target !== "electron")
  );
}

function describeApproval(approval: PendingApproval): string {
  const units = approval.units
    ?.map((unit) => `${unit.unitKind}:${unit.unitName}:${unit.target ?? "none"}`)
    .join(",");
  return `${approval.kind}:${approval.title ?? ""}:${units ?? ""}`;
}

function isOpenAiCredentialApproval(approval: PendingApproval): boolean {
  return approval.kind === "credential" && approval.credentialLabel === "ChatGPT Codex model credential";
}

test.describe("Desktop Startup Approvals", () => {
  test.setTimeout(360_000);

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

  test("launch gate starts shell, then in-app approvals unblock initial chats", async () => {
    workspaceDir = createManagedTestWorkspace();
    await seedOpenAiCodexCredential(workspaceDir);
    await makeWorkspaceExtensionRequireApproval(workspaceDir);

    testApp = await launchTestApp({
      workspace: workspaceDir,
      launchTimeout: 240_000,
    });

    let startupState: "approval" | "ready" | "waiting" = "waiting";
    try {
      await expect
        .poll(
          async () => {
            const pending = await listPendingApprovals(testApp!);
            if (pending.some(isElectronHostAppApproval) && (await shellHasApprovalUi(testApp!))) {
              startupState = "approval";
              return startupState;
            }
            if (await hostedShellHasChrome(testApp!)) {
              startupState = "ready";
              return startupState;
            }
            startupState = "waiting";
            return startupState;
          },
          { timeout: 90_000, intervals: [500, 1000, 2000] }
        )
        .not.toBe("waiting");
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    if (startupState === "approval") {
      expect(await clickShellButton(testApp, /^Approve and start$/)).toBe(true);
    }

    await expect
      .poll(
        async () =>
          (await listPendingApprovals(testApp!))
            .filter(isNonElectronHostAppApproval)
            .map(describeApproval),
        { timeout: 15_000, intervals: [500, 1000, 2000] }
      )
      .toEqual([]);

    for (const panel of await getPanelTree(testApp.app)) {
      await startPanelDiagnostics(testApp.app, panel.id).catch(() => {});
    }

    try {
      await expect
        .poll(
          async () => {
            const pending = await listPendingApprovals(testApp!);
            return (
              pending.some(isExtensionInstallApproval) && (await hostedShellHasApprovalUi(testApp!))
            );
          },
          { timeout: 60_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    await expect.poll(() => bootstrapLaunchGateHasCredentialApproval(testApp!), {
      timeout: 10_000,
      intervals: [500, 1000],
    }).toBe(false);

    const extensionDeadline = Date.now() + 90_000;
    while (Date.now() < extensionDeadline) {
      const pendingExtensionCount = (await listPendingApprovals(testApp)).filter(
        isExtensionInstallApproval
      ).length;
      if (pendingExtensionCount === 0) break;
      await expect
        .poll(
          async () =>
            clickShellButton(
              testApp!,
              /^(Approve and start|Approve all|Approve|Install and run|Run once|Allow for session)$/
            ),
          { timeout: 15_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await listPendingApprovals(testApp!)).filter(isExtensionInstallApproval).length,
          { timeout: 10_000, intervals: [500, 1000, 2000] }
        )
        .toBeLessThanOrEqual(pendingExtensionCount);
    }
    await expect
      .poll(
        async () => (await listPendingApprovals(testApp!)).filter(isExtensionInstallApproval).length,
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(0);

    const unitBatchDeadline = Date.now() + 90_000;
    while (Date.now() < unitBatchDeadline) {
      const pending = await listPendingApprovals(testApp);
      expect(pending.filter(isNonElectronHostAppApproval).map(describeApproval)).toEqual([]);
      const pendingUnitBatchCount = pending.filter(isUnitBatchApproval).length;
      if (pendingUnitBatchCount === 0) break;
      await expect
        .poll(
          async () =>
            clickShellButton(
              testApp!,
              /^(Approve and start|Approve all|Approve|Install and run|Run once|Allow for session|Dev session)$/
            ),
          { timeout: 15_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
      await expect
        .poll(
          async () => (await listPendingApprovals(testApp!)).filter(isUnitBatchApproval).length,
          { timeout: 10_000, intervals: [500, 1000, 2000] }
        )
        .toBeLessThanOrEqual(pendingUnitBatchCount);
    }
    await expect
      .poll(
        async () => (await listPendingApprovals(testApp!)).filter(isUnitBatchApproval).length,
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(0);

    try {
      await expect
        .poll(
          async () => {
            const pending = await listPendingApprovals(testApp!);
            return pending.filter(isOpenAiCredentialApproval).length;
          },
          { timeout: 60_000, intervals: [1000, 2000, 5000] }
        )
        .toBeGreaterThanOrEqual(1);
    } catch (error) {
      await attachStartupDiagnostics(testApp);
      throw error;
    }

    await expect.poll(() => hostedShellHasApprovalUi(testApp!), {
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    }).toBe(true);

    let approvedCredentialPrompts = 0;
    const drainDeadline = Date.now() + 90_000;
    while (Date.now() < drainDeadline) {
      const pending = await listPendingApprovals(testApp);
      const pendingUnitBatchCount = pending.filter(isUnitBatchApproval).length;
      const pendingCredentialCount = pending.filter(isOpenAiCredentialApproval).length;
      const pendingTargetCount = pendingUnitBatchCount + pendingCredentialCount;
      if (pendingTargetCount === 0) break;
      await expect
        .poll(
          async () =>
            clickShellButtonByPreference(testApp!, [
              /^Trust version$/,
              /^Use this session$/,
              /^Approve all$/,
              /^Dev session$/,
              /^Approve and start$/,
              /^Approve$/,
              /^Install and run$/,
              /^Run once$/,
              /^Allow for session$/,
              /^Use once$/,
            ]),
          { timeout: 15_000, intervals: [500, 1000, 2000] }
        )
        .toBe(true);
      let currentCredentialCount = pendingCredentialCount;
      await expect
        .poll(
          async () => {
            const next = await listPendingApprovals(testApp!);
            currentCredentialCount = next.filter(isOpenAiCredentialApproval).length;
            return (
              next.filter(isUnitBatchApproval).length +
              next.filter(isOpenAiCredentialApproval).length
            );
          },
          { timeout: 10_000, intervals: [500, 1000, 2000] }
        )
        .toBeLessThan(pendingTargetCount);
      approvedCredentialPrompts += Math.max(0, pendingCredentialCount - currentCredentialCount);
    }
    expect(approvedCredentialPrompts).toBeGreaterThanOrEqual(1);

    await expect
      .poll(
        async () => (await listPendingApprovals(testApp!)).filter(isUnitBatchApproval).length,
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(0);

    await expect
      .poll(
        async () => (await listPendingApprovals(testApp!)).filter(isOpenAiCredentialApproval).length,
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe(0);

    try {
      await expect
        .poll(async () => (await collectStartupAgentCompletion(testApp!)).complete, {
          timeout: 120_000,
          intervals: [1000, 2000, 5000],
        })
        .toBe(true);
    } catch (error) {
      console.log(
        "STARTUP_AGENT_COMPLETION_STATE",
        JSON.stringify(await collectStartupAgentCompletion(testApp!), null, 2)
      );
      await attachStartupDiagnostics(testApp);
      throw error;
    }
  });
});
