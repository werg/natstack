/**
 * Types for personality agent manifests and instances.
 */

/** Agent personality manifest — parsed from agent.yml files. */
export interface AgentManifest {
  /** Display name */
  name: string;
  /** @-mention handle (unique identifier) */
  handle: string;
  /** System prompt — the agent's "SOUL". Inline text or file reference. */
  personality: string;
  /** How personality layers with base prompt. Default: "replace-natstack" */
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  /** Model role (e.g., "smart", "fast") or specific model ID */
  model?: string;
  /** Sampling temperature */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Tool allowlist. Default: ["eval", "set_title"] */
  tools?: string[];
  /** Proactive greeting on channel join */
  greeting?: string;
  /** Persistent memory configuration */
  memory?: {
    enabled?: boolean;
    categories?: string[];
  };
}

/** A spawned agent instance. */
export interface AgentInstance {
  /** @-mention handle */
  handle: string;
  /** Display name */
  name: string;
  /** DO object key */
  objectKey: string;
  /** Worker source path */
  source: string;
  /** DO class name */
  className: string;
  /** Channels this agent is subscribed to */
  channels: string[];
  /** The manifest this agent was spawned from */
  manifest: AgentManifest;
}
