/**
 * Wire schema for the server "runtime" entity lifecycle service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the runtime method groups. `callers` is left
// unset (the legacy `policy` stays the gate during migration); these carry
// sensitivity doc + metadata.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const RETIRE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};
const TITLE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const RuntimeEntityHandleSchema = z
  .object({
    id: z.string().describe("Server-authoritative canonical entity id."),
    kind: z
      .enum(["panel", "app", "worker", "do", "session"])
      .describe("Entity kind that was created."),
    source: z
      .object({
        repoPath: z.string().describe("Workspace-relative source repo path."),
        effectiveVersion: z
          .string()
          .describe("Resolved build/state version this entity is pinned to."),
      })
      .strict()
      .describe("Resolved source identity (repo path + effective version)."),
    contextId: z.string().describe("Context (working-tree) this entity belongs to."),
    targetId: z
      .string()
      .describe(
        "Runtime target handle: the workerd target for do/worker; the canonical id otherwise."
      ),
  })
  .strict();

const BuildRefSchema = z
  .string()
  .describe(
    'Optional code build ref. Omit to use the main build; pass "ctx:<contextId>" or "state:<stateHash>" only for targeted builds.'
  );

export const CreateEntitySpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("panel"),
    source: z.string().describe("Workspace-relative panel source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one in the caller's context."),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the panel runtime."),
  }),
  z.object({
    kind: z.literal("app"),
    source: z.string().describe("Workspace-relative app source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one in the caller's context."),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the app runtime."),
  }),
  z.object({
    kind: z.literal("worker"),
    source: z.string().describe("Workspace-relative worker source repo path."),
    ref: BuildRefSchema.optional(),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one in the caller's context."),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    stateArgs: z
      .unknown()
      .optional()
      .describe("Opaque initial state passed to the worker runtime."),
    env: z.record(z.string()).optional().describe("Extra environment variables for the worker."),
  }),
  z.object({
    kind: z.literal("do"),
    source: z.string().describe("Workspace-relative DO source repo path."),
    ref: BuildRefSchema.optional(),
    className: z.string().describe("Durable Object class name exported by the source."),
    key: z.string().optional().describe("Stable instance key; omit to mint a random UUID."),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one in the caller's context."),
    stateArgs: z.unknown().optional().describe("Opaque initial state passed to the DO runtime."),
  }),
  z.object({
    kind: z.literal("session"),
    source: z.string().describe("Logical session source label (e.g. an agent CLI name)."),
    contextId: z
      .string()
      .nullable()
      .optional()
      .describe("Target context; omit/null to mint a fresh one (reused on key re-attach)."),
    key: z.string().optional().describe("Stable session key; omit to mint a random UUID."),
    title: z.string().optional().describe("Display title surfaced by approval UIs."),
  }),
]);

/** Wire shape of a full logical workspace context branch. */
export const WorkspaceContextSchema = z
  .object({
    contextId: z.string().describe("Context id for a full logical workspace branch view."),
  })
  .strict();

/** One source→clone entity mapping produced by `cloneContext`. */
export const ClonedEntitySchema = z
  .object({
    sourceId: z.string().describe("Canonical id of the source entity that was cloned."),
    newId: z.string().describe("Canonical id of the freshly-created clone in the new context."),
    kind: z.enum(["worker", "do"]).describe("Cloned entity kind (only durable kinds are cloned)."),
    source: z.string().describe("Shared source repo path (clone runs the same code)."),
    className: z.string().optional().describe("DO class name (present for kind 'do')."),
    sourceKey: z.string().describe("The source entity's instance key."),
    newKey: z.string().describe("The clone's freshly-minted instance key."),
    targetId: z.string().describe("Runtime target handle of the clone (workerd target)."),
  })
  .strict();

/** Wire shape of a `cloneContext` result: the new context + the source→clone map. */
export const CloneContextResultSchema = z
  .object({
    contextId: z.string().describe("The freshly-minted, isolated context holding the clones."),
    entities: z
      .array(ClonedEntitySchema)
      .describe("Source→clone mapping for every cloned worker/DO, in clone order."),
  })
  .strict();

export type ClonedEntity = z.infer<typeof ClonedEntitySchema>;
export type CloneContextResult = z.infer<typeof CloneContextResultSchema>;

