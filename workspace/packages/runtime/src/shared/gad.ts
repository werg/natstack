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

export type PiEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export interface PiEntrySpec {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  payload: GadJsonRecord;
  preStateHash?: string | null;
  postStateHash?: string | null;
  actor?: string | null;
  metadata?: GadJsonRecord | null;
}

export interface GadEventSpec {
  eventId: string;
  kind: string;
  anchorKind?: string | null;
  anchorId?: string | null;
  payload: GadJsonRecord;
  metadata?: GadJsonRecord | null;
}

export interface PiBranchHead {
  branchId: string;
  headEntryId: string | null;
  headEntryHash: string | null;
  headStateHash: string;
}

export interface PiEntryRow {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  actor: string | null;
  entryHash: string;
  parentEntryHash: string | null;
  preStateHash: string;
  postStateHash: string;
  payload: GadJsonRecord;
  metadata: GadJsonRecord | null;
  createdAt: string;
}

export interface GadClient {
  rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  ensurePiBranch(input: { branchId: string; channelId?: string | null; metadata?: GadJsonRecord | null }): Promise<PiBranchHead>;
  getPiBranchHead(input: { branchId: string }): Promise<PiBranchHead>;
  appendPiEntryBatch(input: {
    branchId: string;
    expectedHeadEntryHash?: string | null;
    expectedStateHash?: string | null;
    items: PiEntrySpec[];
  }): Promise<PiBranchHead & { items: Array<{ entryId: string; entryHash: string; parentEntryId: string | null }> }>;
  appendGadEvents(input: { events: GadEventSpec[] }): Promise<{ eventIds: string[] }>;
  listGadEvents(input?: { anchorKind?: string | null; anchorId?: string | null; kind?: string | null; limit?: number | null }): Promise<GadJsonRecord[]>;
  setBranchHead(input: { branchId: string; entryId: string | null; expectedHeadEntryHash?: string | null }): Promise<PiBranchHead>;
  getEntryById(input: { entryId: string }): Promise<PiEntryRow | null>;
  getBranchPath(input: { branchId: string; throughEntryId?: string | null; raw?: boolean | null }): Promise<PiEntryRow[]>;
  findEntries(input: { branchId: string; entryType: PiEntryType; offset?: number | null; limit?: number | null; raw?: boolean | null }): Promise<PiEntryRow[]>;
  materializePiMessages(input: { branchId: string }): Promise<{ messages: GadJsonRecord[] }>;
  listGadBranchToolCalls(input: { branchId: string; limit?: number | null }): Promise<GadJsonRecord[]>;
  forkPiBranch(input: { sourceBranchId: string; newBranchId?: string | null; entryId?: string | null; stateHash?: string | null; channelId?: string | null }): Promise<PiBranchHead>;
  listPiBranches(input?: object): Promise<GadJsonRecord[]>;
  listGadBranchFiles(input: { branchId: string }): Promise<GadJsonRecord[]>;
  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): Promise<{ added: GadJsonRecord[]; removed: GadJsonRecord[]; changed: GadJsonRecord[] }>;
  readGadFileAtState(input: { stateHash: string; path: string }): Promise<GadJsonRecord | null>;
  getGadToolProvenance(input: { toolCallId: string }): Promise<GadJsonRecord | null>;
  getGadStateProducer(input: { stateHash: string }): Promise<GadJsonRecord | null>;
  blameGadFileSnippet(input: { stateHash?: string | null; fileVersionId?: number | null; path: string }): Promise<GadJsonRecord[]>;
  enqueueGadIndexJob(input: { sourceHash: string; sourceKind: string; jobKind: string }): Promise<{ id: number }>;
  processGadIndexJobs(input?: { limit?: number | null }): Promise<{ processed: number }>;
  claimGadIndexJobs(input?: { limit?: number | null }): Promise<GadJsonRecord[]>;
  completeGadIndexJob(input: { id: number }): Promise<GadJsonRecord>;
  failGadIndexJob(input: { id: number; error: string; retry?: boolean | null }): Promise<GadJsonRecord>;
  listGadIndexJobs(input?: { status?: string | null; limit?: number | null }): Promise<GadJsonRecord[]>;
  validateGadHashes(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  clearDirtyAfterValidation(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  checkGadIntegrity(input?: object): Promise<{ ok: boolean; errors: GadJsonRecord[] }>;
  replayGadEvents(input?: object): Promise<{ replayed: number }>;
}

export function createGadClient(rpc: RpcCaller): GadClient {
  return {
    rawSql: (sql, bindings) => rpc.call("main", "gad.rawSql", sql, bindings),
    query: (sql, bindings) => rpc.call("main", "gad.query", sql, bindings),
    status: () => rpc.call("main", "gad.status"),
    ensureBlob: (hash, size, mimeType) => rpc.call("main", "gad.ensureBlob", hash, size, mimeType),
    ensurePiBranch: (input) => rpc.call("main", "gad.ensurePiBranch", input),
    getPiBranchHead: (input) => rpc.call("main", "gad.getPiBranchHead", input),
    appendPiEntryBatch: (input) => rpc.call("main", "gad.appendPiEntryBatch", input),
    appendGadEvents: (input) => rpc.call("main", "gad.appendGadEvents", input),
    listGadEvents: (input) => rpc.call("main", "gad.listGadEvents", input),
    setBranchHead: (input) => rpc.call("main", "gad.setBranchHead", input),
    getEntryById: (input) => rpc.call("main", "gad.getEntryById", input),
    getBranchPath: (input) => rpc.call("main", "gad.getBranchPath", input),
    findEntries: (input) => rpc.call("main", "gad.findEntries", input),
    materializePiMessages: (input) => rpc.call("main", "gad.materializePiMessages", input),
    listGadBranchToolCalls: (input) => rpc.call("main", "gad.listGadBranchToolCalls", input),
    forkPiBranch: (input) => rpc.call("main", "gad.forkPiBranch", input),
    listPiBranches: (input) => rpc.call("main", "gad.listPiBranches", input),
    listGadBranchFiles: (input) => rpc.call("main", "gad.listGadBranchFiles", input),
    diffGadStates: (input) => rpc.call("main", "gad.diffGadStates", input),
    readGadFileAtState: (input) => rpc.call("main", "gad.readGadFileAtState", input),
    getGadToolProvenance: (input) => rpc.call("main", "gad.getGadToolProvenance", input),
    getGadStateProducer: (input) => rpc.call("main", "gad.getGadStateProducer", input),
    blameGadFileSnippet: (input) => rpc.call("main", "gad.blameGadFileSnippet", input),
    enqueueGadIndexJob: (input) => rpc.call("main", "gad.enqueueGadIndexJob", input),
    processGadIndexJobs: (input) => rpc.call("main", "gad.processGadIndexJobs", input),
    claimGadIndexJobs: (input) => rpc.call("main", "gad.claimGadIndexJobs", input),
    completeGadIndexJob: (input) => rpc.call("main", "gad.completeGadIndexJob", input),
    failGadIndexJob: (input) => rpc.call("main", "gad.failGadIndexJob", input),
    listGadIndexJobs: (input) => rpc.call("main", "gad.listGadIndexJobs", input),
    validateGadHashes: (input) => rpc.call("main", "gad.validateGadHashes", input),
    clearDirtyAfterValidation: (input) => rpc.call("main", "gad.clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => rpc.call("main", "gad.checkGadIntegrity", input),
    replayGadEvents: (input) => rpc.call("main", "gad.replayGadEvents", input),
  };
}
