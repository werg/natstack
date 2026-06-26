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
import {
  runtimeMethods,
  type ClonedEntity,
  type CloneContextResult,
} from "@natstack/shared/serviceSchemas/runtime";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import {
  buildWorkspaceContext,
  canonicalEntityId,
  type EntityRecord,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
  type WorkspaceContext,
} from "@natstack/shared/runtime/entitySpec";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { isAuthorizedChrome } from "./chromeTrust.js";
import {
  requireContextBoundaryPermission,
  type ContextBoundaryAction,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";

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

  /**
   * Clone a DO's durable SQLite storage to a new instance key (server-internal
   * `workerdManager.cloneDO`). Used by `cloneContext`; never exposed to userland.
   */
  cloneDurableStorage?: (args: {
    source: string;
    className: string;
    fromKey: string;
    toKey: string;
  }) => Promise<void>;

  /**
   * Delete a DO's durable SQLite storage (server-internal
   * `workerdManager.destroyDO`). Used by `cloneContext` rollback + `destroyContext`;
   * never exposed to userland. (Plain `retireEntity` deliberately leaves storage
   * intact for re-attach — only a full context destroy reclaims it.)
   */
  destroyDurableStorage?: (args: {
    source: string;
    className: string;
    key: string;
  }) => Promise<void>;
}

/** Context-folder lifecycle used by inert session entities. */
export interface RuntimeContextFolders {
  ensureContextFolder(contextId: string): Promise<string>;
  removeContext(contextId: string): Promise<void>;
}

/** VCS lifecycle hooks for full-workspace context branches. */
export interface RuntimeVcsContexts {
  /**
   * Pin a context's base view at creation (idempotent — pins the current
   * `workspaceView()` only if not already pinned) so its reads don't drift.
   */
  pinContext?(contextId: string): Promise<string>;
  /**
   * Tear down all VCS state for a context on retire: clear caches + delete its
   * `ctx` heads and pin ref.
   */
  dropContext?(contextId: string): Promise<void>;
  /**
   * Fork a context's file state: snapshot the SOURCE context's full working view
   * (committed ctx heads + uncommitted edits) as the TARGET context's pinned base,
   * so the clone starts as an isolated copy of the source's files and then diverges
   * independently. Used by `cloneContext`.
   */
  forkContext?(sourceContextId: string, targetContextId: string): Promise<void>;
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
  contextBoundary: ContextBoundaryDeps;
  contextFolders: RuntimeContextFolders;
  /** Optional VCS hooks for pinning and dropping context branches. */
  vcsContexts?: RuntimeVcsContexts;
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
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}

