import type { WorkspaceAppTarget } from "./unitManifest.js";

export type HostTarget = WorkspaceAppTarget;
export type HostTargetSelectionMode = "follow-ref" | "pinned-build" | "pinned-commit";

export interface HostTargetSelection {
  workspaceId: string;
  target: HostTarget;
  source: string;
  appId: string;
  mode: HostTargetSelectionMode;
  ref?: string;
  buildKey?: string;
  commit?: string;
  updatedAt: number;
  autoSelected?: boolean;
}

export interface HostTargetSelectionInput {
  source: string;
  mode?: HostTargetSelectionMode;
  ref?: string;
  buildKey?: string;
  commit?: string;
  autoSelected?: boolean;
}

export interface HostTargetCompatibility {
  selectable: boolean;
  reasons: string[];
  recommended: boolean;
}

export interface HostTargetCandidate {
  name: string;
  source: string;
  displayName?: string;
  target: HostTarget;
  declared: boolean;
  enabled?: boolean;
  status:
    | "not-built"
    | "pending-approval"
    | "building"
    | "available"
    | "running"
    | "stopped"
    | "error";
  activeEv?: string | null;
  activeBundleKey?: string | null;
  capabilities: string[];
  canRollback: boolean;
  previousVersions: unknown[];
  lastError?: string | null;
  lastErrorDetails?: unknown;
  compatibility: HostTargetCompatibility;
}
