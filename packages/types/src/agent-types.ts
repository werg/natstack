/**
 * Agent Types - Core type definitions for agent manifests and instances.
 */

import type { FieldDefinition } from "./form-schema.js";

// =============================================================================
// Method Advertisement Types
// =============================================================================

export interface MethodAdvertisement {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  returns?: Record<string, unknown>;
  streaming?: boolean;
  timeout?: number;
}

export interface RequiredMethodSpec {
  name?: string;
  pattern?: string;
  description?: string;
  required: boolean;
}

// =============================================================================
// Agent Manifest
// =============================================================================

export interface AgentManifest {
  // --- Identity ---
  id: string;
  name: string;
  version: string;
  title?: string;
  description?: string;
  tags?: string[];

  // --- Channel Configuration ---
  channels?: string[];
  proposedHandle?: string;
  singleton?: boolean;

  // --- Parameters ---
  parameters?: FieldDefinition[];

  // --- Method Declaration ---
  providesMethods?: MethodAdvertisement[];
  requiresMethods?: RequiredMethodSpec[];

  // --- Capabilities & Permissions ---
  capabilities?: string[];
  permissions?: string[];
}

export interface AgentState {
  [key: string]: unknown;
}

export interface AgentInstanceInfo {
  id: string;
  agentId: string;
  channel: string;
  handle: string;
  startedAt: number;
}

// =============================================================================
// Agent Settings Types
// =============================================================================

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GlobalAgentSettings {
  defaultProjectLocation: "external" | "browser";
  defaultAutonomy: 0 | 1 | 2;
}

export type AgentSettings = Record<string, JsonValue>;
