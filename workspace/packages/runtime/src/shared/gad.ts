import type { RpcCaller } from "@natstack/rpc";
import { createGadServiceClient } from "@natstack/shared/userlandServiceRpc";
import type { AgenticEvent, ChannelEnvelope, TrajectoryEvent } from "@workspace/agentic-protocol";

export { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@natstack/shared/userlandServiceRpc";

export type GadSqlBinding = null | string | number | boolean | Uint8Array;
export type GadJsonRecord = Record<string, unknown>;
export interface GadSqlResult {
    rows: GadJsonRecord[];
}
export interface GadStatusMetric {
    metric: string;
    value: number;
}

export interface TrajectoryAppendItem {
  event: AgenticEvent;
  eventId?: string | null;
  publish?: {
    channelIds: string[];
    audience?: unknown;
  } | null;
}

export interface AppendTrajectoryBatchInput {
  trajectoryId: string;
  branchId: string;
  owner: { kind: "agent"; id: string };
  expectedHeadEventHash?: string | null;
  events: TrajectoryAppendItem[];
}

export interface AppendTrajectoryBatchResult {
  trajectoryId: string;
  branchId: string;
  headEventId: string | null;
  headEventHash: string | null;
  headStateHash: string | null;
  events: TrajectoryEvent[];
  published: Array<{ eventId: string; channelId: string; envelopeId: string }>;
}

export interface ChannelPublication {
  eventId: string;
  trajectoryId: string;
  branchId: string;
  channelId: string;
  channelSeq: number;
  envelopeId: string;
  publishedAt: string;
}

export interface EnvelopeLineage {
  publication: ChannelPublication;
  envelope: ChannelEnvelope;
  trajectoryEvent: TrajectoryEvent;
}

export interface PublishedArtifact {
  lineage: EnvelopeLineage;
}

export interface PrivateLineageForPublishedEnvelope {
  lineage: EnvelopeLineage;
  branchEvents: TrajectoryEvent[];
}

export interface ChannelReplayWindow {
  envelopes: ChannelEnvelope[];
  totalCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

export interface GadClient {
  rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  getTrajectoryBranchHead(input: { trajectoryId: string; branchId: string }): Promise<GadJsonRecord | null>;
  appendTrajectoryBatch(input: AppendTrajectoryBatchInput): Promise<AppendTrajectoryBatchResult>;
  listTrajectoryEvents(input: { trajectoryId?: string | null; branchId: string; cursor?: number | null; limit?: number | null }): Promise<TrajectoryEvent[]>;
  appendChannelEnvelope(input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
    envelopeId?: string | null;
    publishedAt?: string | null;
  }): Promise<ChannelEnvelope>;
  getChannelEnvelope(input: { envelopeId: string }): Promise<ChannelEnvelope | null>;
  getTrajectoryForEnvelope(input: { envelopeId: string }): Promise<EnvelopeLineage | null>;
  listPublishedEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): Promise<EnvelopeLineage[]>;
  getEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): Promise<EnvelopeLineage[]>;
  getPublishedArtifactsForTurn(input: {
    branchId?: string | null;
    turnId: string;
    channelId?: string | null;
    limit?: number | null;
  }): Promise<PublishedArtifact[]>;
  getPrivateLineageForPublishedEnvelope(input: { envelopeId: string }): Promise<PrivateLineageForPublishedEnvelope | null>;
  getDownstreamConsumers(input: { envelopeId: string; limit?: number | null }): Promise<TrajectoryEvent[]>;
  getChannelReplayWindow(input: {
    channelId: string;
    mode: "initial" | "after" | "before";
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    limit?: number | null;
  }): Promise<ChannelReplayWindow>;
  listChannelEnvelopesAfter(input: { channelId: string; seq?: number | null; limit?: number | null }): Promise<ChannelEnvelope[]>;
  listChannelEnvelopesBefore(input: { channelId: string; seq: number; limit?: number | null }): Promise<ChannelEnvelope[]>;
  getInitialChannelWindow(input: { channelId: string; limit?: number | null }): Promise<ChannelReplayWindow>;
  listChannelEnvelopes(input: { channelId: string; cursor?: number | null; limit?: number | null; payloadKind?: string | null }): Promise<ChannelEnvelope[]>;
  listGadBranchFiles(input: { branchId: string }): Promise<GadJsonRecord[]>;
  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): Promise<{ added: GadJsonRecord[]; removed: GadJsonRecord[]; changed: GadJsonRecord[] }>;
  readGadFileAtState(input: { stateHash: string; path: string }): Promise<GadJsonRecord | null>;
  getGadStateProducer(input: { stateHash: string }): Promise<GadJsonRecord | null>;
  blameGadFileSnippet(input: { stateHash?: string | null; fileVersionId?: number | null; path: string }): Promise<GadJsonRecord[]>;
  validateGadHashes(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  clearDirtyAfterValidation(input?: object): Promise<{ ok: boolean; errors: string[] }>;
  checkGadIntegrity(input?: object): Promise<{ ok: boolean; errors: GadJsonRecord[] }>;
  rebuildTrajectoryProjections(input?: object): Promise<{ replayed: number }>;
}
export function createGadClient(rpc: RpcCaller): GadClient {
  const service = createGadServiceClient(rpc);
  const call = <T>(method: string, ...args: unknown[]) => service.call<T>(method, ...args);

  return {
    rawSql: (sql, bindings) => call("rawSql", sql, bindings),
    query: (sql, bindings) => call("query", sql, bindings),
    status: () => call("getStatus"),
    ensureBlob: (hash, size, mimeType) => call("ensureBlob", hash, size, mimeType),
    getTrajectoryBranchHead: (input) => call("getTrajectoryBranchHead", input),
    appendTrajectoryBatch: (input) => call("appendTrajectoryBatch", input),
    listTrajectoryEvents: (input) => call("listTrajectoryEvents", input),
    appendChannelEnvelope: (input) => call("appendChannelEnvelope", input),
    getChannelEnvelope: (input) => call("getChannelEnvelope", input),
    getTrajectoryForEnvelope: (input) => call("getTrajectoryForEnvelope", input),
    listPublishedEnvelopesForTrajectory: (input) => call("listPublishedEnvelopesForTrajectory", input),
    getEnvelopesForTrajectory: (input) => call("getEnvelopesForTrajectory", input),
    getPublishedArtifactsForTurn: (input) => call("getPublishedArtifactsForTurn", input),
    getPrivateLineageForPublishedEnvelope: (input) => call("getPrivateLineageForPublishedEnvelope", input),
    getDownstreamConsumers: (input) => call("getDownstreamConsumers", input),
    getChannelReplayWindow: (input) => call("getChannelReplayWindow", input),
    listChannelEnvelopesAfter: (input) => call("listChannelEnvelopesAfter", input),
    listChannelEnvelopesBefore: (input) => call("listChannelEnvelopesBefore", input),
    getInitialChannelWindow: (input) => call("getInitialChannelWindow", input),
    listChannelEnvelopes: (input) => call("listChannelEnvelopes", input),
    listGadBranchFiles: (input) => call("listGadBranchFiles", input),
    diffGadStates: (input) => call("diffGadStates", input),
    readGadFileAtState: (input) => call("readGadFileAtState", input),
    getGadStateProducer: (input) => call("getGadStateProducer", input),
    blameGadFileSnippet: (input) => call("blameGadFileSnippet", input),
    validateGadHashes: (input) => call("validateGadHashes", input),
    clearDirtyAfterValidation: (input) => call("clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => call("checkGadIntegrity", input),
    rebuildTrajectoryProjections: (input) => call("rebuildTrajectoryProjections", input),
  };
}
