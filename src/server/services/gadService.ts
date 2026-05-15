import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ApprovalPrincipal, UserlandApprovalSubject } from "@natstack/shared/approvals";
import type { DODispatch } from "../doDispatch.js";
import type { DORef } from "../doDispatch.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import type { UserlandApprovalGrantStore } from "./userlandApprovalGrantStore.js";

const SQL_WRITE_SUBJECT: UserlandApprovalSubject = {
  id: "gad:raw-sql-write",
  label: "gad raw SQL writes",
};

const JsonRecordSchema = z.record(z.unknown());
const OptionalJsonRecordSchema = JsonRecordSchema.nullish();
const JsonBindingsSchema = z.array(z.unknown()).optional();
const RelationSchema = z.object({ targetType: z.string(), targetHash: z.string() }).strict();
const ListOptsSchema = z.record(z.unknown()).optional();

const RecordSessionSchema = z.object({
  id: z.string(),
  parentSessionId: z.string().nullable().optional(),
  source: z.string(),
  projectPath: z.string().nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  metadata: OptionalJsonRecordSchema,
  startedAt: z.string().nullable().optional(),
}).strict();

const RecordTurnSchema = z.object({
  sessionId: z.string(),
  role: z.string(),
  content: z.string(),
  contentFormat: z.string().optional(),
  turnIndex: z.number().int().optional(),
  tokenCount: z.number().int().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  messageIndex: z.number().int().nullable().optional(),
  channelId: z.string().nullable().optional(),
}).strict();

const BeginToolCallSchema = z.object({
  sessionId: z.string(),
  turnId: z.number().int().nullable().optional(),
  toolName: z.string(),
  parameters: OptionalJsonRecordSchema,
  isMutation: z.boolean().optional(),
  gitBranch: z.string().nullable().optional(),
  gitCommit: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
}).strict();

const RecordReadSchema = z.object({
  toolCallId: z.number().int(),
  readType: z.string().optional(),
  filePath: z.string().nullable().optional(),
  contentHash: z.string(),
  contentSize: z.number().int().nullable().optional(),
  sourceBlobHash: z.string().nullable().optional(),
  startLine: z.number().int().nullable().optional(),
  endLine: z.number().int().nullable().optional(),
  byteOffset: z.number().int().nullable().optional(),
  byteLength: z.number().int().nullable().optional(),
  metadata: OptionalJsonRecordSchema,
}).strict();

const RecordMutationSchema = z.object({
  toolCallId: z.number().int(),
  filePath: z.string(),
  renamedFromPath: z.string().nullable().optional(),
  beforeHash: z.string().nullable().optional(),
  afterHash: z.string().nullable().optional(),
  beforeSize: z.number().int().nullable().optional(),
  afterSize: z.number().int().nullable().optional(),
  mutationType: z.string(),
  oldString: z.string().nullable().optional(),
  newString: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
}).strict();

const EnsureBranchSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  parentBranchId: z.string().nullable().optional(),
  forkedFromSessionId: z.string().nullable().optional(),
  forkedFromTurnId: z.number().int().nullable().optional(),
  forkedFromMessageIndex: z.number().int().nullable().optional(),
  createdBy: z.string().nullable().optional(),
}).strict();

const ForkBranchSchema = EnsureBranchSchema.extend({
  parentBranchId: z.string(),
}).strict();

const CreateBranchSnapshotSchema = z.object({
  branchId: z.string(),
  parentSnapshotId: z.number().int().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  turnId: z.number().int().nullable().optional(),
  summary: z.string().nullable().optional(),
}).strict();

const RecordPlanSchema = z.object({
  content: z.string(),
  sourcePath: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  toolCallId: z.number().int().nullable().optional(),
  branchId: z.string().nullable().optional(),
}).strict();

const CreateChunkSchema = z.object({
  content: z.string(),
  topicLabel: z.string().nullable().optional(),
  attribution: z.string().nullable().optional(),
  sourceSessionId: z.string().nullable().optional(),
  sourceTurnId: z.number().int().nullable().optional(),
  relations: z.array(RelationSchema).nullable().optional(),
}).strict();

const AddChunkMentionSchema = z.object({
  chunkHash: z.string(),
  attribution: z.string().nullable().optional(),
  sourceSessionId: z.string().nullable().optional(),
  sourceTurnId: z.number().int().nullable().optional(),
}).strict();

const VectorSchema = z.object({
  model: z.string(),
  vector: z.array(z.number()),
  k: z.number().int().positive().optional(),
  dim: z.number().int().positive().optional(),
}).strict();

