import { AiChatWorker } from "@workspace-workers/agent-worker";
import type { HarnessConfig, ParticipantDescriptor } from "@natstack/harness/types";

/**
 * PersonalityAgentWorker — Generic config-driven agent.
 *
 * Derives its entire identity (name, handle, personality, model, tools)
 * from subscription config rather than hardcoding it in TypeScript.
 * Extends AiChatWorker to inherit all event handling, crash recovery,
 * approval flow, and turn queuing.
 *
 * Used by the agents skill to spawn personality agents from YAML manifests.
 */
export class PersonalityAgentWorker extends AiChatWorker {
  static override schemaVersion = 3;

  // Minimal base — personality comes entirely from subscription config
  protected override getHarnessConfig(): HarnessConfig {
    return {
      toolAllowlist: ["eval", "set_title"],
    };
  }

  // Identity from subscription config
  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "personality-agent",
      name: (cfg?.["name"] as string) ?? "AI Agent",
      type: "agent",
      metadata: { personality: cfg?.["personality"] as string },
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
        {
          name: "remember",
          description: "Store a fact in persistent memory",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
              category: { type: "string" },
            },
            required: ["key", "value"],
          },
        },
        {
          name: "recall",
          description: "Retrieve a fact from memory",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        },
        {
          name: "search_memory",
          description: "Search persistent memory",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              category: { type: "string" },
              limit: { type: "number" },
            },
            required: ["query"],
          },
        },
        {
          name: "forget",
          description: "Delete a memory entry",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        },
      ],
    };
  }

  // Greeting support on first subscribe
  override async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    const cfg = opts.config as Record<string, unknown> | undefined;
    const greeting = cfg?.["greeting"] as string | undefined;
    if (greeting && result.ok) {
      await this.startProactiveTurn(opts.channelId, greeting);
    }
    return result;
  }

  // Memory method dispatch
  override async onMethodCall(
    channelId: string,
    callId: string,
    methodName: string,
    args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
    const a = args as Record<string, unknown>;
    switch (methodName) {
      case "remember": {
        this.memory.remember(
          a["key"] as string,
          a["value"] as string,
          a["category"] as string | undefined,
        );
        return { result: { stored: true } };
      }
      case "recall": {
        return { result: this.memory.recall(a["key"] as string) };
      }
      case "search_memory": {
        return {
          result: this.memory.search(
            a["query"] as string,
            a["category"] as string | undefined,
            a["limit"] as number | undefined,
          ),
        };
      }
      case "forget": {
        return { result: { deleted: this.memory.forget(a["key"] as string) } };
      }
      default:
        return super.onMethodCall(channelId, callId, methodName, args);
    }
  }
}
