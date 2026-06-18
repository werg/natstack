/** Persisted per-agent record (mirrors InstalledAgentRecord in bootstrap.ts). */
export interface PersistedInstalledAgent {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  /** Per-agent subscription config (model/effort/etc.), excluding handle. */
  config?: Record<string, unknown>;
}

export interface ChatStateArgs {
  channelName: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  installedAgents?: PersistedInstalledAgent[];
  agentSource?: string;
  agentClass?: string;
  agentConfig?: Record<string, unknown>;
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (e.g. a fork). */
  forceInitialPrompt?: boolean;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  actionBarFile?: string | null;
  actionBarProps?: Record<string, unknown> | null;
  actionBarMaxHeight?: number | null;
}
