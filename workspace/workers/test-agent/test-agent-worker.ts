import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, ParticipantDescriptor } from "@natstack/harness/types";
import path from "node:path";
import {
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
} from "@workspace/agentic-protocol";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TestAgentWorker — Minimal agent DO for testing the Pi runtime pipeline.
 *
 * Uses the default `meta/AGENTS.md` system prompt resolved by the
 * base class via the workspace.* RPC service. Tests that need a
 * different prompt drop a per-test `AGENTS.md` file in the context
 * folder before spawning the worker.
 */
export class TestAgentWorker extends AgentWorkerBase {
  static override schemaVersion = 5;

  constructor(ctx: ConstructorParameters<typeof AgentWorkerBase>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Test Agent");
  }

  /** Anthropic sonnet — smaller surface for unit tests than OpenAI Codex. */
  protected override getDefaultModel(): string {
    return "anthropic:claude-sonnet-4-6";
  }

  protected override getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = config && typeof config === "object" ? config as Record<string, unknown> : {};
    const handle = typeof cfg["handle"] === "string" ? cfg["handle"] : "test-agent";
    return {
      handle,
      name: typeof cfg["name"] === "string" ? cfg["name"] : "Test Agent",
      type: "agent",
      metadata: {},
      methods: [],
    };
  }

  override async processChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    const config = this.subscriptions.getConfig(channelId);
    if (!config || config["deterministicResponse"] !== true) {
      await super.processChannelEvent(channelId, event);
      return;
    }
    if (!this.shouldProcess(event)) return;

    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`Not subscribed to channel ${channelId}`);

    const input = this.buildTurnInput(event);
    const channel = this.createChannelClient(channelId);
    const now = new Date().toISOString();
    const actor = {
      kind: "agent" as const,
      id: participantId,
      displayName: "Test Agent",
      metadata: { handle: config["handle"] ?? "test-agent" },
    };
    const invocationId = `deterministic-eval-${event.messageId || Date.now()}`;
    const messageId = `deterministic-message-${event.messageId || Date.now()}`;
    const code = typeof config["code"] === "string"
      ? config["code"]
      : `return ${JSON.stringify(input.content)}`;
    const responseText = typeof config["responseText"] === "string"
      ? config["responseText"]
      : `Deterministic response to: ${input.content}`;
    const delayMs = typeof config["delayMs"] === "number" ? config["delayMs"] : 250;
    await this.maybeWriteVaultSwitchMarker(config, input.content);

    const publish = async (agenticEvent: AgenticEvent, key: string) => {
      await channel.publishAgenticEvent(participantId, agenticEvent, {
        idempotencyKey: `test-agent:${channelId}:${event.messageId}:${key}`,
      });
    };

    await publish({
      kind: "invocation.started",
      actor,
      causality: { invocationId: invocationId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code },
        userVisible: true,
      },
      createdAt: now,
    }, "invocation-started");

    await delay(delayMs);

    await publish({
      kind: "invocation.output",
      actor,
      causality: { invocationId: invocationId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output: "deterministic eval output",
      },
      createdAt: new Date().toISOString(),
    }, "invocation-output");

    await delay(delayMs);

    await publish({
      kind: "invocation.completed",
      actor,
      causality: { invocationId: invocationId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          toolCallId: invocationId,
          toolName: "eval",
          details: { input: { code } },
          content: [{ type: "text", text: "deterministic eval result" }],
        },
      },
      createdAt: new Date().toISOString(),
    }, "invocation-completed");

    await publish({
      kind: "message.completed",
      actor,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: responseText,
      },
      createdAt: new Date().toISOString(),
    }, "message-completed");
  }

  private async maybeWriteVaultSwitchMarker(config: Record<string, unknown>, content: string): Promise<void> {
    if (config["writeVaultSwitchMarker"] !== true) return;
    const current = /Current vault:\s*`([^`]+)`/.exec(content)?.[1];
    if (!current) return;
    const currentDir = path.posix.normalize(current.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (!currentDir.startsWith("/projects/")) return;
    const markerPath = typeof config["markerPath"] === "string"
      ? config["markerPath"]
      : "AgentProof.mdx";
    const normalizedMarker = markerPath.replace(/^\/+/, "");
    if (normalizedMarker.includes("..")) return;
    const fullPath = path.posix.normalize(path.posix.join(currentDir, normalizedMarker));
    if (!fullPath.startsWith(`${currentDir}/`)) return;
    const title = normalizedMarker.replace(/\.mdx$/, "");
    await this.fs.writeFile(
      fullPath,
      [
        "---",
        `title: ${title}`,
        "---",
        "",
        `# ${title}`,
        "",
        `Deterministic agent wrote this in ${current}.`,
        "",
      ].join("\n"),
    );
  }
}
