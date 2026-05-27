import type { RpcCaller } from "@natstack/rpc";
import { createGadServiceClient } from "@natstack/shared/userlandServiceRpc";
import {
  hydrateStoredValueRefs,
  type AgenticEvent,
  type ChannelEnvelope,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";

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

export interface ChannelEnvelopeInspection {
  envelopeId: string;
  channelId: string;
  seq: number;
  payloadKind?: string;
  from: GadJsonRecord;
  metadata?: GadJsonRecord;
  bytes: Record<string, number>;
  payloadSummary: unknown;
  storedRefs: GadJsonRecord[];
  publishedAt: string;
}

export interface ChannelMessageTypeDefinition {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "code"; code: string } | { type: "file"; path: string };
  imports?: Record<string, string>;
  schemaSourceOrPath?: unknown;
  registeredBy?: Record<string, unknown>;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export type RegistryMutationInput =
  | {
      kind: "upsertMessageType";
      typeId: string;
      row: Omit<ChannelMessageTypeDefinition, "typeId" | "updatedAtSeq" | "clearedAtSeq">;
    }
  | { kind: "clearMessageType"; typeId: string };

export type GadSqlInput = string | { sql: string; params?: GadSqlBinding[]; bindings?: GadSqlBinding[] };

export interface GadClient {
  rawSql(sql: GadSqlInput, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  query(sql: GadSqlInput, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
  status(): Promise<GadStatusMetric[]>;
  ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
  getTrajectoryBranchHead(input: { trajectoryId: string; branchId: string }): Promise<GadJsonRecord | null>;
  appendTrajectoryBatch(input: AppendTrajectoryBatchInput): Promise<AppendTrajectoryBatchResult>;
  listTrajectoryEvents(input: { trajectoryId?: string | null; branchId: string; cursor?: number | null; limit?: number | null }): Promise<TrajectoryEvent[]>;
  appendChannelEnvelope(input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
    envelopeId?: string | null;
    publishedAt?: string | null;
  }): Promise<ChannelEnvelope>;
  appendChannelEnvelopeWithRegistryMutation(input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
    envelopeId?: string | null;
    publishedAt?: string | null;
    registryMutation: RegistryMutationInput;
  }): Promise<ChannelEnvelope>;
  listMessageTypes(input: { channelId: string }): Promise<ChannelMessageTypeDefinition[]>;
  getMessageType(input: { channelId: string; typeId: string }): Promise<ChannelMessageTypeDefinition | null>;
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
  inspectChannelEnvelopes(input: { channelId: string; cursor?: number | null; limit?: number | null; payloadKind?: string | null }): Promise<{ rows: ChannelEnvelopeInspection[] }>;
  listStoredValueRefs(input?: { eventId?: string | null; envelopeId?: string | null; digest?: string | null; limit?: number | null }): Promise<{ rows: GadJsonRecord[] }>;
  inspectStorageDiagnostics(input?: { rowByteLimit?: number | null; limit?: number | null }): Promise<{ rows: GadJsonRecord[] }>;
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
  const normalizeSqlArgs = (input: GadSqlInput, bindings?: GadSqlBinding[]): [string, GadSqlBinding[]] => {
    if (typeof input === "string") return [input, bindings ?? []];
    return [input.sql, input.bindings ?? input.params ?? bindings ?? []];
  };
  const hydrate = async <T>(value: T): Promise<T> =>
    hydrateStoredValueRefs(value, {
      getText: (digest) => rpc.call<string | null>("main", "blobstore.getText", [digest]),
    }) as Promise<T>;
  const hydrateLineage = async <T extends { envelope: ChannelEnvelope; trajectoryEvent: TrajectoryEvent }>(
    item: T
  ): Promise<T> => ({
    ...item,
    envelope: await hydrate(item.envelope),
    trajectoryEvent: await hydrate(item.trajectoryEvent),
  });

  return {
    rawSql: (input, bindings) => call("rawSql", ...normalizeSqlArgs(input, bindings)),
    query: (input, bindings) => call("query", ...normalizeSqlArgs(input, bindings)),
    status: () => call("getStatus"),
    ensureBlob: (hash, size, mimeType) => call("ensureBlob", hash, size, mimeType),
    getTrajectoryBranchHead: (input) => call("getTrajectoryBranchHead", input),
    appendTrajectoryBatch: async (input) => {
      const result = await call<AppendTrajectoryBatchResult>("appendTrajectoryBatch", input);
      return { ...result, events: await Promise.all(result.events.map((event) => hydrate(event))) };
    },
    listTrajectoryEvents: async (input) => Promise.all((await call<TrajectoryEvent[]>("listTrajectoryEvents", input)).map((event) => hydrate(event))),
    appendChannelEnvelope: (input) => call<ChannelEnvelope>("appendChannelEnvelope", input).then(hydrate),
    appendChannelEnvelopeWithRegistryMutation: (input) => call<ChannelEnvelope>("appendChannelEnvelopeWithRegistryMutation", input).then(hydrate),
    listMessageTypes: (input) => call("listMessageTypes", input),
    getMessageType: (input) => call("getMessageType", input),
    getChannelEnvelope: (input) => call<ChannelEnvelope | null>("getChannelEnvelope", input).then((value) => value ? hydrate(value) : null),
    getTrajectoryForEnvelope: (input) => call<EnvelopeLineage | null>("getTrajectoryForEnvelope", input).then((value) => value ? hydrateLineage(value) : null),
    listPublishedEnvelopesForTrajectory: async (input) => Promise.all((await call<EnvelopeLineage[]>("listPublishedEnvelopesForTrajectory", input)).map(hydrateLineage)),
    getEnvelopesForTrajectory: async (input) => Promise.all((await call<EnvelopeLineage[]>("getEnvelopesForTrajectory", input)).map(hydrateLineage)),
    getPublishedArtifactsForTurn: async (input) => Promise.all((await call<PublishedArtifact[]>("getPublishedArtifactsForTurn", input)).map(async (item) => ({
      ...item,
      lineage: await hydrateLineage(item.lineage),
    }))),
    getPrivateLineageForPublishedEnvelope: async (input) => {
      const value = await call<PrivateLineageForPublishedEnvelope | null>("getPrivateLineageForPublishedEnvelope", input);
      return value ? {
        ...value,
        lineage: await hydrateLineage(value.lineage),
        branchEvents: await Promise.all(value.branchEvents.map((event) => hydrate(event))),
      } : null;
    },
    getDownstreamConsumers: async (input) => Promise.all((await call<TrajectoryEvent[]>("getDownstreamConsumers", input)).map((event) => hydrate(event))),
    getChannelReplayWindow: async (input) => {
      const window = await call<ChannelReplayWindow>("getChannelReplayWindow", input);
      return { ...window, envelopes: await Promise.all(window.envelopes.map((envelope) => hydrate(envelope))) };
    },
    listChannelEnvelopesAfter: async (input) => Promise.all((await call<ChannelEnvelope[]>("listChannelEnvelopesAfter", input)).map((envelope) => hydrate(envelope))),
    listChannelEnvelopesBefore: async (input) => Promise.all((await call<ChannelEnvelope[]>("listChannelEnvelopesBefore", input)).map((envelope) => hydrate(envelope))),
    getInitialChannelWindow: async (input) => {
      const window = await call<ChannelReplayWindow>("getInitialChannelWindow", input);
      return { ...window, envelopes: await Promise.all(window.envelopes.map((envelope) => hydrate(envelope))) };
    },
    listChannelEnvelopes: async (input) => Promise.all((await call<ChannelEnvelope[]>("listChannelEnvelopes", input)).map((envelope) => hydrate(envelope))),
    inspectChannelEnvelopes: (input) => call("inspectChannelEnvelopes", input),
    listStoredValueRefs: (input) => call("listStoredValueRefs", input ?? {}),
    inspectStorageDiagnostics: (input) => call("inspectStorageDiagnostics", input ?? {}),
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
