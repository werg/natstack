export interface ChatStateArgs {
  channelName: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  pendingAgents?: Array<{ agentId: string; handle: string }>;
  agentSource?: string;
  agentClass?: string;
  initialPrompt?: string;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  actionBarFile?: string | null;
  actionBarProps?: Record<string, unknown> | null;
  actionBarMaxHeight?: number | null;
}
