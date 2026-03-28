/**
 * Headless channel helpers — create channels and subscribe DOs with headless defaults.
 */

import type { ChannelConfig } from "@natstack/pubsub";
import { HEADLESS_SYSTEM_PROMPT, HEADLESS_NO_EVAL_PROMPT } from "./prompts.js";

/** Recommended channel config for headless sessions: full-auto approval (level 2). */
export function getRecommendedChannelConfig(): Partial<ChannelConfig> {
  return {
    approvalLevel: 2,  // Full Auto
  };
}

/**
 * Recommended harness config for headless sessions.
 * Restricts tools based on whether eval is available (sandbox provided).
 * Replaces system prompt with headless-specific version.
 *
 * @param opts.systemPrompt - Override the default headless prompt
 * @param opts.hasEval - Whether eval is available (sandbox configured). Default: true.
 *   When false, toolAllowlist is ["set_title"] only and the prompt omits eval references.
 */
export function getRecommendedHarnessConfig(opts?: {
  systemPrompt?: string;
  hasEval?: boolean;
} | string): {
  toolAllowlist: string[];
  systemPrompt: string;
  systemPromptMode: "replace-natstack";
} {
  // Support legacy single-string arg (systemPrompt only)
  const normalizedOpts = typeof opts === "string" ? { systemPrompt: opts } : opts;
  const hasEval = normalizedOpts?.hasEval ?? true;

  return {
    toolAllowlist: hasEval ? ["eval", "set_title"] : ["set_title"],
    systemPrompt: normalizedOpts?.systemPrompt ?? (hasEval ? HEADLESS_SYSTEM_PROMPT : HEADLESS_NO_EVAL_PROMPT),
    systemPromptMode: "replace-natstack",
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
  /** Override system prompt (default: HEADLESS_SYSTEM_PROMPT) */
  systemPrompt?: string;
  /** Whether eval is available (sandbox configured). Default: true. */
  hasEval?: boolean;
  /**
   * When true, skip the restrictive headless system prompt and tool allowlist.
   * The agent gets the default NatStack chat prompt with all tools available.
   * Only full-auto approval is applied. Use this when the headless session
   * runs in a panel context where all capabilities (inline_ui, browser panels,
   * feedback, etc.) are actually available.
   */
  useDefaultPrompt?: boolean;
  /** Additional subscription config */
  extraConfig?: Record<string, unknown>;
}

/**
 * Subscribe a DO agent to a channel with headless defaults.
 *
 * Sets: full-auto approval, and optionally headless system prompt + tool allowlist.
 */
export async function subscribeHeadlessAgent(opts: SubscribeHeadlessAgentOptions): Promise<{ ok: boolean; participantId?: string }> {
  const channelConfig = getRecommendedChannelConfig();

  let subscriptionConfig: Record<string, unknown>;
  if (opts.useDefaultPrompt) {
    // Panel-hosted headless sessions: only set approval, keep default prompt + all tools
    subscriptionConfig = {
      ...channelConfig,
      ...opts.extraConfig,
    };
  } else {
    // Genuinely headless: restrictive prompt + limited tool allowlist
    const harnessConfig = getRecommendedHarnessConfig({ systemPrompt: opts.systemPrompt, hasEval: opts.hasEval });
    subscriptionConfig = {
      ...harnessConfig,
      ...channelConfig,
      ...opts.extraConfig,
    };
  }

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
