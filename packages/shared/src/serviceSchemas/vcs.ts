import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

const nullableString = z.string().nullable();

export const vcsFileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted"]),
});

export const VcsUnitStatusSchema = z.object({
  unitPath: z.string(),
  head: z.string(),
  stateHash: nullableString,
  dirty: z.boolean(),
  files: z.array(vcsFileStatusSchema),
});
export type VcsUnitStatus = z.infer<typeof VcsUnitStatusSchema>;

export const vcsFileWriteContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bytes"), base64: z.string() }),
]);
export type VcsFileWriteContent = z.infer<typeof vcsFileWriteContentSchema>;

export const vcsFileReadContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bytes"), base64: z.string() }),
]);
export type VcsFileReadContent = z.infer<typeof vcsFileReadContentSchema>;

export const vcsEditOpSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replace"),
    path: z.string(),
    hunks: z.array(
      z.object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        oldText: z.string().optional(),
        newText: z.string(),
      })
    ),
  }),
  z.object({
    kind: z.literal("write"),
    path: z.string(),
    content: vcsFileWriteContentSchema,
    mode: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("create"),
    path: z.string(),
    content: vcsFileWriteContentSchema,
    mode: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("delete"), path: z.string() }),
  z.object({ kind: z.literal("chmod"), path: z.string(), mode: z.number().int() }),
]);
export type VcsEditOp = z.infer<typeof vcsEditOpSchema>;

export const vcsApplyEditsInputSchema = z.object({
  baseStateHash: z.string().optional(),
  edits: z.array(vcsEditOpSchema),
  head: z.string().optional(),
});
export type VcsApplyEditsInput = z.infer<typeof vcsApplyEditsInputSchema>;

export const vcsMergeConflictSchema = z.object({
  path: z.string(),
  kind: z.enum(["content", "binary", "delete-vs-change", "mode"]),
});
export type VcsMergeConflict = z.infer<typeof vcsMergeConflictSchema>;

export const vcsApplyEditsResultSchema = z.object({
  head: z.string(),
  stateHash: z.string(),
  eventId: nullableString,
  headHash: nullableString,
  status: z.enum(["clean", "conflicted"]),
  conflicts: z.array(vcsMergeConflictSchema),
  changedPaths: z.array(z.string()),
});
export type VcsApplyEditsResult = z.infer<typeof vcsApplyEditsResultSchema>;

/**
 * Status is a pure GAD state-diff of a head against its publish baseline
 * (`main`): the unpublished changes that live on this head. It is NOT a
 * filesystem scan — the on-disk worktree is a disposable projection of the
 * head, so edits (which commit through `applyEdits`) never appear as "dirty".
 * `stateHash` is the head's current state; `dirty` is true iff the head is
 * ahead of `main`. Status on `main` is always clean (it is the baseline).
 */
export const vcsStatusResultSchema = z.object({
  stateHash: nullableString,
  dirty: z.boolean(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type VcsStatusResult = z.infer<typeof vcsStatusResultSchema>;

export const vcsLogEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  envelopeId: z.string(),
  actor: z.unknown(),
  summary: nullableString,
  outputStateHash: nullableString,
  appendedAt: z.string(),
});
export type VcsLogEntry = z.infer<typeof vcsLogEntrySchema>;

export const vcsDiffResultSchema = z.object({
  added: z.array(z.unknown()),
  removed: z.array(z.unknown()),
  changed: z.array(z.unknown()),
});
export type VcsDiffResult = z.infer<typeof vcsDiffResultSchema>;

export const vcsResolveHeadResultSchema = z.object({
  head: z.string(),
  stateHash: nullableString,
});
export type VcsResolveHeadResult = z.infer<typeof vcsResolveHeadResultSchema>;

export const vcsMergeResultSchema = z.object({
  status: z.enum(["up-to-date", "merged", "conflicted"]),
  stateHash: nullableString,
  conflicts: z.array(vcsMergeConflictSchema),
});
export type VcsMergeResult = z.infer<typeof vcsMergeResultSchema>;

export const vcsPendingMergeSchema = z
  .object({
    theirsHead: z.string(),
    conflicts: z.array(vcsMergeConflictSchema),
  })
  .nullable();
export type VcsPendingMerge = z.infer<typeof vcsPendingMergeSchema>;

export const vcsFileContentSchema = z.object({
  content: vcsFileReadContentSchema,
  stateHash: z.string(),
  contentHash: z.string(),
  mode: z.number().int(),
  size: z.number().int().nonnegative(),
});
export type VcsFileContent = z.infer<typeof vcsFileContentSchema>;

export const vcsFileListEntrySchema = z.object({
  path: z.string(),
  contentHash: z.string(),
  mode: z.number().int(),
});
export type VcsFileListEntry = z.infer<typeof vcsFileListEntrySchema>;

export const vcsPublishStatusSchema = z.object({
  head: z.string(),
  ctxStateHash: nullableString,
  mainStateHash: nullableString,
  ahead: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["added", "removed", "changed"]),
    })
  ),
});
export type VcsPublishStatus = z.infer<typeof vcsPublishStatusSchema>;

