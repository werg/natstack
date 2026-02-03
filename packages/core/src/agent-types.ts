/**
 * Agent Types - Core type definitions for agent manifests and instances.
 *
 * These types enable static declaration of agent metadata in package.json
 * and runtime tracking of agent instances.
 */

import type { FieldDefinition } from "./form-schema.js";

// =============================================================================
// Method Advertisement Types (for static declaration)
// =============================================================================

/**
 * Method advertisement - declares a method the agent exposes.
 * Used for method discovery and invocation.
 */
export interface MethodAdvertisement {
  /** Method name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** JSON Schema for return value */
  returns?: Record<string, unknown>;
  /** Whether this method supports streaming responses */
  streaming?: boolean;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Required method specification - declares a method the agent depends on.
 */
export interface RequiredMethodSpec {
  /** Exact method name (mutually exclusive with pattern) */
  name?: string;
  /** Glob pattern for method names (mutually exclusive with name) */
  pattern?: string;
  /** Description of why this method is needed */
  description?: string;
  /** If true, agent cannot function without this method */
  required: boolean;
}

// =============================================================================
// Agent Manifest (static metadata from package.json)
// =============================================================================

/**
 * Agent manifest - static metadata from package.json natstack section.
 * This enables static initialization of the agent registry without running code.
 *
 * Runtime state (enabled, sortOrder, timestamps) lives in AgentDefinition.
 */
export interface AgentManifest {
  // --- Identity ---
  /** Unique agent ID (derived from package name or directory) */
  id: string;
  /** Display name */
  name: string;
  /** Semver version */
  version: string;
  /** Optional title for UI (falls back to name) */
  title?: string;
  /** Description for UI */
  description?: string;
  /** Tags for filtering/search */
  tags?: string[];

  // --- Channel Configuration ---
  /** Channel patterns this agent can join (glob, e.g., "chat:*") */
  channels?: string[];
  /** Default handle when joining a channel (e.g., "claude", "codex") */
  proposedHandle?: string;
  /** If true, only one instance can run per channel */
  singleton?: boolean;

  // --- Parameters ---
  /** Configurable parameters (rendered as config UI) */
  parameters?: FieldDefinition[];

  // --- Method Declaration ---
  /** Methods this agent exposes for invocation by others */
  providesMethods?: MethodAdvertisement[];
  /** Methods this agent requires from other participants */
  requiresMethods?: RequiredMethodSpec[];

  // --- Capabilities & Permissions ---
  /**
   * Declared capabilities - what the agent can do.
   * Examples: "streaming", "tools", "images", "code-execution"
   */
  capabilities?: string[];
  /**
   * Required permissions - what system access the agent needs.
   * Examples: "filesystem", "network", "shell", "env-vars"
   */
  permissions?: string[];
}

/**
 * Base interface for agent state.
 * All agent state must be JSON-serializable.
 */
export interface AgentState {
  [key: string]: unknown;
}

/**
 * Running agent instance metadata (host-side tracking).
 */
export interface AgentInstanceInfo {
  /** Unique instance ID (UUID) */
  id: string;
  /** Agent type ID (matches AgentManifest.id) */
  agentId: string;
  /** Channel this instance is bound to */
  channel: string;
  /** Handle used in channel (e.g., "claude", "codex") */
  handle: string;
  /** Unix timestamp when started */
  startedAt: number;
}

// =============================================================================
// Agent Settings Types (for centralized settings management)
// =============================================================================

/** JSON-serializable value for SQLite storage */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Global settings that apply across all agent sessions */
export interface GlobalAgentSettings {
  defaultProjectLocation: "external" | "browser";
  defaultAutonomy: 0 | 1 | 2;
}

/** Per-agent default parameter values (JSON-serializable) */
export type AgentSettings = Record<string, JsonValue>;
