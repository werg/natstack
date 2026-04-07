/**
 * Headless channel helpers — create channels and subscribe DOs with headless defaults.
 *
 * "Headless" here means "no chat panel attached" — the same agent worker, prompt,
 * and tool surface as the panel-hosted path. The only thing this layer adds is
 * full-auto approval (since there's no user to approve tool calls interactively).
 * UI-only tools (inline_ui, feedback_form, etc.) are filtered out naturally
 * because no panel is connected to advertise them.
 */

import type { ChannelConfig } from "@natstack/pubsub";

/** Recommended channel config for headless sessions: full-auto approval (level 2). */
export function getRecommendedChannelConfig(): Partial<ChannelConfig> {
  return {
    approvalLevel: 2,  // Full Auto
  };
}

export interface SubscribeHeadlessAgentOptions {
  /** RPC call function for reaching the platform */
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  /** Worker source (e.g., "workers/agent-worker") */
  source: string;
  /** DO class name (e.g., "AiChatWorker") */
  className: string;
  /** DO object key (unique per instance) */
  objectKey: string;
  /** Channel ID to subscribe to */
  channelId: string;
  /** Context ID for authorization */
  contextId: string;
  /**
   * Optional system prompt to layer on top of the worker's default prompt.
   * By default this APPENDS to the worker's NatStack prompt — to replace it
   * entirely, also pass `systemPromptMode: "replace-natstack"` (or "replace")
   * via `extraConfig`.
   */
  systemPrompt?: string;
  /** Additional subscription config (e.g., model, temperature, systemPromptMode) */
  extraConfig?: Record<string, unknown>;
}

/**
 * Subscribe a DO agent to a channel with headless defaults.
 *
 * Sets full-auto approval on the channel and forwards any extra subscription
 * config to the worker. The worker uses the same harness config and system
 * prompt as it does for panel-hosted sessions; only the runtime environment
 * differs (no panel → no UI tools advertised → naturally absent from discovery).
 */
export async function subscribeHeadlessAgent(opts: SubscribeHeadlessAgentOptions): Promise<{ ok: boolean; participantId?: string }> {
  const channelConfig = getRecommendedChannelConfig();

  const subscriptionConfig: Record<string, unknown> = {
    ...channelConfig,
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...opts.extraConfig,
  };

  return opts.rpcCall(
    "main",
    "workers.callDO",
    opts.source,
    opts.className,
    opts.objectKey,
    "subscribeChannel",
    {
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: subscriptionConfig,
    },
  ) as Promise<{ ok: boolean; participantId?: string }>;
}