const vcsHeadAdvanceActorSchema = z.object({ id: z.string(), kind: z.string() }).nullable();

export const vcsHeadAdvanceSchema = z.object({
  head: z.string(),
  stateHash: z.string(),
  sinceStateHash: nullableString,
  eventId: nullableString,
  headHash: nullableString,
  actor: vcsHeadAdvanceActorSchema,
  transitionKind: z.enum(["snapshot", "edit", "merge", "merge-resolution"]),
  changedPaths: z.array(z.string()),
  fileChanges: z.array(
    z.object({
      kind: z.enum(["added", "removed", "changed"]),
      path: z.string(),
      oldContentHash: nullableString,
      newContentHash: nullableString,
      oldMode: z.number().int().nullable(),
      newMode: z.number().int().nullable(),
    })
  ),
  editOps: z.array(
    z.object({
      kind: z.enum(["replace", "write", "create", "delete", "chmod"]),
      path: z.string(),
      oldContentHash: nullableString,
      newContentHash: nullableString,
      hunks: z.unknown().optional(),
      mode: z.number().int().nullable().optional(),
    })
  ),
});
export type VcsHeadAdvance = z.infer<typeof vcsHeadAdvanceSchema>;

export const vcsRecallInputSchema = z.object({
  query: z.string(),
  kinds: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});
export type VcsRecallInput = z.infer<typeof vcsRecallInputSchema>;

export const vcsRecallResultSchema = z.object({
  results: z.array(
    z.object({
      kind: z.string(),
      snippet: z.string(),
      score: z.number().nullable(),
      logId: nullableString,
      head: nullableString,
      eventId: nullableString,
      path: nullableString,
      contentHash: nullableString,
      anchor: z.record(z.unknown()).nullable(),
      actor: z.unknown(),
      appendedAt: nullableString,
    })
  ),
});
export type VcsRecallResult = z.infer<typeof vcsRecallResultSchema>;

export const vcsMethods = defineServiceMethods({
  applyEdits: {
    args: z.tuple([vcsApplyEditsInputSchema]),
    returns: vcsApplyEditsResultSchema,
  },
  readFile: {
    args: z.tuple([z.string(), z.string()]),
    returns: vcsFileContentSchema.nullable(),
  },
  listFiles: {
    args: z.tuple([z.string().optional()]),
    returns: z.array(vcsFileListEntrySchema),
  },
  revert: {
    args: z.tuple([
      z.object({
        stateHash: z.string().optional(),
        eventId: z.string().optional(),
        head: z.string().optional(),
      }),
    ]),
    returns: vcsApplyEditsResultSchema,
  },
  status: {
    args: z.tuple([z.string().optional()]),
    returns: vcsStatusResultSchema,
  },
  unitStatus: {
    args: z.tuple([z.string(), z.string().optional()]),
    returns: VcsUnitStatusSchema,
  },
  log: {
    args: z.tuple([z.number().optional(), z.string().optional()]),
    returns: z.array(vcsLogEntrySchema),
  },
  diff: {
    args: z.tuple([z.string(), z.string()]),
    returns: vcsDiffResultSchema,
  },
  resolveHead: {
    args: z.tuple([z.string()]),
    returns: vcsResolveHeadResultSchema,
  },
  merge: {
    args: z.tuple([z.string(), z.string().optional()]),
    returns: vcsMergeResultSchema,
  },
  abortMerge: {
    args: z.tuple([z.string().optional()]),
    returns: z.object({ aborted: z.boolean() }),
  },
  pendingMerge: {
    args: z.tuple([z.string().optional()]),
    returns: vcsPendingMergeSchema,
  },
  publishStatus: {
    args: z.tuple([z.string().optional()]),
    returns: vcsPublishStatusSchema,
  },
  publish: {
    args: z.tuple([z.string().optional()]),
    returns: vcsMergeResultSchema,
  },
  recall: {
    args: z.tuple([vcsRecallInputSchema]),
    returns: vcsRecallResultSchema,
  },
});
export type VcsMethods = typeof vcsMethods;
