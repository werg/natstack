/**
 * @workspace/agentic-core — Headless-safe types
 *
 * All types here are free of React, browser, and UI dependencies.
 * The React adapter (@workspace/agentic-chat) re-exports these and adds
 * its own UI-specific types on top.
 *
 * Pi (`@earendil-works/pi-agent-core`) owns the agent message shape now.
 * `AgentMessage` is re-exported from `index.ts` for downstream consumers.
 */

import type { MethodDefinition } from "@workspace/pubsub";
import type { RecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { ScopesApi } from "@workspace/eval";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";
import type { ChatMethodResult } from "./invocation-result.js";

// The canonical participant metadata shape lives in @workspace/pubsub so that
// lower-level packages (like @workspace/agentic-do, which can't depend on
// agentic-core) and higher-level chat consumers see exactly the same type.
export type { ChatParticipantMetadata } from "@workspace/pubsub";

// ===========================================================================
// Injection Interfaces
// ===========================================================================

/** Inject connection config instead of importing from runtime */
export interface ConnectionConfig {
  clientId: string;
  rpc: {
    call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
    onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void;
    selfId: string;
  };
  protocol?: string;
  recoveryCoordinator?: Pick<RecoveryCoordinator, "registerColdRecoverHandler">;
}

/** Inject platform-specific navigation */
export interface AgenticChatActions {
  onNewConversation?: () => void;
  onAddAgent?: (channelName: string, contextId?: string, agentId?: string) => Promise<{ agentId: string; handle: string } | void>;
  onRemoveAgent?: (channelName: string, handle: string) => Promise<void>;
  availableAgents?: Array<{ id: string; name: string; proposedHandle: string }>;
  onFocusPanel?: (panelId: string) => void;
  onReloadPanel?: (panelId: string) => Promise<void>;
  onBecomeVisible?: () => void;
}

/** Chat API exposed to sandboxed code (eval, inline_ui, action bars, feedback_custom) */
export interface ChatSandboxValue {
  publish: (eventType: string, payload: unknown, options?: { idempotencyKey?: string }) => Promise<unknown>;
  /** Call a participant method and resolve to the provider's result payload. */
  callMethod: (participantId: string, method: string, args: unknown) => Promise<unknown>;
  /** Call a participant method and resolve to the full invocation result envelope. */
  callMethodResult: (participantId: string, method: string, args: unknown) => Promise<ChatMethodResult>;
  contextId: string;
  channelId: string | null;
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
}

/** Sandbox config injected by the panel (keeps agentic-chat runtime-agnostic) */
export interface SandboxConfig {
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
  loadImport: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
}

/** Dependencies provided to the tool provider factory */
export interface ToolProviderDeps {
  clientRef: { current: { publish: (eventType: string, payload: unknown) => void } | null };
  contextId: string;
  executeSandbox: (code: string, options: SandboxOptions) => Promise<SandboxResult>;
  chat: ChatSandboxValue;
  scope: Record<string, unknown>;
  scopes: ScopesApi;
}

/** Inject tools at connect time */
export type ToolProvider = (deps: ToolProviderDeps) => Record<string, MethodDefinition>;