export function createRuntimeService(deps: RuntimeServiceDeps): ServiceDefinition {
  const store = deps.entityStore;

  /**
   * The context-boundary gate for DIRECT (userland) entity launch/destroy/
   * context ops. Trusted chrome/server callers bypass — they cannot be prompted
   * (no code identity), and the only `server` entrants are (a) panel-mediated
   * calls already gated at the panel layer or (b) genuine system creation
   * (seed/CLI), which is free. Runs BEFORE any side effect, so denial is
   * non-destructive.
   */
  async function gateContextLaunch(
    caller: VerifiedCaller,
    targetContextId: string,
    action: ContextBoundaryAction
  ): Promise<void> {
    if (isAuthorizedChrome(caller, { hasAppCapability: deps.hasAppCapability })) return;
    const originContextId = await store.resolveContext(caller.runtime.id);
    const result = await requireContextBoundaryPermission(deps.contextBoundary, {
      subjectCaller: caller,
      originContextId,
      targetContextId,
      action,
    });
    if (!result.allowed) {
      throw new Error(result.reason ?? "Context-boundary denied");
    }
  }

  async function resolveContextPolicy(
    caller: VerifiedCaller,
    requested: string | null | undefined,
    spec: RuntimeEntityCreateSpec
  ): Promise<string> {
    // Empty/omitted ⇒ a brand-new context (fresh ⇒ free, no gate).
    if (requested == null || requested === "") {
      return randomUUID();
    }
    await gateContextLaunch(caller, requested, {
      kind: "runtime",
      verb: `Create ${spec.kind}`,
      targetLabel: spec.source,
      groupKey: `context-boundary:${requested}:${spec.source}`,
    });
    return requested;
  }

  /**
   * Set up a full logical workspace context branch. Pinning freezes the base
   * workspace view so reads remain stable until the context explicitly rebases.
   * Per-repo ctx heads are created lazily by the VCS layer when the context edits
   * or commits a repo; repo membership is not part of the runtime contract.
   */
  async function setUpContext(contextId: string): Promise<WorkspaceContext> {
    // Pin the context's base view (a per-context VCS ref) so its reads are a
    // consistent snapshot and never drift as `main` advances under it. Idempotent:
    // a second entity joining the context inherits the existing pin.
    await deps.vcsContexts?.pinContext?.(contextId).catch(() => undefined);
    return buildWorkspaceContext(contextId);
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
    // Gate (context-boundary) then prepare+activate. The gate is the ONLY caller
    // of the boundary check on this path; `activateEntity` is gate-free so internal
    // orchestration (cloneContext) can create clones after a single source-gate.
    const contextId = await resolveContextPolicy(caller, spec.contextId, spec);
    return activateEntity(caller, spec, contextId);
  }

  /**
   * Prepare runtime resources for an entity and commit its durable row — WITHOUT
   * the context-boundary gate. `createEntity` calls this after gating; `cloneContext`
   * calls it per-clone after a single gate on the source context. `parentId` is the
   * caller, so a cloneContext caller owns (and may freely destroy) the clones.
   */
  async function activateEntity(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec,
    initialContextId: string
  ): Promise<RuntimeEntityHandle> {
    let contextId = initialContextId;
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

    // A context is a full logical workspace branch. The VCS layer lazily creates
    // per-repo ctx heads as this branch edits repos.
    await setUpContext(contextId);

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

  /**
   * Create a full logical workspace context branch without attaching an entity
   * to it yet. Useful when an orchestrator wants several entities to share a
   * branch. Repo selection remains an operation-level concern on VCS methods.
   */
  async function createContext(
    caller: VerifiedCaller,
    args: { contextId?: string }
  ): Promise<WorkspaceContext> {
    // A named, already-existing foreign context is gated (this re-pins its VCS /
    // re-materializes its folder); a fresh/omitted contextId is free.
    if (args.contextId != null && args.contextId !== "") {
      await gateContextLaunch(caller, args.contextId, { kind: "runtime", verb: "Set up context" });
    }
    const contextId = args.contextId ?? randomUUID();
    const context = await setUpContext(contextId);
    await deps.contextFolders.ensureContextFolder(contextId);
    return context;
  }

  /**
   * Durable retire + cleanup hooks for ONE entity, WITHOUT the context-boundary
   * gate. `retireEntity` calls this after gating; `cloneContext` rollback and
   * `destroyContext` call it directly (their gate is on the context as a whole).
   */
  async function retireRecord(id: string): Promise<EntityRecord | null> {
    const record = await store.retire(id);
    if (!record) return null;
    try {
      await deps.hooks.onRetire(record);
      await store.cleanupComplete(id);
    } catch {
      // Leave cleanup_complete=0; cleanupReaper will retry.
    }
    return record;
  }

  async function retireEntity(
    caller: VerifiedCaller,
    id: string,
    removeContext?: boolean
  ): Promise<void> {
    // Gate BEFORE mutating. Resolve the target's context via the DURABLE store
    // (the active cache may already be evicting it). A null/unknown/already-
    // retired target ⇒ the retire below no-ops ⇒ allow.
    const targetContextId = await store.resolveContext(id);
    if (targetContextId != null) {
      await gateContextLaunch(caller, targetContextId, {
        kind: "runtime",
        verb: "Destroy",
        targetLabel: id,
        ...(removeContext ? { severity: "severe" as const } : {}),
      });
    }
    const record = await retireRecord(id);
    if (!record) return;
    if (removeContext) {
      const live = await store.listActive();
      if (!live.some((e) => e.contextId === record.contextId)) {
        // Tear down VCS state (caches + ctx heads + pin ref) before the folder.
        await deps.vcsContexts?.dropContext?.(record.contextId).catch(() => undefined);
        await deps.contextFolders.removeContext(record.contextId);
      }
    }
  }

  /** Build a clone spec from a source record: same source + class, new key/context.
   *  `ref` is omitted, so the clone builds at the current main version (HEAD-tracking
   *  entities — the common case — match; a source pinned to an older version is
   *  re-resolved to main, an accepted trade-off vs. plumbing a state-hash build ref). */
  function buildCloneSpec(
    src: EntityRecord,
    contextId: string,
    newKey: string
  ): RuntimeEntityCreateSpec {
    if (src.kind === "do") {
      if (!src.className) {
        throw new Error(`cloneContext: DO entity ${src.id} has no className`);
      }
      return {
        kind: "do",
        source: src.source.repoPath,
        className: src.className,
        key: newKey,
        contextId,
        stateArgs: src.stateArgs,
      };
    }
    return {
      kind: "worker",
      source: src.source.repoPath,
      key: newKey,
      contextId,
      stateArgs: src.stateArgs,
    };
  }

  /**
   * Clone a whole context's durable substrate into a fresh, isolated context:
   * every worker/DO's storage (server-internal cloneDO) + a VCS snapshot of the
   * source's working files. Returns the new contextId + source→clone map. Does NOT
   * invoke the cloned DOs — server→DO calls are out of band; a caller that needs to
   * "activate" clones (re-root logs, rebind the channel) drives that via the clones'
   * own methods (the fork's `postClone`). Gated on the SOURCE: cloning your own
   * context is free; cloning a foreign existing one prompts.
   */
  async function cloneContext(
    caller: VerifiedCaller,
    args: { sourceContextId: string; include?: string[] }
  ): Promise<CloneContextResult> {
    const { sourceContextId } = args;
    const include = args.include ? new Set(args.include) : null;
    await gateContextLaunch(caller, sourceContextId, {
      kind: "runtime",
      verb: "Clone context",
      targetLabel: sourceContextId,
    });

    // Only durable kinds carry cloneable state. Panels/apps are UI/host-managed;
    // sessions are inert identity. They are not reproduced in the clone. When
    // `include` is given, clone exactly that subset (the caller's explicit scope).
    const sourceEntities = (await store.listActive()).filter(
      (e) =>
        e.contextId === sourceContextId &&
        (e.kind === "do" || e.kind === "worker") &&
        (include ? include.has(e.id) : true)
    );
    if (sourceEntities.length === 0) {
      throw new Error(
        `cloneContext: source context ${sourceContextId} has no clonable (worker/DO) entities`
      );
    }

    const targetContextId = randomUUID();
    // Fork file state FIRST: pin the new context to the source's working snapshot
    // so clones materialize the source's files, then diverge independently.
    await deps.vcsContexts?.forkContext?.(sourceContextId, targetContextId);
    await deps.contextFolders.ensureContextFolder(targetContextId);

    const created: RuntimeEntityHandle[] = [];
    const clonedStorage: Array<{ source: string; className: string; key: string }> = [];
    const entities: ClonedEntity[] = [];
    try {
      for (const src of sourceEntities) {
        const newKey = `${src.key}~clone~${randomUUID().slice(0, 8)}`;
        if (src.kind === "do") {
          const className = src.className;
          if (className == null) {
            throw new Error(`cloneContext: DO entity ${src.id} has no className`);
          }
          // Storage clone must precede activation so the DO reads cloned state on
          // first access.
          await deps.hooks.cloneDurableStorage?.({
            source: src.source.repoPath,
            className,
            fromKey: src.key,
            toKey: newKey,
          });
          clonedStorage.push({ source: src.source.repoPath, className, key: newKey });
        }
        const handle = await activateEntity(
          caller,
          buildCloneSpec(src, targetContextId, newKey),
          targetContextId
        );
        created.push(handle);
        entities.push({
          sourceId: src.id,
          newId: handle.id,
          kind: src.kind as "do" | "worker",
          source: src.source.repoPath,
          ...(src.className ? { className: src.className } : {}),
          sourceKey: src.key,
          newKey,
          targetId: handle.targetId,
        });
      }
    } catch (err) {
      // Best-effort rollback: retire clones, delete cloned storage, drop the context.
      for (const h of created) await retireRecord(h.id).catch(() => undefined);
      for (const s of clonedStorage)
        await deps.hooks.destroyDurableStorage?.(s).catch(() => undefined);
      await deps.vcsContexts?.dropContext?.(targetContextId).catch(() => undefined);
      await deps.contextFolders.removeContext(targetContextId).catch(() => undefined);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { contextId: targetContextId, entities };
  }

  /**
   * Tear a whole context down: retire every entity, reclaim each DO's SQLite
   * storage, then drop the VCS state + folder. Free for your own context or one you
   * fully own (every active entity launched by you — e.g. a context you just cloned);
   * gated (severe) when destroying another agent or panel's existing context.
   */
  async function destroyContext(
    caller: VerifiedCaller,
    args: { contextId: string }
  ): Promise<void> {
    const { contextId } = args;
    const entities = (await store.listActive()).filter((e) => e.contextId === contextId);
    // Ownership bypass: a context whose every active entity you launched is yours
    // to destroy. Otherwise gate (gateContextLaunch still frees your own context +
    // trusted chrome). An empty context falls through to the gate.
    const owned = entities.length > 0 && entities.every((e) => e.parentId === caller.runtime.id);
    if (!owned) {
      await gateContextLaunch(caller, contextId, {
        kind: "runtime",
        verb: "Destroy context",
        targetLabel: contextId,
        severity: "severe",
      });
    }
    for (const e of entities) {
      const rec = await retireRecord(e.id);
      // DO storage is NOT reclaimed by retire (kept for re-attach) — a full context
      // destroy is the one path that deletes it.
      if (rec && rec.kind === "do" && rec.className) {
        await deps.hooks
          .destroyDurableStorage?.({
            source: rec.source.repoPath,
            className: rec.className,
            key: rec.key,
          })
          .catch(() => undefined);
      }
    }
    await deps.vcsContexts?.dropContext?.(contextId).catch(() => undefined);
    await deps.contextFolders.removeContext(contextId).catch(() => undefined);
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
          await retireEntity(ctx.caller, id, removeContext);
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
        case "createContext": {
          const [{ contextId }] = args as [{ contextId?: string }];
          return await createContext(ctx.caller, { contextId });
        }
        case "cloneContext": {
          const [cloneArgs] = args as [{ sourceContextId: string; include?: string[] }];
          return await cloneContext(ctx.caller, cloneArgs);
        }
        case "destroyContext": {
          const [{ contextId }] = args as [{ contextId: string }];
          await destroyContext(ctx.caller, { contextId });
          return;
        }
        case "setTitle": {
          // Access is enforced by the per-method policy on `runtimeMethods.setTitle`
          // (allowed: panel/app/worker/do), checked by the dispatcher before this
          // handler runs. We deliberately do NOT re-gate caller kind here — declared
          // policy == enforced, with a single source of truth (no handler-side narrowing).
          const [title, options] = args as [string | null, { explicit?: boolean } | undefined];
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
