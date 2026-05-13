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
const ListOptsSchema = z.record(z.unknown()).optional();

const EnsureGadBranchSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  branchId: z.string(),
  channelId: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  metadata: OptionalJsonRecordSchema,
}).strict();

const GadHistoryItemSchema = z.object({
  kind: z.enum([
    "message_created",
    "message_block_added",
    "message_finalized",
    "tool_call_requested",
    "tool_result_observed",
    "file_observed",
    "file_read",
    "file_mutation",
    "workspace_observed",
    "approval_requested",
    "approval_resolved",
    "dispatch_abandoned",
    "branch_created",
    "snapshot_marked",
    "claim_asserted",
    "claim_revised",
    "contradiction_detected",
    "theory_updated",
    "system_event",
  ]),
  actor: z.string().nullable().optional(),
  payload: z.union([JsonRecordSchema, z.string()]).nullable().optional(),
  messageId: z.string().nullable().optional(),
  blockId: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  inputStateHash: z.string().nullable().optional(),
  outputStateHash: z.string().nullable().optional(),
  metadata: OptionalJsonRecordSchema,
}).strict();

const AppendGadHistoryBatchSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  branchId: z.string(),
  expectedHeadHash: z.string().nullable().optional(),
  expectedStateHash: z.string().nullable().optional(),
  items: z.array(GadHistoryItemSchema),
}).strict();

const BranchHeadSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  branchId: z.string(),
}).strict();

const ForkGadBranchSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  sourceBranchId: z.string(),
  newBranchId: z.string().nullable().optional(),
  historyHash: z.string().nullable().optional(),
  historyId: z.number().int().nullable().optional(),
  channelId: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
}).strict();

const BranchIdSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  branchId: z.string(),
}).strict();

const BranchListOptsSchema = BranchIdSchema.extend({
  limit: z.number().int().positive().optional(),
}).strict();

const StateProducerSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  stateHash: z.string(),
  branchId: z.string().nullable().optional(),
}).strict();

const BlameSnippetSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  stateHash: z.string().nullable().optional(),
  fileVersionId: z.number().int().nullable().optional(),
  path: z.string(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
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
    policy: { allowed: ["panel", "worker", "shell", "server"] },
    methods: {
      rawSql: { args: z.tuple([z.string(), JsonBindingsSchema]) },
      query: { args: z.tuple([z.string(), JsonBindingsSchema]) },
      status: { args: z.tuple([]) },
      ensureBlob: { args: z.tuple([z.string(), z.number().int().optional(), z.string().nullable().optional()]) },
      ensureGadBranch: { args: z.tuple([EnsureGadBranchSchema]) },
      getGadBranchHead: { args: z.tuple([BranchHeadSchema]) },
      appendGadHistoryBatch: { args: z.tuple([AppendGadHistoryBatchSchema]) },
      materializePiMessages: { args: z.tuple([BranchHeadSchema]) },
      listGadBranchTrajectory: { args: z.tuple([BranchListOptsSchema]) },
      listGadBranchHistory: { args: z.tuple([BranchListOptsSchema]) },
      listGadBranchToolCalls: { args: z.tuple([BranchListOptsSchema]) },
      forkGadBranch: { args: z.tuple([ForkGadBranchSchema]) },
      listGadBranches: { args: z.tuple([ListOptsSchema]) },
      listGadBranchFiles: { args: z.tuple([BranchIdSchema]) },
      diffGadStates: { args: z.tuple([z.object({
        workspaceId: z.string().nullable().optional(),
        leftStateHash: z.string(),
        rightStateHash: z.string(),
      }).strict()]) },
      readGadFileAtState: { args: z.tuple([z.object({
        workspaceId: z.string().nullable().optional(),
        stateHash: z.string(),
        path: z.string(),
      }).strict()]) },
      getGadToolProvenance: { args: z.tuple([z.object({
        workspaceId: z.string().nullable().optional(),
        branchId: z.string(),
        toolCallId: z.string(),
      }).strict()]) },
      getGadStateProducer: { args: z.tuple([StateProducerSchema]) },
      blameGadFileSnippet: { args: z.tuple([BlameSnippetSchema]) },
      enqueueGadIndexJob: { args: z.tuple([z.object({
        workspaceId: z.string().nullable().optional(),
        sourceHash: z.string(),
        sourceKind: z.string(),
        jobKind: z.string(),
      }).strict()]) },
      processGadIndexJobs: { args: z.tuple([ListOptsSchema]) },
      rebuildGadReadModels: { args: z.tuple([BranchHeadSchema]) },
      validateGadHashes: { args: z.tuple([ListOptsSchema]) },
      clearDirtyAfterValidation: { args: z.tuple([ListOptsSchema]) },
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
        case "ensureGadBranch":
        case "getGadBranchHead":
        case "appendGadHistoryBatch":
        case "materializePiMessages":
        case "listGadBranchTrajectory":
        case "listGadBranchHistory":
        case "listGadBranchToolCalls":
        case "forkGadBranch":
        case "listGadBranches":
        case "listGadBranchFiles":
        case "diffGadStates":
        case "readGadFileAtState":
        case "getGadToolProvenance":
        case "getGadStateProducer":
        case "blameGadFileSnippet":
        case "enqueueGadIndexJob":
        case "processGadIndexJobs":
        case "rebuildGadReadModels":
        case "validateGadHashes":
        case "clearDirtyAfterValidation":
          return dispatch(method, args);
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
