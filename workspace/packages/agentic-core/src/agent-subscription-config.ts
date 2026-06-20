export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high";
export type AgentApprovalLevel = 0 | 1 | 2;
export type AgentRespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";
export type AgentSystemPromptMode = "append" | "replace" | "replace-natstack";

/**
 * The per-agent BEHAVIOR settings. These are PER-AGENT: seeded into the agent's
 * creation `stateArgs.agentConfig` and persisted in its settings record. They must
 * NEVER ride a channel subscription — a channel subscription is membership +
 * presentation, not behavior (an agent carries the same behavior across channels).
 */
export interface AgentConfig {
  /** Model in "provider:modelId" form. */
  model?: string;
  /** Effort level for the model. */
  thinkingLevel?: AgentThinkingLevel;
  /** 0=manual, 1=auto-safe, 2=full-auto. */
  approvalLevel?: AgentApprovalLevel;
  /** Chattiness: who the agent responds to. */
  respondPolicy?: AgentRespondPolicy;
  respondFrom?: string[];
  /** Optional cap for model rounds in one turn. Null/undefined means unlimited. */
  maxModelCallsPerTurn?: number | null;
  /** Idle window (ms) before a stalled model stream is abandoned. */
  modelStreamIdleTimeoutMs?: number | null;
}

/**
 * The behavior-setting keys — the single source of truth for stripping settings
 * off a subscription (`toSubscriptionConfig`) and for the `never` guard below.
 */
export const AGENT_SETTING_KEYS = [
  "model",
  "thinkingLevel",
  "approvalLevel",
  "respondPolicy",
  "respondFrom",
  "maxModelCallsPerTurn",
  "modelStreamIdleTimeoutMs",
] as const satisfies ReadonlyArray<keyof AgentConfig>;
export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];

/**
 * The full per-agent SETUP config: behavior settings + channel presentation +
 * worker-specific extras. Produced by the panel UI, a worker manifest's
 * `defaultConfig`, or headless `extraConfig`. It is the source for BOTH the
 * per-agent seed (the settings) AND the channel subscription (presentation +
 * extras, settings stripped via `toSubscriptionConfig`).
 */
export interface AgentSubscriptionConfig extends AgentConfig {
  /** Override or append to the workspace system prompt (channel presentation). */
  systemPrompt?: string;
  systemPromptMode?: AgentSystemPromptMode;
  /** Participant handle + display name (channel presentation). */
  handle?: string;
  name?: string;
  /** Worker-specific extras (e.g. the test-agent's deterministic-mode keys). */
  [key: string]: unknown;
}

/**
 * The CHANNEL SUBSCRIPTION config: presentation + worker extras, with the
 * per-agent behavior settings FORBIDDEN at the type level (`?: never`). Typing the
 * subscription store/read paths as this makes the compiler reject any attempt to
 * put — or read — a behavior setting on a subscription. Build one ONLY via
 * `toSubscriptionConfig` (the single sanctioned producer).
 */
export type ChannelSubscriptionConfig = AgentSubscriptionConfig & {
  [K in AgentSettingKey]?: never;
};

/**
 * Derive a channel subscription from a setup config: strip the per-agent behavior
 * settings, PRESERVING channel presentation (handle/name/systemPrompt) AND
 * worker-specific extras (e.g. the test-agent's `deterministicResponse`/`code`).
 * The only sanctioned way to produce a `ChannelSubscriptionConfig`.
 */
export function toSubscriptionConfig(
  config: AgentSubscriptionConfig | Record<string, unknown> | undefined
): ChannelSubscriptionConfig {
  const settings = new Set<string>(AGENT_SETTING_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!settings.has(key)) out[key] = value;
  }
  return out as ChannelSubscriptionConfig;
}