export const runtimeMethods = defineServiceMethods({
  createEntity: {
    description:
      "Create a runtime entity (panel, app, worker, DO, or session) and commit its durable identity. Reuses/reactivates an existing row for the same canonical key. Returns the entity handle (id + runtime targetId).",
    args: z.tuple([CreateEntitySpecSchema]),
    returns: RuntimeEntityHandleSchema,
    access: {
      sensitivity: "write",
      // Declares the handler's gate (createEntity rejects app/session for
      // non-shell/non-server callers with "host-managed").
      restrictedTo: [
        {
          when: "spec.kind is 'app' or 'session'",
          callers: ["shell", "server"],
          reason: "app/session runtime entities are host-managed",
        },
      ],
      // Declares the handler's context-boundary approval gate
      // (resolveContextPolicy → requireContextBoundaryPermission). Fires only
      // when the target context is BOTH foreign to the caller AND already exists;
      // same-context and fresh-context launches are free, as is trusted chrome.
      approval: [
        {
          when: "launching into another, already-existing context than the caller",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Create runtime entity" },
          reason: "launching code into another agent or panel's existing context requires approval",
        },
      ],
    },
    examples: [
      { args: [{ kind: "do", source: "workers/agent", className: "AgentDO", key: "agent-1" }] },
      { args: [{ kind: "session", source: "agent-cli", key: "s1", title: "My agent session" }] },
    ],
  },
  retireEntity: {
    description:
      "Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context.",
    args: z.tuple([
      z.object({
        id: z.string().describe("Canonical id of the entity to retire."),
        removeContext: z
          .boolean()
          .optional()
          .describe("Also delete the context folder if no other live entity shares it."),
      }),
    ]),
    returns: z.void(),
    access: RETIRE_ACCESS,
    examples: [{ args: [{ id: "do:workers/agent:AgentDO:agent-1", removeContext: true }] }],
  },
  listEntities: {
    description: "List live entities (id, kind, source, contextId, title, createdAt).",
    args: z.tuple([
      z.object({
        kind: z
          .enum(["panel", "app", "worker", "do", "session"])
          .optional()
          .describe("Filter to a single entity kind; omit to list all kinds."),
      }),
    ]),
    returns: z.array(
      z.object({
        id: z.string().describe("Canonical entity id."),
        kind: z.string().describe("Entity kind."),
        source: z.string().describe("Source repo path."),
        contextId: z.string().describe("Owning context id."),
        title: z.string().optional().describe("Display title, when one has been set."),
        createdAt: z.number().describe("Creation timestamp (epoch ms)."),
      })
    ),
    access: READ_ACCESS,
    examples: [{ args: [{ kind: "session" }] }],
  },
  resolveContext: {
    description:
      "Return the contextId for an entity (or null if unknown). Cached read; falls back to DO.",
    args: z.tuple([z.string().describe("Canonical entity id to resolve.")]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  setTitle: {
    description:
      "Set a server-controlled display title for the calling entity. Surfaced by approval UIs in place of the opaque id. Pass null/empty to clear.",
    args: z.tuple([
      z.string().nullable().describe("New display title; null/empty clears it."),
      z
        .object({
          explicit: z
            .boolean()
            .optional()
            .describe("Mark the title as user-intended (vs. an inferred default)."),
        })
        .optional(),
    ]),
    returns: z.void(),
    // Single source of truth for setTitle's access: only an entity that HAS a title
    // (panel/app/worker/do) may set its own. The dispatcher checks this per-method
    // policy first (checkServiceAccess → getMethodPolicy), so it is the sole gate —
    // the handler performs NO caller-kind rejection. This narrows the service-level
    // policy (which keeps shell/server for createEntity/retireEntity) for setTitle only.
    policy: { allowed: ["panel", "app", "worker", "do"] },
    access: TITLE_ACCESS,
    examples: [{ args: ["Workspace Shell", { explicit: true }] }],
  },
  createContext: {
    description:
      "Create a full logical workspace context branch. Every context presents the whole workspace tree; per-repo ctx heads are created lazily as edits are made. Use vcs.contextStatus to inspect uncommitted changes, ahead/behind repos, and deleted refs.",
    args: z.tuple([
      z.object({
        contextId: z
          .string()
          .optional()
          .describe("Explicit context id; omit to mint a random UUID."),
      }),
    ]),
    returns: WorkspaceContextSchema,
    access: { sensitivity: "write" },
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do"] },
    examples: [{ args: [{}] }, { args: [{ contextId: "agent-branch-1" }] }],
  },
  cloneContext: {
    description:
      "Clone a context's durable state — every worker/DO's storage plus the VCS working snapshot (committed + uncommitted) — into a fresh, isolated context. Returns the new contextId and the source→clone entity map. The caller drives any per-entity rewiring (e.g. a fork re-rooting logs at a point) on the returned clones; the clones are launched parented to the caller, so the caller may freely destroyContext them.",
    args: z.tuple([
      z.object({
        sourceContextId: z.string().describe("Context whose durable state is cloned."),
        include: z
          .array(z.string())
          .optional()
          .describe(
            "Canonical ids of the worker/DO entities to clone; omit to clone every durable entity in the source context. (The file/VCS snapshot is always the whole context.)"
          ),
      }),
    ]),
    returns: CloneContextResultSchema,
    access: {
      sensitivity: "write",
      // Reading + duplicating another context's durable state is gated by the
      // single context-boundary capability: prompts iff the SOURCE context is
      // BOTH foreign to the caller AND already exists. Cloning your own context
      // is free; the freshly-minted target context is always free.
      approval: [
        {
          when: "cloning another, already-existing context than the caller",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Clone context" },
          reason: "cloning another agent or panel's existing context state requires approval",
        },
      ],
    },
    examples: [{ args: [{ sourceContextId: "ctx-abc" }] }],
  },
  destroyContext: {
    description:
      "Retire every entity in a context and delete its folder + VCS state. Free for your own context or one you fully own (every active entity was launched by you); gated when destroying another agent or panel's existing context.",
    args: z.tuple([
      z.object({
        contextId: z.string().describe("Context to destroy (all its entities are retired)."),
      }),
    ]),
    returns: z.void(),
    access: {
      sensitivity: "destructive",
      // Gated by context-boundary, with an ownership bypass: destroying a context
      // whose every active entity you launched (or your own context) is free; only
      // tearing down another agent or panel's existing context prompts.
      approval: [
        {
          when: "destroying another agent or panel's existing context (not one you own)",
          capability: "context.boundary",
          operation: { kind: "runtime", verb: "Destroy context" },
          reason: "destroying another agent or panel's existing context requires approval",
        },
      ],
    },
    examples: [{ args: [{ contextId: "ctx-abc" }] }],
  },
});