const ChunkEmbeddingSchema = VectorSchema.extend({ chunkHash: z.string() }).strict();
const TurnEmbeddingSchema = VectorSchema.extend({ turnId: z.number().int() }).strict();

const ParseFileVersionSchema = z.object({
  filePath: z.string(),
  contentHash: z.string(),
  content: z.string(),
  language: z.string().nullable().optional(),
  includeLeaves: z.boolean().optional(),
}).strict();

const IndexFileVersionSchema = z.object({
  path: z.string(),
  contentHash: z.string(),
  content: z.string(),
}).strict();

const ReviewContextSchema = z.object({
  filePath: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  limit: z.number().int().positive().optional(),
}).strict();

const BlobPolicySchema = z.object({
  hash: z.string(),
  retentionClass: z.string().nullable().optional(),
  privacyLevel: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  redactionReason: z.string().nullable().optional(),
}).strict();

export interface GadServiceDeps {
  doDispatch: DODispatch;
  resolveStore: () => DORef;
  approvalQueue: ApprovalQueue;
  grantStore: Pick<UserlandApprovalGrantStore, "lookup" | "record" | "revoke">;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
}

function stripLeadingSqlTrivia(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trimStart();
      continue;
    }
    return s;
  }
}

function isReadOnlySql(sql: string): boolean {
  const first = stripLeadingSqlTrivia(sql).match(/^[A-Za-z]+/u)?.[0]?.toUpperCase();
  // Keep this deliberately narrow. SQLite supports mutating statements with
  // WITH/PRAGMA shapes, so arbitrary raw SQL gets approved unless it is a
  // plain read/explain.
  return first === "SELECT" || first === "EXPLAIN";
}

