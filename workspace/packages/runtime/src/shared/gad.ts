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
export interface GadRecordSessionInput {
    id: string;
    parentSessionId?: string | null;
    source: string;
    projectPath?: string | null;
    gitBranch?: string | null;
    branchId?: string | null;
    channelId?: string | null;
    contextId?: string | null;
    metadata?: GadJsonRecord | null;
    startedAt?: string | null;
}
export interface GadRecordTurnInput {
    sessionId: string;
    role: string;
    content: string;
    contentFormat?: string;
    turnIndex?: number;
    tokenCount?: number | null;
    timestamp?: string | null;
    messageIndex?: number | null;
    channelId?: string | null;
}
export interface GadBeginToolCallInput {
    sessionId: string;
    turnId?: number | null;
    toolName: string;
    parameters?: GadJsonRecord | null;
    isMutation?: boolean;
    gitBranch?: string | null;
    gitCommit?: string | null;
    branchId?: string | null;
    channelId?: string | null;
    contextId?: string | null;
    startedAt?: string | null;
}
export interface GadRecordReadInput {
    toolCallId: number;
    readType?: string;
    filePath?: string | null;
    contentHash: string;
    contentSize?: number | null;
    sourceBlobHash?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    byteOffset?: number | null;
    byteLength?: number | null;
    metadata?: GadJsonRecord | null;
}
export interface GadRecordMutationInput {
    toolCallId: number;
    filePath: string;
    renamedFromPath?: string | null;
    beforeHash?: string | null;
    afterHash?: string | null;
    beforeSize?: number | null;
    afterSize?: number | null;
    mutationType: string;
    oldString?: string | null;
    newString?: string | null;
    description?: string | null;
    branchId?: string | null;
}
export interface GadEnsureBranchInput {
    id: string;
    name?: string;
    parentBranchId?: string | null;
    forkedFromSessionId?: string | null;
    forkedFromTurnId?: number | null;
    forkedFromMessageIndex?: number | null;
    createdBy?: string | null;
}
export interface GadCreateBranchSnapshotInput {
    branchId: string;
    parentSnapshotId?: number | null;
    sessionId?: string | null;
    turnId?: number | null;
    summary?: string | null;
}
export interface GadRecordPlanInput {
    content: string;
    sourcePath?: string | null;
    title?: string | null;
    sessionId?: string | null;
    toolCallId?: number | null;
    branchId?: string | null;
}
export interface GadCreateChunkInput {
    content: string;
    topicLabel?: string | null;
    attribution?: string | null;
    sourceSessionId?: string | null;
    sourceTurnId?: number | null;
    relations?: Array<{
        targetType: string;
        targetHash: string;
    }> | null;
}
export interface GadVectorInput {
    model: string;
    vector: number[];
    k?: number;
    dim?: number;
}
export interface GadParseFileVersionInput {
    filePath: string;
    contentHash: string;
    content: string;
    language?: string | null;
    includeLeaves?: boolean;
}
export interface GadReviewContextInput {
    filePath?: string | null;
    sessionId?: string | null;
    branchId?: string | null;
    limit?: number;
}
export interface GadBlobPolicyInput {
    hash: string;
    retentionClass?: string | null;
    privacyLevel?: string | null;
    expiresAt?: string | null;
    redactionReason?: string | null;
}
export interface GadClient {
    rawSql(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
    query(sql: string, bindings?: GadSqlBinding[]): Promise<GadSqlResult>;
    status(): Promise<GadStatusMetric[]>;
    ensureBlob(hash: string, size?: number, mimeType?: string | null): Promise<void>;
    ensureBranch(input: GadEnsureBranchInput): Promise<{
        id: string;
    }>;
    recordSession(input: GadRecordSessionInput): Promise<{
        id: string;
    }>;
    endSession(sessionId: string, endedAt?: string | null): Promise<void>;
    recordTurn(input: GadRecordTurnInput): Promise<{
        id: number;
        turnIndex: number;
    }>;
    beginToolCall(input: GadBeginToolCallInput): Promise<{
        id: number;
    }>;
    completeToolCall(toolCallId: number, resultSummary?: string | null, completedAt?: string | null): Promise<void>;
    recordRead(input: GadRecordReadInput): Promise<{
        id: number;
    }>;
    recordMutation(input: GadRecordMutationInput): Promise<{
        id: number;
    }>;
    listBranches(): Promise<GadJsonRecord[]>;
    getBranch(branchId: string): Promise<GadJsonRecord | null>;
    listBranchFiles(branchId: string): Promise<GadJsonRecord[]>;
    forkBranch(input: GadEnsureBranchInput & {
        parentBranchId: string;
    }): Promise<{
        id: string;
    }>;
    createBranchSnapshot(input: GadCreateBranchSnapshotInput): Promise<{
        id: number;
    }>;
    listBranchSnapshots(branchId?: string | null): Promise<GadJsonRecord[]>;
    recordPlan(input: GadRecordPlanInput): Promise<GadJsonRecord>;
    supersedePlan(oldPlanId: number, newPlanId: number): Promise<void>;
    listPlans(input?: GadJsonRecord): Promise<GadJsonRecord[]>;
    getPlanChain(planId: number): Promise<GadJsonRecord[]>;
    createChunk(input: GadCreateChunkInput): Promise<GadJsonRecord>;
    addChunkMention(input: {
        chunkHash: string;
        attribution?: string | null;
        sourceSessionId?: string | null;
        sourceTurnId?: number | null;
    }): Promise<void>;
    relateChunk(chunkHash: string, targetType: string, targetHash: string): Promise<void>;
    listChunks(input?: {
        attribution?: string | null;
        since?: string | null;
    }): Promise<GadJsonRecord[]>;
    getChunkMentions(chunkHash: string): Promise<GadJsonRecord[]>;
    getChunksFor(targetType: string, targetHash: string): Promise<GadJsonRecord[]>;
    getRelationsFor(chunkHash: string): Promise<GadJsonRecord[]>;
    walkDependencies(chunkHash: string, input?: {
        maxDepth?: number;
        targetTypes?: string[];
    }): Promise<{
        nodes: GadJsonRecord[];
        edges: Array<{
            from: string;
            to: string;
            relationType: string;
        }>;
    }>;
    upsertChunkEmbedding(input: GadVectorInput & {
        chunkHash: string;
    }): Promise<void>;
    upsertTurnEmbedding(input: GadVectorInput & {
        turnId: number;
    }): Promise<void>;
    findSimilarChunks(input: GadVectorInput): Promise<GadJsonRecord[]>;
    findSimilarTurns(input: GadVectorInput): Promise<GadJsonRecord[]>;
    parseFileVersion(input: GadParseFileVersionInput): Promise<GadJsonRecord[]>;
    getStructures(contentHash: string, input?: GadJsonRecord): Promise<GadJsonRecord[]>;
    findParsedByName(name: string, input?: GadJsonRecord): Promise<GadJsonRecord[]>;
    getStructuresInRange(fileHash: string, startLine: number, endLine: number): Promise<GadJsonRecord[]>;
    getSupportedLanguages(): Promise<string[]>;
    indexTurn(turnId: number): Promise<GadJsonRecord | null>;
    indexFileVersion(input: {
        path: string;
        contentHash: string;
        content: string;
    }): Promise<{
        structures: GadJsonRecord[];
        chunk: GadJsonRecord;
    }>;
    indexSession(sessionId: string): Promise<{
        turnsIndexed: number;
        fileVersionsIndexed: number;
    }>;
    getReviewContext(input: GadReviewContextInput): Promise<GadJsonRecord>;
    setBlobPolicy(input: GadBlobPolicyInput): Promise<GadJsonRecord>;
    getBlobPolicy(hash: string): Promise<GadJsonRecord | null>;
    redactBlob(hash: string, reason?: string | null): Promise<GadJsonRecord>;
    listBlobReferences(input?: {
        includeUnreferenced?: boolean;
    }): Promise<GadJsonRecord[]>;
    revokeRawSqlWriteApproval(): Promise<boolean>;
}
export function createGadClient(rpc: RpcCaller): GadClient {
    return {
        rawSql: (sql, bindings) => rpc.call("main", "gad.rawSql", [sql, bindings]),
        query: (sql, bindings) => rpc.call("main", "gad.query", [sql, bindings]),
        status: () => rpc.call("main", "gad.status", []),
        ensureBlob: (hash, size, mimeType) => rpc.call("main", "gad.ensureBlob", [hash, size, mimeType]),
        ensureBranch: (input) => rpc.call("main", "gad.ensureBranch", [input]),
        recordSession: (input) => rpc.call("main", "gad.recordSession", [input]),
        endSession: (sessionId, endedAt) => rpc.call("main", "gad.endSession", [sessionId, endedAt]),
        recordTurn: (input) => rpc.call("main", "gad.recordTurn", [input]),
        beginToolCall: (input) => rpc.call("main", "gad.beginToolCall", [input]),
        completeToolCall: (toolCallId, resultSummary, completedAt) => rpc.call("main", "gad.completeToolCall", [toolCallId, resultSummary, completedAt]),
        recordRead: (input) => rpc.call("main", "gad.recordRead", [input]),
        recordMutation: (input) => rpc.call("main", "gad.recordMutation", [input]),
        listBranches: () => rpc.call("main", "gad.listBranches", []),
        getBranch: (branchId) => rpc.call("main", "gad.getBranch", [branchId]),
        listBranchFiles: (branchId) => rpc.call("main", "gad.listBranchFiles", [branchId]),
        forkBranch: (input) => rpc.call("main", "gad.forkBranch", [input]),
        createBranchSnapshot: (input) => rpc.call("main", "gad.createBranchSnapshot", [input]),
        listBranchSnapshots: (branchId) => rpc.call("main", "gad.listBranchSnapshots", [branchId]),
        recordPlan: (input) => rpc.call("main", "gad.recordPlan", [input]),
        supersedePlan: (oldPlanId, newPlanId) => rpc.call("main", "gad.supersedePlan", [oldPlanId, newPlanId]),
        listPlans: (input) => rpc.call("main", "gad.listPlans", [input]),
        getPlanChain: (planId) => rpc.call("main", "gad.getPlanChain", [planId]),
        createChunk: (input) => rpc.call("main", "gad.createChunk", [input]),
        addChunkMention: (input) => rpc.call("main", "gad.addChunkMention", [input]),
        relateChunk: (chunkHash, targetType, targetHash) => rpc.call("main", "gad.relateChunk", [chunkHash, targetType, targetHash]),
        listChunks: (input) => rpc.call("main", "gad.listChunks", [input]),
        getChunkMentions: (chunkHash) => rpc.call("main", "gad.getChunkMentions", [chunkHash]),
        getChunksFor: (targetType, targetHash) => rpc.call("main", "gad.getChunksFor", [targetType, targetHash]),
        getRelationsFor: (chunkHash) => rpc.call("main", "gad.getRelationsFor", [chunkHash]),
        walkDependencies: (chunkHash, input) => rpc.call("main", "gad.walkDependencies", [chunkHash, input]),
        upsertChunkEmbedding: (input) => rpc.call("main", "gad.upsertChunkEmbedding", [input]),
        upsertTurnEmbedding: (input) => rpc.call("main", "gad.upsertTurnEmbedding", [input]),
        findSimilarChunks: (input) => rpc.call("main", "gad.findSimilarChunks", [input]),
        findSimilarTurns: (input) => rpc.call("main", "gad.findSimilarTurns", [input]),
        parseFileVersion: (input) => rpc.call("main", "gad.parseFileVersion", [input]),
        getStructures: (contentHash, input) => rpc.call("main", "gad.getStructures", [contentHash, input]),
        findParsedByName: (name, input) => rpc.call("main", "gad.findParsedByName", [name, input]),
        getStructuresInRange: (fileHash, startLine, endLine) => rpc.call("main", "gad.getStructuresInRange", [fileHash, startLine, endLine]),
        getSupportedLanguages: () => rpc.call("main", "gad.getSupportedLanguages", []),
        indexTurn: (turnId) => rpc.call("main", "gad.indexTurn", [turnId]),
        indexFileVersion: (input) => rpc.call("main", "gad.indexFileVersion", [input]),
        indexSession: (sessionId) => rpc.call("main", "gad.indexSession", [sessionId]),
        getReviewContext: (input) => rpc.call("main", "gad.getReviewContext", [input]),
        setBlobPolicy: (input) => rpc.call("main", "gad.setBlobPolicy", [input]),
        getBlobPolicy: (hash) => rpc.call("main", "gad.getBlobPolicy", [hash]),
        redactBlob: (hash, reason) => rpc.call("main", "gad.redactBlob", [hash, reason]),
        listBlobReferences: (input) => rpc.call("main", "gad.listBlobReferences", [input]),
        revokeRawSqlWriteApproval: () => rpc.call("main", "gad.revokeRawSqlWriteApproval", []),
    };
}
