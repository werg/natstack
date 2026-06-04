import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";

type ChatAgentConfig = {
  handle?: string;
  name?: string;
  systemPrompt?: string;
  systemPromptMode?: "replace" | "append";
  respondPolicy?: "all" | "mentioned" | "mentioned-strict" | "from-participants";
  respondFrom?: string[];
};

function asChatAgentConfig(config: unknown): ChatAgentConfig {
  return config && typeof config === "object" ? (config as ChatAgentConfig) : {};
}

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Pi-native: embeds `@earendil-works/pi-agent-core`'s `Agent` in-process via
 * the `PiRunner` harness (see `AgentWorkerBase`). The system prompt is
 * loaded from `meta/AGENTS.md` via the workspace.* RPC service;
 * skill metadata is merged in from each skill's SKILL.md.
 *
 * The model, thinking level, and approval level can be customized via the
 * `getModel`/`getThinkingLevel`/`getApprovalLevel` overridable hooks. The
 * default is `openai-codex:gpt-5.5` at "medium" thinking with full-auto
 * approval. Model credentials are URL-bound and injected by the host egress
 * path after user approval.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  protected override getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return ["eval"];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = asChatAgentConfig(config);
    return {
      handle: cfg.handle ?? "ai-chat",
      name: cfg.name ?? "AI Chat",
      type: "agent",
      metadata: {},
      methods: this.getStandardAgentMethods(),
    };
  }
}
