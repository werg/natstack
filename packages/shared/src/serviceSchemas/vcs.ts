import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

const nullableString = z.string().nullable();

// Access descriptors shared across the read/write method groups. The legacy
// caller-kind gate stays on the service `policy` (allowed: shell/panel/app/
// server/worker/do/extension), so these carry only doc/safety metadata
// (sensitivity) and deliberately OMIT `callers`.
//
// Reads are pure projections of committed GAD state (status/log/diff/readFile/
// resolveHead/recall). Writes commit through GAD and advance a head
// (applyEdits/revert/merge/abortMerge/publish).
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

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

const vcsEditOpStrictSchema = z.discriminatedUnion("kind", [
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

/**
 * Normalize ergonomic edit shorthands → the strict discriminated union, so agents can write the
 * natural `{ path, content: "text" }` form rather than the verbose
 * `{ kind: "write", path, content: { kind: "text", text } }`:
 *  - a string `content` → `{ kind: "text", text }`
 *  - an omitted `kind` (when a `content` is present) → defaults to `"write"`
 * Genuinely-malformed edits (no `kind`, no `content`) pass through untouched so the discriminated
 * union still reports its precise discriminator error. The strict union is what serializes into
 * `help('vcs')` (zod-to-json-schema renders the inner schema of a preprocess), so discovery is
 * unchanged — the shorthand is an accepted superset, not a replacement.
 */
function normalizeVcsEditOp(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const e = raw as Record<string, unknown>;
  // Fail LOUD on a mis-keyed discriminator: an edit op has no `type` field, so `type` present
  // without `kind` is almost always a wrong-key mistake. Silently defaulting it to "write" (below)
  // would discard the intended op — e.g. `{ type: "replace", content }` would quietly become a
  // write. Surface the fix instead of guessing.
  if (e["kind"] === undefined && typeof e["type"] === "string") {
    throw new Error(
      `vcs edit op is missing "kind" but has type:"${e["type"]}" — edit ops are discriminated by ` +
        `"kind", not "type" (use { kind: "write" | "replace" | "create" | "delete" | "chmod", path, … }).`
    );
  }
  const asContent = (c: unknown) => (typeof c === "string" ? { kind: "text", text: c } : c);
  if (e["kind"] === "write" || e["kind"] === "create") {
    return typeof e["content"] === "string" ? { ...e, content: asContent(e["content"]) } : raw;
  }
  if (e["kind"] === undefined && e["content"] !== undefined) {
    return { ...e, kind: "write", content: asContent(e["content"]) };
  }
  return raw;
}

export const vcsEditOpSchema = z.preprocess(normalizeVcsEditOp, vcsEditOpStrictSchema);
export type VcsEditOp = z.infer<typeof vcsEditOpStrictSchema>;

export const vcsApplyEditsInputSchema = z.object({
  baseStateHash: z
    .string()
    .optional()
    .describe(
      "Optimistic-concurrency base: the head state the edits were computed against (a `state:…` hash). Omit to apply against the head's current state."
    ),
  edits: z
    .array(vcsEditOpSchema)
    .describe(
      'Ordered edit ops applied as one atomic commit. Each op is discriminated by `kind` (replace/write/create/delete/chmod); `{ path, content: "…" }` is accepted shorthand for a write.'
    ),
  head: z
    .string()
    .optional()
    .describe(
      "Head to commit onto. Omit for the caller's own context head; entity callers may only write their own `ctx:…` head."
    ),
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
  query: z
    .string()
    .describe("Free-text query matched against indexed VCS memory (log summaries, file snippets)."),
  kinds: z
    .array(z.string())
    .optional()
    .describe("Restrict results to these memory entry kinds; omit to search across all kinds."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of results to return (1–50, default applied server-side)."),
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
    description:
      "Apply a batch of file edits as one atomic GAD commit onto the caller's head, advancing it; returns the new head state plus any merge conflicts and the changed paths.",
    args: z.tuple([vcsApplyEditsInputSchema]),
    returns: vcsApplyEditsResultSchema,
    access: WRITE_ACCESS,
    examples: [
      {
        args: [
          {
            edits: [
              { kind: "write", path: "notes.md", content: { kind: "text", text: "# Notes\n" } },
            ],
          },
        ],
      },
    ],
  },
  readFile: {
    description:
      "Read one file's content (text or base64 bytes) at a VCS ref, with its state/content hashes and mode; returns null if the path is absent. Empty ref ⇒ the caller's current head.",
    args: z.tuple([z.string(), z.string()]),
    returns: vcsFileContentSchema.nullable(),
    access: READ_ACCESS,
    examples: [{ args: ["", "notes.md"] }],
  },
  listFiles: {
    description:
      "List every file (path, content hash, mode) at a VCS ref; omit the ref for the caller's current head.",
    args: z.tuple([z.string().optional()]),
    returns: z.array(vcsFileListEntrySchema),
    access: READ_ACCESS,
  },
  revert: {
    description:
      "Undo a prior change by forward-applying its inverse patch onto the caller's head, advancing it; target the change by state hash or event id.",
    args: z.tuple([
      z.object({
        stateHash: z
          .string()
          .optional()
          .describe("Target the change that produced this `state:…` hash."),
        eventId: z
          .string()
          .optional()
          .describe("Target the change by its log event id instead of a state hash."),
        head: z
          .string()
          .optional()
          .describe(
            "Head to revert on. Omit for the caller's own context head; entity callers may only write their own `ctx:…` head."
          ),
      }),
    ]),
    returns: vcsApplyEditsResultSchema,
    access: { ...WRITE_ACCESS, sensitivity: "destructive" },
    examples: [{ args: [{ eventId: "evt-123" }] }],
  },
  status: {
    description:
      "Unpublished changes on a head relative to its publish baseline (main): the added/removed/changed paths plus the head state and whether it is ahead of main. Not a filesystem scan. Omit the head for the caller's current context head.",
    args: z.tuple([z.string().optional()]),
    returns: vcsStatusResultSchema,
    access: READ_ACCESS,
  },
  unitStatus: {
    description:
      "Status scoped to a single workspace unit (repo path): the unit's head, state hash, dirty flag, and per-file changes. Omit the head for the caller's current context head.",
    args: z.tuple([z.string(), z.string().optional()]),
    returns: VcsUnitStatusSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/spectrolite"] }],
  },
  log: {
    description:
      "Commit log for a head, most recent first, capped by limit (default 50). Omit the head for the caller's current context head.",
    args: z.tuple([z.number().optional(), z.string().optional()]),
    returns: z.array(vcsLogEntrySchema),
    access: READ_ACCESS,
    examples: [{ args: [10] }],
  },
  diff: {
    description:
      "Diff two GAD states by their `state:…` hashes, returning the added/removed/changed files between them.",
    args: z.tuple([z.string(), z.string()]),
    returns: vcsDiffResultSchema,
    access: READ_ACCESS,
  },
  resolveHead: {
    description:
      'Resolve a ref to its head name and current `state:…` hash. Omit the ref for the caller\'s current context head; pass "main"/"ctx:…" for an explicit ref.',
    args: z.tuple([z.string().optional()]),
    returns: vcsResolveHeadResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["main"] }],
  },
  merge: {
    description:
      "Merge a source head into a target head (default: the caller's own head), advancing the target; returns up-to-date/merged/conflicted plus any conflicts. The target is a head write.",
    args: z.tuple([z.string(), z.string().optional()]),
    returns: vcsMergeResultSchema,
    access: { ...WRITE_ACCESS },
    examples: [{ args: ["main"] }],
  },
  abortMerge: {
    description:
      "Abort a pending (conflicted) merge on a head, restoring its pre-merge tree; this is itself a head write. Omit the head for the caller's current context head.",
    args: z.tuple([z.string().optional()]),
    returns: z.object({ aborted: z.boolean() }),
    access: { ...WRITE_ACCESS },
  },
  pendingMerge: {
    description:
      "Inspect a head's in-progress merge, if any: the source head being merged and its unresolved conflicts; null when no merge is pending. Omit the head for the caller's current context head.",
    args: z.tuple([z.string().optional()]),
    returns: vcsPendingMergeSchema,
    access: READ_ACCESS,
  },
  publishStatus: {
    description:
      "How far a head is ahead of main: the unpublished commit count and the per-file changes that a publish would carry. Omit the head for the caller's current context head.",
    args: z.tuple([z.string().optional()]),
    returns: vcsPublishStatusSchema,
    access: READ_ACCESS,
  },
  publish: {
    description:
      "Publish the caller's own context head into main by merging it (the one sanctioned ctx→main escalation; autonomous agents are user-approval gated). Returns merged/conflicted; a conflicted publish is rolled back, leaving main untouched.",
    args: z.tuple([z.string().optional()]),
    returns: vcsMergeResultSchema,
    access: { ...WRITE_ACCESS, sensitivity: "admin" },
  },
  recall: {
    description:
      "Semantic recall over the workspace's VCS memory (log summaries, file snippets) matching a query; returns ranked snippets with their head/event/path anchors.",
    args: z.tuple([vcsRecallInputSchema]),
    returns: vcsRecallResultSchema,
    access: READ_ACCESS,
    examples: [{ args: [{ query: "auth flow refactor", limit: 5 }] }],
  },
});
export type VcsMethods = typeof vcsMethods;
