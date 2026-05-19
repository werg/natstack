/**
 * runtime.* — the only path through which entity identities are created or retired.
 *
 * Two-phase: prepare runtime resources (workerd class build, worker spawn, etc.)
 * before committing the durable entity row. A phase-4 failure leaves no row;
 * a phase-5 failure (DO write after runtime up) is reconciled by the next-boot
 * startup sweep.
 *
 * Retirement is server-mediated because cleanup hooks live in Node (egress
 * proxy, approval queue, etc.) and WorkspaceDO is workerd-resident.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import {
  canonicalEntityId,
  type EntityRecord,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
} from "@natstack/shared/runtime/entitySpec";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";

const WORKSPACE_DO_CLASS = "WorkspaceDO";
export const RUNTIME_CROSS_CONTEXT_ENTITY = "runtime.crossContextEntity" as const;

export interface RuntimeEntityHooks {
  /** Prepare runtime resources for a "do" entity. Returns targetId + effectiveVersion. */
  prepareDurableObject: (args: {
    source: string;
    ref: string | undefined;
    className: string;
    key: string;
    contextId: string;
  }) => Promise<{ targetId: string; effectiveVersion: string }>;

  /** Prepare runtime resources for a "worker" entity. */
  prepareWorker: (args: {
    source: string;
    ref: string | undefined;
    key: string;
    contextId: string;
    stateArgs?: unknown;
    env?: Record<string, string>;
  }) => Promise<{ targetId: string; effectiveVersion: string }>;

  /** Resolve effective version for "panel" entities (no runtime prep). */
  resolvePanelEffectiveVersion: (args: {
    source: string;
    ref: string | undefined;
  }) => Promise<string>;

  /** Cleanup hooks invoked on retire — closed at bootstrap. */
  onRetire: (record: EntityRecord) => Promise<void>;
}

export interface RuntimeServiceDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  hooks: RuntimeEntityHooks;
  capability: CapabilityPermissionDeps;
  entityCache: EntityCache;
}

const CreateEntitySpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("panel"),
    source: z.string(),
    ref: z.string().optional(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    stateArgs: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("worker"),
    source: z.string(),
    ref: z.string().optional(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    stateArgs: z.unknown().optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("do"),
    source: z.string(),
    ref: z.string().optional(),
    className: z.string(),
    key: z.string().optional(),
    contextId: z.string().nullable().optional(),
  }),
]);

