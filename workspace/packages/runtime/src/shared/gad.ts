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

export type GadHistoryKind =
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
  | "system_event";

export interface GadHistoryItemSpec {
  kind: GadHistoryKind;
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
  headHistoryId: number | null;
  headHistoryHash: string | null;
  headStateHash: string;
  dirty: boolean;
}

export interface GadAppendHistoryBatchInput {
  workspaceId?: string | null;
  branchId: string;
  expectedHeadHash?: string | null;
  expectedStateHash?: string | null;
  items: GadHistoryItemSpec[];
}

export interface GadAppendHistoryBatchResult {
  workspaceId: string;
  branchId: string;
  headHistoryId: number | null;
  headHistoryHash: string | null;
  headStateHash: string;
  items: Array<{ id: number; hash: string; inputStateHash: string; outputStateHash: string }>;
}

export interface GadClient {
  rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  ensureGadBranch(input: GadEnsureBranchInput): Promise<GadBranchHead>;
  getGadBranchHead(input: { workspaceId?: string | null; branchId: string }): Promise<GadBranchHead>;
  appendGadHistoryBatch(input: GadAppendHistoryBatchInput): Promise<GadAppendHistoryBatchResult>;
  materializePiMessages(input: { workspaceId?: string | null; branchId: string }): Promise<{ messages: GadJsonRecord[] }>;
  listGadBranchHistory(input: { workspaceId?: string | null; branchId: string; limit?: number }): Promise<GadJsonRecord[]>;
  listGadBranchToolCalls(input: { workspaceId?: string | null; branchId: string; limit?: number }): Promise<GadJsonRecord[]>;
  forkGadBranch(input: {
    workspaceId?: string | null;
    sourceBranchId: string;
    newBranchId?: string | null;
    historyHash?: string | null;
    historyId?: number | null;
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
  enqueueGadIndexJob(input: { workspaceId?: string | null; sourceHash: string; sourceKind: string; jobKind: string }): Promise<{ id: number }>;
  processGadIndexJobs(input?: { workspaceId?: string | null; limit?: number }): Promise<{ processed: number }>;
  rebuildGadReadModels(input: { workspaceId?: string | null; branchId: string }): Promise<{ messages: number }>;
  validateGadHashes(input?: { workspaceId?: string | null }): Promise<{ ok: boolean; errors: string[] }>;
  clearDirtyAfterValidation(input?: { workspaceId?: string | null }): Promise<{ ok: boolean; errors: string[] }>;
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
    appendGadHistoryBatch: (input) => rpc.call("main", "gad.appendGadHistoryBatch", input),
    materializePiMessages: (input) => rpc.call("main", "gad.materializePiMessages", input),
    listGadBranchHistory: (input) => rpc.call("main", "gad.listGadBranchHistory", input),
    listGadBranchToolCalls: (input) => rpc.call("main", "gad.listGadBranchToolCalls", input),
    forkGadBranch: (input) => rpc.call("main", "gad.forkGadBranch", input),
    listGadBranches: (input) => rpc.call("main", "gad.listGadBranches", input),
    listGadBranchFiles: (input) => rpc.call("main", "gad.listGadBranchFiles", input),
    diffGadStates: (input) => rpc.call("main", "gad.diffGadStates", input),
    readGadFileAtState: (input) => rpc.call("main", "gad.readGadFileAtState", input),
    getGadToolProvenance: (input) => rpc.call("main", "gad.getGadToolProvenance", input),
    enqueueGadIndexJob: (input) => rpc.call("main", "gad.enqueueGadIndexJob", input),
    processGadIndexJobs: (input) => rpc.call("main", "gad.processGadIndexJobs", input),
    rebuildGadReadModels: (input) => rpc.call("main", "gad.rebuildGadReadModels", input),
    validateGadHashes: (input) => rpc.call("main", "gad.validateGadHashes", input),
    clearDirtyAfterValidation: (input) => rpc.call("main", "gad.clearDirtyAfterValidation", input),
    revokeRawSqlWriteApproval: () => rpc.call("main", "gad.revokeRawSqlWriteApproval"),
  };
}