function summarizeSql(sql: string): string {
  const compact = sql.replace(/\s+/gu, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function sqlVerb(sql: string): string {
  return stripLeadingSqlTrivia(sql).match(/^[A-Za-z]+/u)?.[0]?.toUpperCase() ?? "UNKNOWN";
}

function extractSqlTables(sql: string): string[] {
  const compact = stripLeadingSqlTrivia(sql).replace(/\s+/gu, " ");
  const names = new Set<string>();
  const patterns = [
    /\bUPDATE\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bINTO\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bFROM\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`[]?([A-Za-z_][\w]*)/giu,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(compact))) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].filter((name) => !name.startsWith("sqlite_")).slice(0, 8);
}

function classifySqlRisk(sql: string): "schema" | "delete" | "update" | "insert" | "unknown-write" {
  const verb = sqlVerb(sql);
  if (["DROP", "ALTER", "CREATE", "VACUUM", "REINDEX"].includes(verb)) return "schema";
  if (verb === "DELETE" || verb === "TRUNCATE") return "delete";
  if (verb === "UPDATE" || verb === "REPLACE") return "update";
  if (verb === "INSERT") return "insert";
  return "unknown-write";
}

async function describeSqlRisk(deps: GadServiceDeps, sql: string): Promise<Array<{ label: string; value: string }>> {
  const details = [
    { label: "Risk", value: classifySqlRisk(sql) },
    { label: "SQL", value: summarizeSql(sql) },
  ];
  const tables = extractSqlTables(sql);
  if (tables.length > 0) {
    details.splice(1, 0, { label: "Tables", value: tables.join(", ") });
  }
  for (const table of tables.slice(0, 4)) {
    try {
      const result = await deps.doDispatch.dispatch(deps.resolveStore(), "rawSql", `SELECT COUNT(*) AS count FROM "${table}"`, []);
      const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      details.push({ label: `${table} rows`, value: String(rows[0]?.["count"] ?? "unknown") });
    } catch {
      details.push({ label: `${table} rows`, value: "unavailable" });
    }
  }
  return details;
}

async function resolvePrincipal(
  deps: GadServiceDeps,
  ctx: ServiceContext,
): Promise<ApprovalPrincipal> {
  if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") {
    throw new ServiceError("gad", "rawSql", "Only panel/worker raw SQL writes use userland approval", "EACCES");
  }
  const identity = deps.codeIdentityResolver.resolveByCallerId(ctx.callerId);
  if (!identity) {
    throw new ServiceError("gad", "rawSql", `Unknown caller identity: ${ctx.callerId}`, "ENOENT");
  }
  if (identity.callerKind !== ctx.callerKind) {
    throw new ServiceError("gad", "rawSql", `Caller identity kind mismatch for ${ctx.callerId}`, "EACCES");
  }
  return {
    callerId: identity.callerId,
    callerKind: identity.callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
  };
}

async function requireRawSqlWriteApproval(
  deps: GadServiceDeps,
  ctx: ServiceContext,
  sql: string,
): Promise<void> {
  if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") return;
  const principal = await resolvePrincipal(deps, ctx);
  const existing = deps.grantStore.lookup(principal.callerId, SQL_WRITE_SUBJECT.id);
  if (existing?.choice === "allow") return;

  const riskDetails = await describeSqlRisk(deps, sql);
  const result = await deps.approvalQueue.requestUserland({
    principal,
    subject: SQL_WRITE_SUBJECT,
    title: "Allow gad raw SQL write?",
    summary:
      "This panel or worker wants to execute a non-read-only SQL statement against the workspace gad provenance database.",
    warning: "This can modify or delete tracked provenance, branch metadata, and semantic context.",
    details: [
      { label: "Caller", value: principal.callerId },
      ...riskDetails,
    ],
    options: [
      {
        value: "allow",
        label: "Allow",
        description: "Trust this caller for gad raw SQL writes.",
        tone: "primary",
      },
      {
        value: "deny",
        label: "Deny",
        description: "Block this SQL statement.",
        tone: "danger",
      },
    ],
  });
  if (result.kind !== "choice" || result.choice !== "allow") {
    throw new ServiceError("gad", "rawSql", "Raw SQL write was denied", "EACCES");
  }
  await deps.grantStore.record(
    { callerId: principal.callerId, callerKind: principal.callerKind },
    SQL_WRITE_SUBJECT,
    "allow",
  );
}

export function createGadService(deps: GadServiceDeps): ServiceDefinition {
  const dispatch = (method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(deps.resolveStore(), method, ...args);

  return {
    name: "gad",
    description: "Workspace gad provenance and context graph service",
    policy: { allowed: ["panel", "worker", "extension", "shell", "server"] },
    methods: {
      rawSql: { args: z.tuple([z.string(), JsonBindingsSchema]) },
      query: { args: z.tuple([z.string(), JsonBindingsSchema]) },
      status: { args: z.tuple([]) },
      ensureBlob: { args: z.tuple([z.string(), z.number().int().optional(), z.string().nullable().optional()]) },
      ensureBranch: { args: z.tuple([EnsureBranchSchema]) },
      recordSession: { args: z.tuple([RecordSessionSchema]) },
      endSession: { args: z.tuple([z.string(), z.string().nullable().optional()]) },
      recordTurn: { args: z.tuple([RecordTurnSchema]) },
      beginToolCall: { args: z.tuple([BeginToolCallSchema]) },
      completeToolCall: { args: z.tuple([z.number().int(), z.string().nullable().optional(), z.string().nullable().optional()]) },
      recordRead: { args: z.tuple([RecordReadSchema]) },
      recordMutation: { args: z.tuple([RecordMutationSchema]) },
      listBranches: { args: z.tuple([]) },
      getBranch: { args: z.tuple([z.string()]) },
      listBranchFiles: { args: z.tuple([z.string()]) },
      forkBranch: { args: z.tuple([ForkBranchSchema]) },
      createBranchSnapshot: { args: z.tuple([CreateBranchSnapshotSchema]) },
      listBranchSnapshots: { args: z.tuple([z.string().nullable().optional()]) },
      recordPlan: { args: z.tuple([RecordPlanSchema]) },
      supersedePlan: { args: z.tuple([z.number().int(), z.number().int()]) },
      listPlans: { args: z.tuple([ListOptsSchema]) },
      getPlanChain: { args: z.tuple([z.number().int()]) },
      createChunk: { args: z.tuple([CreateChunkSchema]) },
      addChunkMention: { args: z.tuple([AddChunkMentionSchema]) },
      relateChunk: { args: z.tuple([z.string(), z.string(), z.string()]) },
      listChunks: { args: z.tuple([ListOptsSchema]) },
      getChunkMentions: { args: z.tuple([z.string()]) },
      getChunksFor: { args: z.tuple([z.string(), z.string()]) },
      getRelationsFor: { args: z.tuple([z.string()]) },
      walkDependencies: { args: z.tuple([z.string(), ListOptsSchema]) },
      upsertChunkEmbedding: { args: z.tuple([ChunkEmbeddingSchema]) },
      upsertTurnEmbedding: { args: z.tuple([TurnEmbeddingSchema]) },
      findSimilarChunks: { args: z.tuple([VectorSchema]) },
      findSimilarTurns: { args: z.tuple([VectorSchema]) },
      parseFileVersion: { args: z.tuple([ParseFileVersionSchema]) },
      getStructures: { args: z.tuple([z.string(), ListOptsSchema]) },
      findParsedByName: { args: z.tuple([z.string(), ListOptsSchema]) },
      getStructuresInRange: { args: z.tuple([z.string(), z.number().int(), z.number().int()]) },
      getSupportedLanguages: { args: z.tuple([]) },
      indexTurn: { args: z.tuple([z.number().int()]) },
      indexFileVersion: { args: z.tuple([IndexFileVersionSchema]) },
      indexSession: { args: z.tuple([z.string()]) },
      getReviewContext: { args: z.tuple([ReviewContextSchema]) },
      setBlobPolicy: { args: z.tuple([BlobPolicySchema]) },
      getBlobPolicy: { args: z.tuple([z.string()]) },
      redactBlob: { args: z.tuple([z.string(), z.string().nullable().optional()]) },
      listBlobReferences: { args: z.tuple([ListOptsSchema]) },
      revokeRawSqlWriteApproval: { args: z.tuple([]), policy: { allowed: ["panel", "worker"] } },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "rawSql":
        case "query": {
          const sql = args[0] as string;
          const bindings = (args[1] as unknown[] | undefined) ?? [];
          if (!isReadOnlySql(sql)) {
            await requireRawSqlWriteApproval(deps, ctx, sql);
          }
          return dispatch("rawSql", [sql, bindings]);
        }
        case "status":
          return dispatch("getStatus", []);
        case "ensureBlob":
          return dispatch("ensureBlob", args);
        case "ensureBranch":
          return dispatch("ensureBranch", args);
        case "recordSession":
          return dispatch("recordSession", args);
        case "endSession":
          return dispatch("endSession", args);
        case "recordTurn":
          return dispatch("recordTurn", args);
        case "beginToolCall":
          return dispatch("beginToolCall", args);
        case "completeToolCall":
          return dispatch("completeToolCall", args);
        case "recordRead":
          return dispatch("recordRead", args);
        case "recordMutation":
          return dispatch("recordMutation", args);
        case "listBranches":
          return dispatch("listBranches", args);
        case "getBranch":
          return dispatch("getBranch", args);
        case "listBranchFiles":
          return dispatch("listBranchFiles", args);
        case "forkBranch":
          return dispatch("forkBranch", args);
        case "createBranchSnapshot":
          return dispatch("createBranchSnapshot", args);
        case "listBranchSnapshots":
          return dispatch("listBranchSnapshots", args);
        case "recordPlan":
          return dispatch("recordPlan", args);
        case "supersedePlan":
          return dispatch("supersedePlan", args);
        case "listPlans":
          return dispatch("listPlans", args);
        case "getPlanChain":
          return dispatch("getPlanChain", args);
        case "createChunk":
          return dispatch("createChunk", args);
        case "addChunkMention":
          return dispatch("addChunkMention", args);
        case "relateChunk":
          return dispatch("relateChunk", args);
        case "listChunks":
          return dispatch("listChunks", args);
        case "getChunkMentions":
          return dispatch("getChunkMentions", args);
        case "getChunksFor":
          return dispatch("getChunksFor", args);
        case "getRelationsFor":
          return dispatch("getRelationsFor", args);
        case "walkDependencies":
          return dispatch("walkDependencies", args);
        case "upsertChunkEmbedding":
          return dispatch("upsertChunkEmbedding", args);
        case "upsertTurnEmbedding":
          return dispatch("upsertTurnEmbedding", args);
        case "findSimilarChunks":
          return dispatch("findSimilarChunks", args);
        case "findSimilarTurns":
          return dispatch("findSimilarTurns", args);
        case "parseFileVersion":
          return dispatch("parseFileVersion", args);
        case "getStructures":
          return dispatch("getStructures", args);
        case "findParsedByName":
          return dispatch("findParsedByName", args);
        case "getStructuresInRange":
          return dispatch("getStructuresInRange", args);
        case "getSupportedLanguages":
          return dispatch("getSupportedLanguages", args);
        case "indexTurn":
          return dispatch("indexTurn", args);
        case "indexFileVersion":
          return dispatch("indexFileVersion", args);
        case "indexSession":
          return dispatch("indexSession", args);
        case "getReviewContext":
          return dispatch("getReviewContext", args);
        case "setBlobPolicy":
          return dispatch("setBlobPolicy", args);
        case "getBlobPolicy":
          return dispatch("getBlobPolicy", args);
        case "redactBlob":
          return dispatch("redactBlob", args);
        case "listBlobReferences":
          return dispatch("listBlobReferences", args);
        case "revokeRawSqlWriteApproval": {
          const principal = await resolvePrincipal(deps, ctx);
          return deps.grantStore.revoke(principal.callerId, SQL_WRITE_SUBJECT.id);
        }
        default:
          throw new ServiceError("gad", method, `Unknown gad method: ${method}`, "ENOSYS");
      }
    },
  };
}