export function createRuntimeService(deps: RuntimeServiceDeps): ServiceDefinition {
  const workspaceDORef = {
    source: INTERNAL_DO_SOURCE,
    className: WORKSPACE_DO_CLASS,
    objectKey: deps.workspaceId,
  };
  const dispatchDO = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(workspaceDORef, method, ...args) as Promise<T>;

  async function resolveContextPolicy(
    caller: VerifiedCaller,
    requested: string | null | undefined,
    spec: RuntimeEntityCreateSpec
  ): Promise<string> {
    if (requested == null || requested === "") {
      return randomUUID();
    }
    const callerKind = caller.runtime.kind;
    if (callerKind === "server" || callerKind === "shell") {
      return requested;
    }
    // Pull caller's current contextId from the local cache; falls back to DO if absent.
    let callerContextId = deps.entityCache.resolveContext(caller.runtime.id);
    if (callerContextId == null) {
      callerContextId = await dispatchDO<string | null>("entityResolveContext", [
        caller.runtime.id,
      ]);
    }
    if (callerContextId === requested) {
      return requested;
    }
    if (callerKind !== "panel" && callerKind !== "worker" && callerKind !== "do") {
      // harness/extension callers reach here too; cross-context is gated.
      throw new Error(`Caller kind ${callerKind} cannot create cross-context entities`);
    }
    const result = await requestCapabilityPermission(deps.capability, {
      caller,
      capability: RUNTIME_CROSS_CONTEXT_ENTITY,
      dedupKey: `cross-context:${caller.runtime.id}:${spec.kind}:${requested}`,
      resource: {
        type: "context",
        label: "Target context",
        value: requested,
        key: requested,
      },
      title: "Create runtime entity in another context",
      description: `Allow ${callerKind} ${caller.runtime.id} to create a ${spec.kind} entity in context ${requested}.`,
      details: [
        { label: "Caller", value: `${callerKind} ${caller.runtime.id}` },
        { label: "Target kind", value: spec.kind },
        { label: "Target source", value: spec.source },
        { label: "Target context", value: requested },
      ],
      deniedReason: "Cross-context entity creation denied",
    });
    if (!result.allowed) {
      throw new Error(result.reason ?? "Cross-context entity creation denied");
    }
    return requested;
  }

  async function createEntity(
    caller: VerifiedCaller,
    rawSpec: RuntimeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    const spec = rawSpec;
    const contextId = await resolveContextPolicy(caller, spec.contextId, spec);
    const key = spec.key ?? randomUUID();

    let canonicalId: string;
    let effectiveVersion: string;
    let targetId: string;
    let existing: EntityRecord | null = null;

    if (spec.kind === "do") {
      canonicalId = canonicalEntityId({
        kind: "do",
        source: spec.source,
        className: spec.className,
        key,
      });
      existing = await dispatchDO<EntityRecord | null>("entityResolve", [canonicalId]);
      const prepared = await deps.hooks.prepareDurableObject({
        source: spec.source,
        ref: spec.ref,
        className: spec.className,
        key,
        contextId,
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      targetId = prepared.targetId;
    } else if (spec.kind === "worker") {
      canonicalId = canonicalEntityId({ kind: "worker", source: spec.source, key });
      existing = await dispatchDO<EntityRecord | null>("entityResolve", [canonicalId]);
      const prepared = await deps.hooks.prepareWorker({
        source: spec.source,
        ref: spec.ref,
        key,
        contextId,
        stateArgs: spec.stateArgs,
        env: spec.env,
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      targetId = prepared.targetId;
    } else {
      canonicalId = canonicalEntityId({ kind: "panel", key });
      existing = await dispatchDO<EntityRecord | null>("entityResolve", [canonicalId]);
      const resolvedVersion = await deps.hooks.resolvePanelEffectiveVersion({
        source: spec.source,
        ref: spec.ref,
      });
      effectiveVersion =
        existing?.status === "retired" ? existing.source.effectiveVersion : resolvedVersion;
      targetId = canonicalId;
    }

    const activateInput = {
      kind: spec.kind,
      source: { repoPath: spec.source, effectiveVersion },
      contextId,
      className: spec.kind === "do" ? spec.className : undefined,
      key,
      stateArgs: "stateArgs" in spec ? spec.stateArgs : undefined,
    };
    const record = await dispatchDO<EntityRecord>("entityActivate", [activateInput]);
    deps.entityCache._onActivate(record);

    return {
      id: record.id,
      kind: spec.kind,
      source: record.source,
      contextId: record.contextId,
      targetId,
    };
  }

  async function retireEntity(id: string): Promise<void> {
    const record = await dispatchDO<EntityRecord | null>("entityRetire", [id]);
    if (!record) return;
    deps.entityCache._onRetire(record);
    try {
      await deps.hooks.onRetire(record);
      await dispatchDO<undefined>("entityCleanupComplete", [id]);
    } catch {
      // Leave cleanup_complete=0; cleanupReaper will retry.
    }
  }

  async function resolveContext(id: string): Promise<string | null> {
    const cached = deps.entityCache.resolveContext(id);
    if (cached != null) return cached;
    return await dispatchDO<string | null>("entityResolveContext", [id]);
  }

  return {
    name: "runtime",
    description: "Runtime entity creation and retirement",
    policy: { allowed: ["panel", "shell", "server", "worker", "do", "harness"] },
    methods: {
      createEntity: {
        args: z.tuple([CreateEntitySpecSchema]),
        description: "Create a runtime entity (panel, worker, or DO).",
      },
      retireEntity: {
        args: z.tuple([z.object({ id: z.string() })]),
        description: "Retire a single entity, firing cleanup hooks.",
      },
      resolveContext: {
        args: z.tuple([z.string()]),
        description:
          "Return the contextId for an entity (or null if unknown). Cached read; falls back to DO.",
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "createEntity": {
          const [spec] = args as [RuntimeEntityCreateSpec];
          return await createEntity(ctx.caller, spec);
        }
        case "retireEntity": {
          const [{ id }] = args as [{ id: string }];
          await retireEntity(id);
          return;
        }
        case "resolveContext": {
          const [id] = args as [string];
          return await resolveContext(id);
        }
        default:
          throw new Error(`Unknown runtime method: ${method}`);
      }
    },
  };
}
