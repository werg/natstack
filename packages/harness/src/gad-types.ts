/**
 * Gad envelope type definitions used by the harness package.
 *
 * These mirror the canonical contract in
 * `workspace/packages/runtime/src/shared/gad.ts`. They live here instead of
 * being imported from the workspace runtime because `@natstack/harness` must
 * remain free of workspace-runtime dependencies (the workspace runtime
 * imports the harness, not the other way round).
 */

export type GadJsonRecord = Record<string, unknown>;

export type GadTranscriptEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info"
  | "leaf";

export type GadProvenanceEntryType =
  | "message_block"
  | "tool_call_requested"
  | "tool_result_observed"
  | "file_observed"
  | "file_read"
  | "file_mutation_intent"
  | "file_mutation_observed"
  | "workspace_observed"
  | "approval_requested"
  | "approval_resolved"
  | "dispatch_abandoned"
  | "branch_created"
  | "snapshot_marked"
  | "claim_asserted"
  | "claim_revised"
  | "contradiction_detected"
  | "theory_updated"
  | "system_event";

export type GadEntryType = GadTranscriptEntryType | GadProvenanceEntryType;

export interface GadTrajectoryItemSpec {
  entryId: string;
  parentEntryId: string | null;
  entryType: GadEntryType;
  payload: GadJsonRecord;
  actor?: string | null;
  metadata?: GadJsonRecord | null;
}

export interface GadBranchHead {
  workspaceId: string;
  branchId: string;
  headTrajectoryId: number | null;
  headTrajectoryHash: string | null;
  headEntryId: string | null;
  headStateHash: string;
  dirty: boolean;
}

export interface GadEntryRow {
  trajectoryId: number;
  trajectoryHash: string;
  entryId: string;
  parentEntryId: string | null;
  entryType: GadEntryType;
  actor: string | null;
  payload: GadJsonRecord;
  metadata: GadJsonRecord | null;
  createdAt: string;
}

export interface GadAppendTrajectoryBatchInput {
  workspaceId?: string | null;
  branchId: string;
  expectedTrajectoryHash?: string | null;
  expectedStateHash?: string | null;
  items: GadTrajectoryItemSpec[];
}

export interface GadAppendTrajectoryBatchResult {
  workspaceId: string;
  branchId: string;
  headTrajectoryId: number | null;
  headTrajectoryHash: string | null;
  headEntryId: string | null;
  headStateHash: string;
  items: Array<{
    id: number;
    hash: string;
    entryId: string;
    parentEntryId: string | null;
  }>;
}
