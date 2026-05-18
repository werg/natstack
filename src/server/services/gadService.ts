import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError } from "@natstack/shared/serviceDispatcher";
import type { DODispatch } from "../doDispatch.js";
import type { DORef } from "../doDispatch.js";

const JsonRecordSchema = z.record(z.unknown());
const OptionalJsonRecordSchema = JsonRecordSchema.nullish();
const JsonBindingsSchema = z.array(z.unknown()).optional();
const ListOptsSchema = z.record(z.unknown()).optional();

const EnsurePiBranchSchema = z
  .object({
    branchId: z.string(),
    channelId: z.string().nullable().optional(),
    metadata: OptionalJsonRecordSchema,
  })
  .strict();

const PiEntrySchema = z
  .object({
    entryId: z.string(),
    parentEntryId: z.string().nullable(),
    entryType: z.enum([
      "message",
      "model_change",
      "thinking_level_change",
      "compaction",
      "branch_summary",
      "custom",
      "custom_message",
      "label",
      "session_info",
    ]),
    actor: z.string().nullable().optional(),
    payload: JsonRecordSchema,
    preStateHash: z.string().nullable().optional(),
    postStateHash: z.string().nullable().optional(),
    metadata: OptionalJsonRecordSchema,
  })
  .strict();

const AppendPiEntryBatchSchema = z
  .object({
    branchId: z.string(),
    expectedHeadEntryHash: z.string().nullable().optional(),
    expectedStateHash: z.string().nullable().optional(),
    items: z.array(PiEntrySchema),
  })
  .strict();

const GadEventSchema = z
  .object({
    eventId: z.string(),
    kind: z.string(),
    anchorKind: z.string().nullable().optional(),
    anchorId: z.string().nullable().optional(),
    payload: JsonRecordSchema,
    metadata: OptionalJsonRecordSchema,
  })
  .strict();

const AppendGadEventsSchema = z.object({ events: z.array(GadEventSchema) }).strict();

const BranchHeadSchema = z
  .object({
    branchId: z.string(),
  })
  .strict();

const SetBranchHeadSchema = BranchHeadSchema.extend({
  entryId: z.string().nullable(),
  expectedHeadEntryHash: z.string().nullable().optional(),
}).strict();

const GetEntryByIdSchema = z
  .object({
    entryId: z.string(),
  })
  .strict();

const GetBranchPathSchema = BranchHeadSchema.extend({
  throughEntryId: z.string().nullable().optional(),
}).strict();

const FindBranchEntriesByTypeSchema = BranchHeadSchema.extend({
  entryType: z.string(),
  offset: z.number().int().nonnegative().nullable().optional(),
  limit: z.number().int().positive().nullable().optional(),
}).strict();

const ForkGadBranchSchema = z
  .object({
    sourceBranchId: z.string(),
    newBranchId: z.string().nullable().optional(),
    entryId: z.string().nullable().optional(),
    stateHash: z.string().nullable().optional(),
    channelId: z.string().nullable().optional(),
  })
  .strict();

const BranchIdSchema = z
  .object({
    branchId: z.string(),
  })
  .strict();

const BranchListOptsSchema = BranchIdSchema.extend({
  limit: z.number().int().positive().nullable().optional(),
}).strict();

const StateProducerSchema = z
  .object({
    workspaceId: z.string().nullable().optional(),
    stateHash: z.string(),
    branchId: z.string().nullable().optional(),
  })
  .strict();

const BlameSnippetSchema = z
  .object({
    workspaceId: z.string().nullable().optional(),
    stateHash: z.string().nullable().optional(),
    fileVersionId: z.number().int().nullable().optional(),
    path: z.string(),
    startLine: z.number().int().positive().nullable().optional(),
    endLine: z.number().int().positive().nullable().optional(),
  })
  .strict();

const IntegrityCheckSchema = z
  .object({
    workspaceId: z.string().nullable().optional(),
    branchId: z.string().nullable().optional(),
  })
  .strict();

