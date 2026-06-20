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
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { runtimeMethods } from "@natstack/shared/serviceSchemas/runtime";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import {
  canonicalEntityId,
  type EntityRecord,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
} from "@natstack/shared/runtime/entitySpec";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

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
    /** Launch parent (the verified caller) → worker `PARENT_*` env, so the
     *  worker's `parent` resolves from the same source as `EntityRecord.parentId`. */
    parent?: { parentId: string; parentEntityId: string; parentKind?: "panel" | "worker" | "do" };
  }) => Promise<{ targetId: string; effectiveVersion: string }>;

  /** Resolve effective version for "panel" entities (no runtime prep). */
  resolvePanelEffectiveVersion: (args: {
    source: string;
    ref: string | undefined;
  }) => Promise<string>;

  /** Resolve effective version for "app" entities (no runtime prep). */
  resolveAppEffectiveVersion: (args: {
    source: string;
    ref: string | undefined;
  }) => Promise<string>;

  /** Cleanup hooks invoked on retire — closed at bootstrap. */
  onRetire: (record: EntityRecord) => Promise<void>;
}

/** Context-folder lifecycle used by inert session entities. */
export interface RuntimeContextFolders {
  ensureContextFolder(contextId: string): Promise<string>;
  removeContext(contextId: string): Promise<void>;
}

export interface RuntimeServiceDeps {
  /**
   * The single owner of WorkspaceDO entity state. The runtime service never
   * dispatches `entityActivate`/`entityRetire` or touches the cache mirror
   * directly — the store pairs the durable write with the cache update so they
   * can't drift.
   */
  entityStore: WorkspaceEntityStore;
  hooks: RuntimeEntityHooks;
  capability: CapabilityPermissionDeps;
  contextFolders: RuntimeContextFolders;
  /**
   * Server-controlled display-title registry. Workers (and DOs / panels)
   * call `runtime.setTitle(title)` to populate the title that approval UIs
   * surface in place of the opaque entity id.
   */
  setEntityTitle?: (
    entityId: string,
    title: string | undefined,
    options?: { explicit?: boolean }
  ) => void | Promise<void>;
  canCreateCrossContextEntity?: (
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec
  ) => boolean | Promise<boolean>;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}

