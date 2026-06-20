/**
 * Chat-panel agent lifecycle helpers that drive the runtime over RPC. Extracted
 * from the panel component so they're unit-testable with a mocked `@workspace/runtime`
 * rpc (the panel-rpc harness), independent of the React/UI surface.
 */
import { rpc } from "@workspace/runtime";
import { toSubscriptionConfig } from "@workspace/agentic-core";

/**
 * Create the agent DO entity (or reactivate it), then subscribe it to the channel.
 *
 * Agent behavior config is PER-AGENT: model/thinkingLevel/approvalLevel/respondPolicy/
 * etc. ride the entity's creation `stateArgs.agentConfig` (the vessel seeds its
 * per-agent settings record from `STATE_ARGS.agentConfig`). The subscription gets
 * `toSubscriptionConfig(config)` — presentation (handle/name/systemPrompt) + any
 * worker-specific extras, with the behavior settings stripped (they'd be inert,
 * and the subscription type forbids them).
 */
export async function createAndSubscribeAgent(args: {
  source: string;
  className: string;
  key: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
  replay?: boolean;
}): Promise<{ ok: boolean; participantId?: string }> {
  if (!args.channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
  const handle = await rpc.call<{ targetId: string }>("main", "runtime.createEntity", [
    {
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
      contextId: args.channelContextId,
      stateArgs: { agentConfig: args.config },
    },
  ]);
  return rpc.call<{ ok: boolean; participantId?: string }>(handle.targetId, "subscribeChannel", [
    {
      channelId: args.channelId,
      contextId: args.channelContextId,
      config: toSubscriptionConfig(args.config),
      replay: args.replay,
    },
  ]);
}