export interface GadServiceDeps {
  doDispatch: DODispatch;
  resolveStore: () => DORef;
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
  const first = stripLeadingSqlTrivia(sql)
    .match(/^[A-Za-z]+/u)?.[0]
    ?.toUpperCase();
  // Keep this deliberately narrow. SQLite supports mutating statements with
  // WITH/PRAGMA shapes, so arbitrary raw SQL is blocked unless it is a plain
  // read/explain.
  return first === "SELECT" || first === "EXPLAIN";
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
      ensureBlob: {
        args: z.tuple([z.string(), z.number().int().optional(), z.string().nullable().optional()]),
      },
      ensurePiBranch: { args: z.tuple([EnsurePiBranchSchema]) },
      getPiBranchHead: { args: z.tuple([BranchHeadSchema]) },
      appendPiEntryBatch: { args: z.tuple([AppendPiEntryBatchSchema]) },
      appendGadEvents: { args: z.tuple([AppendGadEventsSchema]) },
      listGadEvents: { args: z.tuple([ListOptsSchema]) },
      setBranchHead: { args: z.tuple([SetBranchHeadSchema]) },
      getEntryById: { args: z.tuple([GetEntryByIdSchema]) },
      getBranchPath: { args: z.tuple([GetBranchPathSchema]) },
      findEntries: { args: z.tuple([FindBranchEntriesByTypeSchema]) },
      materializePiMessages: { args: z.tuple([BranchHeadSchema]) },
      listGadBranchToolCalls: { args: z.tuple([BranchListOptsSchema]) },
      forkPiBranch: { args: z.tuple([ForkGadBranchSchema]) },
      listPiBranches: { args: z.tuple([ListOptsSchema]) },
      listGadBranchFiles: { args: z.tuple([BranchIdSchema]) },
      diffGadStates: {
        args: z.tuple([
          z
            .object({
              workspaceId: z.string().nullable().optional(),
              leftStateHash: z.string(),
              rightStateHash: z.string(),
            })
            .strict(),
        ]),
      },
      readGadFileAtState: {
        args: z.tuple([
          z
            .object({
              workspaceId: z.string().nullable().optional(),
              stateHash: z.string(),
              path: z.string(),
            })
            .strict(),
        ]),
      },
      getGadToolProvenance: {
        args: z.tuple([
          z
            .object({
              workspaceId: z.string().nullable().optional(),
              branchId: z.string(),
              toolCallId: z.string(),
            })
            .strict(),
        ]),
      },
      getGadStateProducer: { args: z.tuple([StateProducerSchema]) },
      blameGadFileSnippet: { args: z.tuple([BlameSnippetSchema]) },
      enqueueGadIndexJob: {
        args: z.tuple([
          z
            .object({
              workspaceId: z.string().nullable().optional(),
              sourceHash: z.string(),
              sourceKind: z.string(),
              jobKind: z.string(),
            })
            .strict(),
        ]),
      },
      processGadIndexJobs: { args: z.tuple([ListOptsSchema]) },
      claimGadIndexJobs: { args: z.tuple([ListOptsSchema]) },
      completeGadIndexJob: { args: z.tuple([z.object({ id: z.number().int() }).strict()]) },
      failGadIndexJob: {
        args: z.tuple([
          z
            .object({
              id: z.number().int(),
              error: z.string(),
              retry: z.boolean().nullable().optional(),
            })
            .strict(),
        ]),
      },
      listGadIndexJobs: { args: z.tuple([ListOptsSchema]) },
      validateGadHashes: { args: z.tuple([ListOptsSchema]) },
      clearDirtyAfterValidation: { args: z.tuple([ListOptsSchema]) },
      checkGadIntegrity: { args: z.tuple([IntegrityCheckSchema.optional()]) },
      replayGadEvents: { args: z.tuple([ListOptsSchema.optional()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "rawSql":
        case "query": {
          const sql = args[0] as string;
          const bindings = (args[1] as unknown[] | undefined) ?? [];
          if (!isReadOnlySql(sql)) {
            throw new ServiceError(
              "gad",
              method,
              "raw SQL writes are disabled for the clean GAD architecture",
              "EACCES"
            );
          }
          return dispatch("rawSql", [sql, bindings]);
        }
        case "status":
          return dispatch("getStatus", []);
        case "ensureBlob":
          return dispatch("ensureBlob", args);
        case "ensurePiBranch":
        case "getPiBranchHead":
        case "appendPiEntryBatch":
        case "appendGadEvents":
        case "listGadEvents":
        case "setBranchHead":
        case "getEntryById":
        case "getBranchPath":
        case "findEntries":
        case "materializePiMessages":
        case "listGadBranchToolCalls":
        case "forkPiBranch":
        case "listPiBranches":
        case "listGadBranchFiles":
        case "diffGadStates":
        case "readGadFileAtState":
        case "getGadToolProvenance":
        case "getGadStateProducer":
        case "blameGadFileSnippet":
        case "enqueueGadIndexJob":
        case "processGadIndexJobs":
        case "claimGadIndexJobs":
        case "completeGadIndexJob":
        case "failGadIndexJob":
        case "listGadIndexJobs":
        case "validateGadHashes":
        case "clearDirtyAfterValidation":
        case "checkGadIntegrity":
        case "replayGadEvents":
          return dispatch(method, args);
        default:
          throw new ServiceError("gad", method, `Unknown gad method: ${method}`, "ENOSYS");
      }
    },
  };
}
