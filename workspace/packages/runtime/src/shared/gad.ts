import type { RpcCaller } from "@natstack/rpc";

export type GadSqlBinding = null | string | number | boolean | Uint8Array;
export type GadJsonRecord = Record<string, unknown>;

export interface GadSqlResult {
  rows: GadJsonRecord[];
}

export interface GadStatusMetric {
  metric: string;
  value: number;
}

export type GadTrajectoryKind =
  | "message_created"
  | "message_block_added"
  | "message_finalized"
  | "tool_call_requested"
  | "tool_result_observed"
  | "file_observed"
  | "file_read"
  | "file_mutation"
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

export interface GadTrajectoryItemSpec {
  kind: GadTrajectoryKind;
  actor?: string | null;
  payload?: GadJsonRecord | string | null;
  messageId?: string | null;
  blockId?: string | null;
  toolCallId?: string | null;
  inputStateHash?: string | null;
  outputStateHash?: string | null;
  metadata?: GadJsonRecord | null;
}

export interface GadEnsureBranchInput {
  workspaceId?: string | null;
  branchId: string;
  channelId?: string | null;
  contextId?: string | null;
  metadata?: GadJsonRecord | null;
}

export interface GadBranchHead {
  workspaceId: string;
  branchId: string;
  headTrajectoryId: number | null;
  headTrajectoryHash: string | null;
  headStateHash: string;
  dirty: boolean;
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
  headStateHash: string;
  items: Array<{ id: number; hash: string; inputStateHash: string | null; outputStateHash: string | null }>;
}

export interface GadIntegrityError {
  code: string;
  message: string;
  trajectoryId?: number;
  trajectoryHash?: string;
  branchId?: string;
  stateHash?: string;
  path?: string;
  toolCallId?: string;
}

export interface GadClient {
  rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  ensureGadBranch(input: GadEnsureBranchInput): Promise<GadBranchHead>;
  getGadBranchHead(input: { workspaceId?: string | null; branchId: string }): Promise<GadBranchHead>;
  appendGadTrajectoryBatch(input: GadAppendTrajectoryBatchInput): Promise<GadAppendTrajectoryBatchResult>;
  materializePiMessages(input: { workspaceId?: string | null; branchId: string }): Promise<{ messages: GadJsonRecord[] }>;
  listGadBranchTrajectory(input: { workspaceId?: string | null; branchId: string; limit?: number }): Promise<GadJsonRecord[]>;
  listGadBranchToolCalls(input: { workspaceId?: string | null; branchId: string; limit?: number }): Promise<GadJsonRecord[]>;
  forkGadBranch(input: {
    workspaceId?: string | null;
    sourceBranchId: string;
    newBranchId?: string | null;
    trajectoryHash?: string | null;
    trajectoryId?: number | null;
    channelId?: string | null;
    contextId?: string | null;
  }): Promise<GadBranchHead>;
  listGadBranches(input?: { workspaceId?: string | null }): Promise<GadJsonRecord[]>;
  listGadBranchFiles(input: { workspaceId?: string | null; branchId: string }): Promise<GadJsonRecord[]>;
  diffGadStates(input: { workspaceId?: string | null; leftStateHash: string; rightStateHash: string }): Promise<{
    added: GadJsonRecord[];
    removed: GadJsonRecord[];
    changed: GadJsonRecord[];
  }>;
  readGadFileAtState(input: { workspaceId?: string | null; stateHash: string; path: string }): Promise<GadJsonRecord | null>;
  getGadToolProvenance(input: { workspaceId?: string | null; branchId: string; toolCallId: string }): Promise<GadJsonRecord | null>;
  getGadStateProducer(input: { workspaceId?: string | null; stateHash: string; branchId?: string | null }): Promise<GadJsonRecord | null>;
  blameGadFileSnippet(input: {
    workspaceId?: string | null;
    stateHash?: string | null;
    fileVersionId?: number | null;
    path: string;
    startLine?: number | null;
    endLine?: number | null;
  }): Promise<GadJsonRecord[]>;
  enqueueGadIndexJob(input: { workspaceId?: string | null; sourceHash: string; sourceKind: string; jobKind: string }): Promise<{ id: number }>;
  processGadIndexJobs(input?: { workspaceId?: string | null; limit?: number }): Promise<{ processed: number }>;
  validateGadHashes(input?: { workspaceId?: string | null }): Promise<{ ok: boolean; errors: string[] }>;
  clearDirtyAfterValidation(input?: { workspaceId?: string | null }): Promise<{ ok: boolean; errors: string[] }>;
  checkGadIntegrity(input?: { workspaceId?: string | null; branchId?: string | null }): Promise<{ ok: boolean; errors: GadIntegrityError[] }>;
  revokeRawSqlWriteApproval(): Promise<boolean>;
}

export function createGadClient(rpc: RpcCaller): GadClient {
  return {
    rawSql: (sql, bindings) => rpc.call("main", "gad.rawSql", sql, bindings),
    query: (sql, bindings) => rpc.call("main", "gad.query", sql, bindings),
    status: () => rpc.call("main", "gad.status"),
    ensureBlob: (hash, size, mimeType) => rpc.call("main", "gad.ensureBlob", hash, size, mimeType),
    ensureGadBranch: (input) => rpc.call("main", "gad.ensureGadBranch", input),
    getGadBranchHead: (input) => rpc.call("main", "gad.getGadBranchHead", input),
    appendGadTrajectoryBatch: (input) => rpc.call("main", "gad.appendGadTrajectoryBatch", input),
    materializePiMessages: (input) => rpc.call("main", "gad.materializePiMessages", input),
    listGadBranchTrajectory: (input) => rpc.call("main", "gad.listGadBranchTrajectory", input),
    listGadBranchToolCalls: (input) => rpc.call("main", "gad.listGadBranchToolCalls", input),
    forkGadBranch: (input) => rpc.call("main", "gad.forkGadBranch", input),
    listGadBranches: (input) => rpc.call("main", "gad.listGadBranches", input),
    listGadBranchFiles: (input) => rpc.call("main", "gad.listGadBranchFiles", input),
    diffGadStates: (input) => rpc.call("main", "gad.diffGadStates", input),
    readGadFileAtState: (input) => rpc.call("main", "gad.readGadFileAtState", input),
    getGadToolProvenance: (input) => rpc.call("main", "gad.getGadToolProvenance", input),
    getGadStateProducer: (input) => rpc.call("main", "gad.getGadStateProducer", input),
    blameGadFileSnippet: (input) => rpc.call("main", "gad.blameGadFileSnippet", input),
    enqueueGadIndexJob: (input) => rpc.call("main", "gad.enqueueGadIndexJob", input),
    processGadIndexJobs: (input) => rpc.call("main", "gad.processGadIndexJobs", input),
    validateGadHashes: (input) => rpc.call("main", "gad.validateGadHashes", input),
    clearDirtyAfterValidation: (input) => rpc.call("main", "gad.clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => rpc.call("main", "gad.checkGadIntegrity", input),
    revokeRawSqlWriteApproval: () => rpc.call("main", "gad.revokeRawSqlWriteApproval"),
  };
}
