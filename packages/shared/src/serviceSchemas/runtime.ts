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
      // Declares the handler's cross-context approval gate
      // (resolveContextPolicy → requestCapabilityPermission for
      // RUNTIME_CROSS_CONTEXT_ENTITY when the target context differs).
      approval: [
        {
          when: "creating in a different context than the caller",
          capability: "runtime.crossContextEntity",
          operation: { kind: "runtime", verb: "Create runtime entity" },
          reason: "cross-context entity creation requires approval",
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
});
