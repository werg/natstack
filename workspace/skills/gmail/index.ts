import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { contextId as runtimeContextId, getStateArgs, rpc, setStateArgs } from "@workspace/runtime";

const GMAIL_AGENT_SOURCE = "workers/gmail-agent";
const GMAIL_AGENT_CLASS = "GmailAgentWorker";
const GMAIL_AGENT_HANDLE = "gmail";
const GMAIL_ACTION_BAR_FILE = "skills/gmail/action-bar.tsx";

const GMAIL_RENDERERS = [
  { typeId: "gmail.inbox", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-inbox.tsx" },
  { typeId: "gmail.category", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-category.tsx" },
  { typeId: "gmail.thread", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-thread.tsx" },
  { typeId: "gmail.compose", displayMode: "row" as const, path: "skills/gmail/renderers/gmail-compose.tsx" },
];

export interface GmailAgentSetupStatus {
  stage: "needs-google-workspace" | "needs-channel-setup" | "ready" | "error";
  message: string;
  google?: unknown;
}

interface SetupChatApi {
  publish?: (kind: string, payload: unknown, options?: { idempotencyKey?: string }) => Promise<unknown>;
}

interface PendingAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
}

interface GmailAgentSetupArgs {
  channelId?: string | null;
  contextId?: string | null;
  chat?: SetupChatApi | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function getGmailAgentSetupStatus(): Promise<GmailAgentSetupStatus> {
  try {
    const google = await import("@workspace-skills/google-workspace");
    const status = await google.getGoogleOnboardingStatus();
    if (status.stage === "needs-setup") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace OAuth setup is required before Gmail can connect.",
        google: status,
      };
    }
    if (status.stage === "ready-to-connect") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace is configured; connect the Gmail credential.",
        google: status,
      };
    }
    if (status.stage === "connected") {
      return {
        stage: "needs-google-workspace",
        message: "Google Workspace credential exists; verify it before Gmail setup.",
        google: status,
      };
    }
    if (status.stage === "verified") {
      const pendingAgents = (getStateArgs() as Record<string, unknown>)["pendingAgents"];
      const hasGmailAgent = Array.isArray(pendingAgents)
        && pendingAgents.some((agent) => record(agent)["handle"] === GMAIL_AGENT_HANDLE);
      return {
        stage: hasGmailAgent ? "ready" : "needs-channel-setup",
        message: hasGmailAgent
          ? "Gmail agent is registered for this workspace."
          : "Google Workspace is verified. Run Gmail agent setup in a channel.",
        google: status,
      };
    }
    return {
      stage: "error",
      message: "Google Workspace status is not ready for Gmail.",
      google: status,
    };
  } catch (error) {
    return {
      stage: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function connectGmail(): Promise<unknown> {
  const google = await import("@workspace-skills/google-workspace");
  return google.connectGoogle();
}

function setupActor(): AgenticEvent["actor"] {
  return {
    kind: "panel",
    id: "gmail-setup",
    displayName: "Gmail setup",
    metadata: { type: "panel", handle: "gmail-setup" },
  };
}

async function registerGmailRenderers(chat: SetupChatApi): Promise<string[]> {
  if (!chat.publish) return [];
  const registered: string[] = [];
  for (const renderer of GMAIL_RENDERERS) {
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: setupActor(),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: renderer.typeId,
        displayMode: renderer.displayMode,
        source: { type: "file", path: renderer.path },
        registeredBy: setupActor(),
      },
      createdAt: new Date().toISOString(),
    };
    await chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: `gmail:message-type:${renderer.typeId}`,
    });
    registered.push(renderer.typeId);
  }
  return registered;
}

function gmailAgentKey(channelId: string): string {
  return `gmail-${channelId}`;
}

function updatePendingAgents(existing: unknown, next: PendingAgentRecord): PendingAgentRecord[] {
  const current = Array.isArray(existing) ? existing as PendingAgentRecord[] : [];
  return [...current.filter((agent) => agent.handle !== next.handle), next];
}

export async function setupGmailAgent(args: GmailAgentSetupArgs = {}): Promise<{
  ok: boolean;
  channelId?: string;
  contextId?: string;
  targetId?: string;
  participantId?: string;
  actionBarFile: string;
  renderers: string[];
  registeredRenderers: string[];
}> {
  const channelId = args.channelId?.trim();
  const contextId = args.contextId?.trim() || runtimeContextId;
  if (!channelId) {
    throw new Error("setupGmailAgent requires channelId");
  }
  if (!contextId) {
    throw new Error("setupGmailAgent requires a runtime contextId");
  }

  const key = gmailAgentKey(channelId);
  const entity = await rpc.call<{ id: string; targetId: string }>("main", "runtime.createEntity", [{
    kind: "do",
    source: GMAIL_AGENT_SOURCE,
    className: GMAIL_AGENT_CLASS,
    key,
    contextId,
  }]);
  const subscription = await rpc.call<{ ok: boolean; participantId?: string }>(entity.targetId, "subscribeChannel", [{
    channelId,
    contextId,
    config: {
      handle: GMAIL_AGENT_HANDLE,
      name: "Gmail",
      approvalLevel: 2,
    },
  }]);

  const stateArgs = getStateArgs() as Record<string, unknown>;
  await setStateArgs({
    pendingAgents: updatePendingAgents(stateArgs["pendingAgents"], {
      agentId: GMAIL_AGENT_CLASS,
      handle: GMAIL_AGENT_HANDLE,
      key,
      source: GMAIL_AGENT_SOURCE,
      className: GMAIL_AGENT_CLASS,
    }),
    actionBarFile: GMAIL_ACTION_BAR_FILE,
    actionBarMaxHeight: 180,
  });

  const registeredRenderers = args.chat ? await registerGmailRenderers(args.chat) : [];
  return {
    ok: subscription.ok,
    channelId,
    contextId,
    targetId: entity.targetId,
    participantId: subscription.participantId,
    actionBarFile: GMAIL_ACTION_BAR_FILE,
    renderers: GMAIL_RENDERERS.map((renderer) => renderer.path),
    registeredRenderers,
  };
}