export function createRuntimeService(deps: RuntimeServiceDeps): ServiceDefinition {
  const store = deps.entityStore;

  async function resolveContextPolicy(
    caller: VerifiedCaller,
    requested: string | null | undefined,
    spec: RuntimeEntityCreateSpec
  ): Promise<string> {
    if (requested == null || requested === "") {
      return randomUUID();
    }
    const callerKind = caller.runtime.kind;
    if (isAuthorizedChrome(caller, { hasAppCapability: deps.hasAppCapability })) {
      return requested;
    }
    if (await deps.canCreateCrossContextEntity?.(caller, spec)) {
      return requested;
    }
    // Pull caller's current contextId (cache-first, falls back to the WorkspaceDO).
    const callerContextId = await store.resolveContext(caller.runtime.id);
    if (callerContextId === requested) {
      return requested;
    }
    if (
      callerKind !== "panel" &&
      callerKind !== "app" &&
      callerKind !== "worker" &&
      callerKind !== "do"
    ) {
      // extension callers reach here too; cross-context is gated.
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
    if (spec.kind === "app" || spec.kind === "session") {
      const callerKind = caller.runtime.kind;
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error(
          `${spec.kind === "app" ? "App" : "Session"} runtime entities are host-managed`
        );
      }
    }
    let contextId = await resolveContextPolicy(caller, spec.contextId, spec);
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
      existing = await store.resolveRecord(canonicalId);
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
      existing = await store.resolveRecord(canonicalId);
      const parentKind = caller.runtime.kind;
      const prepared = await deps.hooks.prepareWorker({
        source: spec.source,
        ref: spec.ref,
        key,
        contextId,
        stateArgs: spec.stateArgs,
        env: spec.env,
        // Same launch parent recorded on the entity (parentId below), threaded to
        // the worker's PARENT_* env so its `parent` runtime API resolves.
        parent: {
          parentId: caller.runtime.id,
          parentEntityId: caller.runtime.id,
          parentKind:
            parentKind === "panel" || parentKind === "worker" || parentKind === "do"
              ? parentKind
              : undefined,
        },
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      targetId = prepared.targetId;
    } else if (spec.kind === "app") {
      canonicalId = canonicalEntityId({ kind: "app", source: spec.source, key });
      existing = await store.resolveRecord(canonicalId);
      const resolvedVersion = await deps.hooks.resolveAppEffectiveVersion({
        source: spec.source,
        ref: spec.ref,
      });
      effectiveVersion =
        existing?.status === "retired" ? existing.source.effectiveVersion : resolvedVersion;
      targetId = canonicalId;
    } else if (spec.kind === "session") {
      canonicalId = canonicalEntityId({ kind: "session", key });
      existing = await store.resolveRecord(canonicalId);
      // Entity identity columns are write-once, so re-attaching to an
      // existing session key must reuse its contextId — a freshly minted one
      // would throw IDENTITY_COLLISION even against a retired row. The
      // context folder is re-materialized below if it was removed.
      if ((spec.contextId == null || spec.contextId === "") && existing) {
        contextId = existing.contextId;
      }
      // Inert kind: no workerd/panel runtime. The only phase-4 prep is
      // eagerly materializing the context folder so host callers (e.g.
      // agent CLIs) get a working tree immediately.
      await deps.contextFolders.ensureContextFolder(contextId);
      effectiveVersion = existing?.status === "retired" ? existing.source.effectiveVersion : "";
      targetId = canonicalId;
    } else {
      canonicalId = canonicalEntityId({ kind: "panel", key });
      existing = await store.resolveRecord(canonicalId);
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
      stateArgs:
        spec.kind === "session"
          ? spec.title !== undefined
            ? { title: spec.title }
            : undefined
          : "stateArgs" in spec
            ? spec.stateArgs
            : undefined,
      // Record the verified caller as this entity's launch parent (server-
      // authoritative) so a runtime can later resolve its nearest panel ancestor
      // (e.g. eval launched by an agent inherits the agent's owning panel).
      parentId: caller.runtime.id,
    };
    const record = await store.activate(activateInput);
    if (spec.kind === "session" && spec.title) {
      await deps.setEntityTitle?.(record.id, spec.title, { explicit: true });
    }

    return {
      id: record.id,
      kind: spec.kind,
      source: record.source,
      contextId: record.contextId,
      targetId,
    };
  }

  async function retireEntity(id: string, removeContext?: boolean): Promise<void> {
    const record = await store.retire(id);
    if (!record) return;
    try {
      await deps.hooks.onRetire(record);
      await store.cleanupComplete(id);
    } catch {
      // Leave cleanup_complete=0; cleanupReaper will retry.
    }
    if (removeContext) {
      const live = await store.listActive();
      if (!live.some((e) => e.contextId === record.contextId)) {
        await deps.contextFolders.removeContext(record.contextId);
      }
    }
  }

  interface EntitySummary {
    id: string;
    kind: string;
    source: string;
    contextId: string;
    title?: string;
    createdAt: number;
  }

  async function listEntities(kind?: string): Promise<EntitySummary[]> {
    const live = await store.listActive(kind);
    return live.map((record) => {
      const stateArgs = record.stateArgs;
      const title =
        stateArgs != null &&
        typeof stateArgs === "object" &&
        typeof (stateArgs as { title?: unknown }).title === "string"
          ? ((stateArgs as { title: string }).title as string)
          : undefined;
      return {
        id: record.id,
        kind: record.kind,
        source: record.source.repoPath,
        contextId: record.contextId,
        title,
        createdAt: record.createdAt,
      };
    });
  }

  async function resolveContext(id: string): Promise<string | null> {
    return await store.resolveContext(id);
  }

  return {
    name: "runtime",
    description: "Runtime entity creation and retirement",
    policy: { allowed: ["panel", "app", "shell", "server", "worker", "do"] },
    methods: runtimeMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "createEntity": {
          const [spec] = args as [RuntimeEntityCreateSpec];
          return await createEntity(ctx.caller, spec);
        }
        case "retireEntity": {
          const [{ id, removeContext }] = args as [{ id: string; removeContext?: boolean }];
          await retireEntity(id, removeContext);
          return;
        }
        case "listEntities": {
          const [{ kind }] = args as [{ kind?: string }];
          return await listEntities(kind);
        }
        case "resolveContext": {
          const [id] = args as [string];
          return await resolveContext(id);
        }
        case "setTitle": {
          const [title, options] = args as [string | null, { explicit?: boolean } | undefined];
          const callerKind = ctx.caller.runtime.kind;
          if (
            callerKind !== "panel" &&
            callerKind !== "app" &&
            callerKind !== "worker" &&
            callerKind !== "do"
          ) {
            throw new Error(`runtime.setTitle is only available to panel/app/worker/do callers`);
          }
          await deps.setEntityTitle?.(ctx.caller.runtime.id, title == null ? undefined : title, {
            explicit: options?.explicit === true,
          });
          return;
        }
        default:
          throw new Error(`Unknown runtime method: ${method}`);
      }
    },
  };
}
