import type { ChannelMessage } from "./messages";

/**
 * Participant type identifiers.
 * Extensible for future multi-user/multi-agent scenarios.
 */
export type ParticipantType = "user" | "agent" | "kernel" | "system";

/**
 * Capabilities a participant can declare.
 */
export interface ParticipantCapabilities {
  canSendText: boolean;
  canSendCode: boolean;
  canExecuteCode: boolean;
  canCallTools: boolean;
  canUploadFiles: boolean;
  canAbort: boolean;
}

/**
 * Base participant interface.
 * Designed for extension to multi-user scenarios.
 */
export interface Participant {
  id: string;
  type: ParticipantType;
  displayName: string;
  capabilities: ParticipantCapabilities;
  /** Avatar URL or emoji identifier */
  avatar?: string;
  /** Additional metadata (model info, session ID, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * User participant with UI-specific config.
 */
export interface UserParticipant extends Participant {
  type: "user";
  submitKeyConfig: SubmitKeyConfig;
}

/**
 * Agent participant with AI model info.
 */
export interface AgentParticipant extends Participant {
  type: "agent";
  modelRole: string;
  modelId?: string;
  systemPrompt?: string;
}

/**
 * Kernel participant with session info.
 */
export interface KernelParticipant extends Participant {
  type: "kernel";
  sessionId: string;
  isReady: boolean;
  executionCount: number;
}

/**
 * System participant for notifications.
 */
export interface SystemParticipant extends Participant {
  type: "system";
}

/**
 * Union of all participant types.
 */
export type AnyParticipant =
  | UserParticipant
  | AgentParticipant
  | KernelParticipant
  | SystemParticipant;

/**
 * Submit key configuration for user input.
 */
export interface SubmitKeyConfig {
  submitKey: "Enter" | "Shift+Enter" | "Ctrl+Enter" | "Cmd+Enter";
  enterBehavior: "submit" | "newline";
}

/**
 * Channel status states.
 */
export type ChannelStatus =
  | "idle"
  | "user_typing"
  | "agent_thinking"
  | "agent_streaming"
  | "kernel_executing"
  | "error";

/**
 * Channel state - the full state of a conversation channel.
 */
export interface ChannelState {
  id: string;
  participants: Map<string, AnyParticipant>;
  messages: ChannelMessage[];
  status: ChannelStatus;
  /** Pending messages in queue */
  pendingQueue: ChannelMessage[];
  /** Currently generating participant (for abort) */
  activeParticipantId: string | null;
  /** Abort controller for current generation */
  abortController: AbortController | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Serializable version of ChannelState for storage.
 */
export interface SerializableChannelState {
  id: string;
  participants: Array<[string, AnyParticipant]>;
  messages: ChannelMessage[];
  status: ChannelStatus;
  pendingQueue: ChannelMessage[];
  activeParticipantId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Default capabilities for each participant type.
 */
export const DEFAULT_CAPABILITIES: Record<ParticipantType, ParticipantCapabilities> = {
  user: {
    canSendText: true,
    canSendCode: true,
    canExecuteCode: false,
    canCallTools: false,
    canUploadFiles: true,
    canAbort: true,
  },
  agent: {
    canSendText: true,
    canSendCode: true,
    canExecuteCode: false,
    canCallTools: true,
    canUploadFiles: false,
    canAbort: false,
  },
  kernel: {
    canSendText: false,
    canSendCode: false,
    canExecuteCode: true,
    canCallTools: false,
    canUploadFiles: false,
    canAbort: false,
  },
  system: {
    canSendText: true,
    canSendCode: false,
    canExecuteCode: false,
    canCallTools: false,
    canUploadFiles: false,
    canAbort: false,
  },
};

/**
 * Create a user participant with default capabilities.
 */
export function createUserParticipant(
  id: string,
  displayName: string,
  config?: Partial<SubmitKeyConfig>
): UserParticipant {
  return {
    id,
    type: "user",
    displayName,
    capabilities: DEFAULT_CAPABILITIES.user,
    submitKeyConfig: {
      submitKey: "Enter",
      enterBehavior: "submit",
      ...config,
    },
  };
}

/**
 * Create an agent participant with default capabilities.
 */
export function createAgentParticipant(
  id: string,
  displayName: string,
  modelRole: string
): AgentParticipant {
  return {
    id,
    type: "agent",
    displayName,
    capabilities: DEFAULT_CAPABILITIES.agent,
    modelRole,
  };
}

/**
 * Create a kernel participant with default capabilities.
 */
export function createKernelParticipant(
  id: string,
  displayName: string,
  sessionId: string
): KernelParticipant {
  return {
    id,
    type: "kernel",
    displayName,
    capabilities: DEFAULT_CAPABILITIES.kernel,
    sessionId,
    isReady: false,
    executionCount: 0,
  };
}

/**
 * Create a system participant.
 */
export function createSystemParticipant(id: string): SystemParticipant {
  return {
    id,
    type: "system",
    displayName: "System",
    capabilities: DEFAULT_CAPABILITIES.system,
  };
}
