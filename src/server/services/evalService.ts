import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { evalMethods } from "@natstack/shared/serviceSchemas/eval";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@natstack/shared/panel/owningPanelSlot";
import type { TokenManager } from "@natstack/shared/tokenManager";
import { createHash, randomUUID } from "node:crypto";

/** Parse a `do:<source>:<className>:<objectKey>` runtime id into a DO ref (source may contain '/'). */
function parseDoRef(
  runtimeId: string
): { source: string; className: string; objectKey: string } | null {
  if (!runtimeId.startsWith("do:")) return null;
  const rest = runtimeId.slice(3);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;
  const source = rest.slice(0, firstColon);
  const afterSource = rest.slice(firstColon + 1);
  const secondColon = afterSource.indexOf(":");
  if (secondColon < 0) return null;
  const className = afterSource.slice(0, secondColon);
  const objectKey = afterSource.slice(secondColon + 1);
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

/**
 * Hold the EvalDO's `executeRun` on a background Node task (no request-scoped limit), then push the
 * result to the owning agent DO (`onEvalComplete`, server-stamped). The held dispatch uses the
 * no-`headersTimeout` dispatcher (`dispatchHeld`). On failure (e.g. a server restart dropped the
 * connection) the EvalDO's boot reconciliation marks the run interrupted and the agent's `getRun`
 * poll backstop surfaces it — so this is fire-and-forget.
 */
async function pushEvalComplete(
  doDispatch: DODispatch,
  agentRef: string | undefined,
  channelId: string | undefined,
  runId: string,
  result: unknown
): Promise<void> {
  if (!agentRef) return;
  const agentDoRef = parseDoRef(agentRef);
  if (!agentDoRef) return;
  // `channelId` lets the agent route the resume (deliverEffectOutcome needs the channel
  // address); `runId` is the invocationId → effect id.
  await doDispatch
    .dispatch(agentDoRef, "onEvalComplete", { runId, result, channelId })
    .catch((err) => {
      console.warn(
        `[eval] onEvalComplete push to ${agentRef} failed (getRun poll backstop covers it):`,
        err instanceof Error ? err.message : err
      );
    });
}

async function runHeldAndDeliver(
  doDispatch: DODispatch,
  evalDoRef: { source: string; className: string; objectKey: string },
  runId: string,
  agentRef: string | undefined,
  channelId: string | undefined
): Promise<void> {
  try {
    const result = await doDispatch.dispatchHeld(evalDoRef, "executeRun", runId);
    await pushEvalComplete(doDispatch, agentRef, channelId, runId, result);
  } catch (err) {
    console.warn(`[eval] held run ${runId} failed:`, err instanceof Error ? err.message : err);
    // F2: the held dispatch died (e.g. a server restart dropped the connection). The agent's own
    // `getRun` poll backstop MAY re-fire, but if its `deferRedrive` never re-runs the eval gate the
    // parked invocation hangs forever. So reconcile the run's TERMINAL state from the EvalDO and push
    // an `onEvalComplete` ourselves — but ONLY when the run is actually terminal. A `done`/`cancelled`
    // run (boot reconciliation marks an interrupted run with a failed result) settles the agent's
    // invocation; a still-`pending`/`running` run (genuinely in flight elsewhere) is LEFT ALONE so we
    // never cut a legitimately long-running eval short — its own completion push covers it.
    if (!agentRef) return;
    try {
      const reconciled = (await doDispatch.dispatch(evalDoRef, "getRun", runId)) as {
        status?: string;
        result?: unknown;
      };
      const status = String(reconciled?.status ?? "unknown");
      if (status === "done" && reconciled.result != null) {
        await pushEvalComplete(doDispatch, agentRef, channelId, runId, reconciled.result);
      } else if (status === "cancelled" || status === "unknown") {
        // No durable result to deliver — synthesize a terminal failure so the parked invocation
        // settles instead of hanging. (`pending`/`running` deliberately fall through: do not bound.)
        await pushEvalComplete(doDispatch, agentRef, channelId, runId, {
          success: false,
          console: "",
          error:
            reconciled?.result != null
              ? String((reconciled.result as { error?: unknown })?.error ?? "eval run interrupted")
              : "eval run interrupted",
        });
      }
    } catch (reconcileErr) {
      console.warn(
        `[eval] reconcile getRun for ${runId} after held failure also failed:`,
        reconcileErr instanceof Error ? reconcileErr.message : reconcileErr
      );
    }
  }
}

const EVAL_DO_CLASS = "EvalDO";
/** Stable — EvalDO ships in the internal bundle, not build-versioned; keeps entity identity stable. */
const EVAL_DO_EFFECTIVE_VERSION = "internal";

interface EvalOwner {
  ownerId: string;
  contextId: string;
}

/** Server-resolved launch parent for an eval session (the owning panel). */
interface EvalParentMeta {
  parentId: string;
  parentEntityId: string;
  parentKind: "panel";
}

/**
 * Owner-scoped sandbox eval service — replaces the `scope` service. Any entity-principal
 * (panel/app/worker/do/shell) calls `eval.run`/`eval.reset`; the owner is the verified
 * `ctx.caller` unless a privileged shell/server caller selects a session owner. The EvalDO
 * `objectKey` is derived (hashed) from the owner id + subKey, so unprivileged callers can
 * only address their own EvalDO. The EvalDO entity is registered with the owner's context so
 * the kernel's own fs/git/vcs resolve the owner's workspace.
 */
export function createEvalService(deps: {
  /** Generic DO dispatcher — used to invoke `run`/`reset` on the per-owner EvalDO. */
  doDispatch: DODispatch;
  /**
   * The single owner of WorkspaceDO entity state. Eval registers the EvalDO
   * entity via `store.activate`, which pairs the durable write with the server
   * hot-cache mirror. Bypassing it (dispatching `entityActivate` directly) is
   * exactly what caused every EvalDO→main RPC to 403 with "Unknown principal
   * kind" — the cache never learned the EvalDO's identity.
   */
  entityStore: WorkspaceEntityStore;
  tokenManager: TokenManager;
}): ServiceDefinition {
  const store = deps.entityStore;

  const evalDoKey = (ownerId: string, subKey: string): string =>
    createHash("sha256")
      .update(ownerId + "\0" + subKey)
      .digest("hex")
      .slice(0, 40);

  /**
   * The EvalDO's canonical entity id (kind `do`). This is the principal the
   * server resolves on every EvalDO→main callback AND the subject of the
   * owner-scoped gateway token — the two MUST agree, so both derive it here.
   */
  const evalDoEntityId = (objectKey: string): string =>
    `do:${INTERNAL_DO_SOURCE}:${EVAL_DO_CLASS}:${objectKey}`;

  /**
   * Owner-scoped gateway token for THIS EvalDO. Pinned to the concrete
   * `do:natstack/internal:EvalDO:<objectKey>` identity (kind `do`), NOT the
   * shared `do-service:*` bearer — so the kernel's `gatewayFetch` resolves the
   * owner's context and a leak's blast radius is the owner alone (eval code can
   * read `gatewayConfig.token`, but it IS the owner's own authority). Minted
   * here (server-internal, owner already verified) and handed to `EvalDO.run`
   * over the authenticated server→DO dispatch — no new callable token-issuing
   * surface, so nothing rides the worker→do policy fallthrough. `ensureToken`
   * is idempotent per callerId, so it's a stable per-owner token.
   */
  const mintGatewayToken = (objectKey: string): string =>
    deps.tokenManager.ensureToken(evalDoEntityId(objectKey), "do");

  async function resolveRegisteredContext(ownerId: string): Promise<string | null> {
    return store.resolveContext(ownerId);
  }

  /**
   * Resolve the nearest panel ancestor-or-self of `callerId` from the entity
   * store (cache-first) — the panel that "owns" this eval. Walks `parentId` up
   * the launch chain: a panel caller resolves to itself; an agent/worker caller
   * resolves to its owning panel (recorded at `runtime.createEntity` from the
   * verified caller); anything with no panel ancestor → null. Server-
   * authoritative — never eval user input. Becomes `RunArgs.parent`, from which
   * the EvalDO derives the portable `parent`/`getParent`.
   */
  async function resolveParentPanel(callerId: string): Promise<EvalParentMeta | null> {
    // Shared resolver: walk the entity lineage to the nearest OPEN panel and return its TREE SLOT id
    // (durable nav→slot via the slot store — the SAME source the server create handler uses, so the
    // eval's defaultOpenParentId and the server's nesting decision can't drift, and it works even when
    // the owning panel isn't currently loaded). The lineage is entity-id space, so a node is never
    // itself a slot id (isOpenSlot is constant false here).
    const slotId = await resolveOwningPanelSlot(callerId, {
      isOpenSlot: () => false,
      resolveOpenSlotForEntity: async (id) => (await store.resolveSlotByEntity(id)) ?? undefined,
      resolveParentId: async (id) =>
        (store.cache.resolve(id) ?? (await store.resolveRecord(id)))?.parentId,
    });
    if (!slotId) return null;
    // parentEntityId is only consumed for worker/do parent kinds (createRuntimeParentHandle); a panel
    // parent resolves via getPanelHandle(slotId), so the slot id is the operative identity.
    return { parentId: slotId, parentEntityId: slotId, parentKind: "panel" };
  }

  async function resolveOwner(
    callerKind: string,
    callerId: string,
    requested: { ownerId?: string; contextId?: string }
  ): Promise<EvalOwner> {
    if (requested.ownerId !== undefined || requested.contextId !== undefined) {
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error("eval: ownerId/contextId overrides are restricted to shell/server callers");
      }
      if (!requested.ownerId || !requested.contextId) {
        throw new Error("eval: ownerId and contextId must be provided together");
      }
      const registeredContext = await resolveRegisteredContext(requested.ownerId);
      if (registeredContext == null) {
        throw new Error(`eval: no context registered for owner ${requested.ownerId}`);
      }
      if (registeredContext !== requested.contextId) {
        throw new Error(
          `eval: owner ${requested.ownerId} is registered to ${registeredContext}, not ${requested.contextId}`
        );
      }
      return { ownerId: requested.ownerId, contextId: requested.contextId };
    }

    const contextId = await resolveRegisteredContext(callerId);
    if (contextId == null) {
      throw new Error(`eval: no context registered for caller ${callerId}`);
    }
    return { ownerId: callerId, contextId };
  }

  async function ensureEvalDO(owner: EvalOwner, subKey: string): Promise<{ objectKey: string }> {
    const { ownerId, contextId } = owner;
    const objectKey = evalDoKey(ownerId, subKey);
    // Fast path: the EvalDO entity is sticky (idle-eviction aborts the instance
    // but never retires the entity), so once it's active in the cache for the
    // right context there's nothing to do — re-activating every run is a wasted
    // WorkspaceDO round-trip. Gating on the cache (not a private "seen" set)
    // keeps us self-consistent: a retired entity (cache miss) or a fresh server
    // process (empty cache) re-activates; the cache IS the source of truth the
    // server's principal resolution reads.
    const active = store.cache.resolveActive(evalDoEntityId(objectKey));
    if (active && active.contextId === contextId) {
      return { objectKey };
    }
    // Register/refresh the EvalDO entity with the owner's context so the kernel's
    // own fs/git/vcs calls resolve the owner's workspace. The store pairs the
    // durable upsert with the server hot-cache mirror, so the server can resolve
    // THIS EvalDO's principal when it calls back to `main`. Idempotent.
    await store.activate({
      kind: "do",
      source: { repoPath: INTERNAL_DO_SOURCE, effectiveVersion: EVAL_DO_EFFECTIVE_VERSION },
      contextId,
      className: EVAL_DO_CLASS,
      key: objectKey,
      // The EvalDO's launch parent IS its owner. An entity spawned FROM an eval (e.g. a headless
      // sub-agent the orchestrator's eval creates via runtime.createEntity) records THIS EvalDO as its
      // parentId — so without this link the lineage dead-ends at the EvalDO and the sub-agent's panels
      // resolve to root. With it, the walk continues owner → owner's panel, so the sub-agent's panels
      // nest under the owner's panel. ownerId is stable; the panel is re-resolved live at walk time.
      parentId: ownerId,
      stateArgs: { ownerPrincipalId: ownerId, subKey },
    });
    return { objectKey };
  }

  function assertRunSource(args: { code?: string; path?: string }): void {
    const hasCode = args.code !== undefined;
    const hasPath = args.path !== undefined;
    if (hasCode === hasPath) {
      throw new Error("eval: provide exactly one of code or path");
    }
  }

  return {
    name: "eval",
    description: "Owner-scoped sandbox eval backed by a per-owner internal EvalDO",
    policy: { allowed: ["panel", "app", "worker", "do", "extension", "shell", "server"] },
    methods: evalMethods,
    handler: async (ctx, method, args) => {
      const ownerId = ctx.caller.runtime.id;

      type EvalRunArgs = {
        ownerId?: string;
        contextId?: string;
        subKey?: string;
        channelId?: string;
        code?: string;
        path?: string;
        syntax?: "typescript" | "jsx" | "tsx";
        imports?: Record<string, string>;
        runId?: string;
        timeoutMs?: number;
      };

      // Resolve owner/objectKey + assemble the server-authoritative run args (gatewayToken, parent,
      // chat binding). Shared by `run` (held) and `startRun` (async).
      const prepareRun = async (
        runArgs: EvalRunArgs
      ): Promise<{
        evalDoRef: { source: string; className: string; objectKey: string };
        assembledArgs: Record<string, unknown>;
        agentRef: string | undefined;
      }> => {
        assertRunSource(runArgs);
        const owner = await resolveOwner(ctx.caller.runtime.kind, ownerId, {
          ownerId: runArgs.ownerId,
          contextId: runArgs.contextId,
        });
        const { objectKey } = await ensureEvalDO(owner, runArgs.subKey ?? "default");
        // Give the sandbox a `chat` binding ONLY when an agent DO supplies a channelId — the EvalDO
        // forwards every chat op back to this agent (agentRef = the verified caller). CLI/panel
        // callers (non-"do") get no chat.
        const isAgent = ctx.caller.runtime.kind === "do" && Boolean(runArgs.channelId);
        const chatBinding = isAgent ? { channelId: runArgs.channelId, agentRef: ownerId } : {};
        // The eval's portable `parent` = the verified caller's nearest panel ancestor. Server-side.
        const parent = (await resolveParentPanel(ownerId)) ?? undefined;
        return {
          evalDoRef: { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          assembledArgs: {
            code: runArgs.code,
            path: runArgs.path,
            syntax: runArgs.syntax,
            imports: runArgs.imports,
            contextId: owner.contextId,
            gatewayToken: mintGatewayToken(objectKey),
            parent,
            timeoutMs: runArgs.timeoutMs,
            ...chatBinding,
          },
          agentRef: isAgent ? ownerId : undefined,
        };
      };

      if (method === "run") {
        // Held synchronous run for connection-holding callers (panels over WS, CLI). The EvalDO
        // runs in a held handler; the caller holds its own leg. One request, one result.
        const { evalDoRef, assembledArgs } = await prepareRun((args[0] ?? {}) as EvalRunArgs);
        return deps.doDispatch.dispatchHeld(evalDoRef, "run", assembledArgs);
      }

      if (method === "startRun") {
        // Async run for a caller that can't hold a connection (an agent). Insert the row (so getRun
        // works immediately), kick off the held execution + completion push on a background Node
        // task, and return the runId at once.
        const runArgs = (args[0] ?? {}) as EvalRunArgs;
        const runId = runArgs.runId ?? randomUUID();
        const { evalDoRef, assembledArgs, agentRef } = await prepareRun(runArgs);
        const { status } = (await deps.doDispatch.dispatch(evalDoRef, "startRun", {
          ...assembledArgs,
          runId,
        })) as { runId: string; status: string };
        // Kick the held execution ONLY for a FRESH (pending) row. A deferRedrive re-issue of an
        // already-`running`/`done` run must NOT spawn a second held executeRun (idempotent startRun
        // returns the existing status). A stuck `pending` (held task died pre-dispatch) is re-kicked.
        if (status === "pending") {
          void runHeldAndDeliver(deps.doDispatch, evalDoRef, runId, agentRef, runArgs.channelId);
        }
        return { runId };
      }

      if (method === "getRun") {
        const getArgs = (args[0] ?? {}) as {
          ownerId?: string;
          contextId?: string;
          subKey?: string;
          runId: string;
        };
        const owner = await resolveOwner(ctx.caller.runtime.kind, ownerId, {
          ownerId: getArgs.ownerId,
          contextId: getArgs.contextId,
        });
        const { objectKey } = await ensureEvalDO(owner, getArgs.subKey ?? "default");
        return deps.doDispatch.dispatch(
          { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          "getRun",
          getArgs.runId
        );
      }
      if (method === "reset") {
        const resetArgs = (args[0] ?? {}) as {
          ownerId?: string;
          contextId?: string;
          subKey?: string;
        };
        const owner = await resolveOwner(ctx.caller.runtime.kind, ownerId, {
          ownerId: resetArgs.ownerId,
          contextId: resetArgs.contextId,
        });
        const { objectKey } = await ensureEvalDO(owner, resetArgs.subKey ?? "default");
        return deps.doDispatch.dispatch(
          { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          "reset"
        );
      }
      if (method === "cancel") {
        const cancelArgs = (args[0] ?? {}) as {
          ownerId?: string;
          contextId?: string;
          subKey?: string;
          runId: string;
        };
        const owner = await resolveOwner(ctx.caller.runtime.kind, ownerId, {
          ownerId: cancelArgs.ownerId,
          contextId: cancelArgs.contextId,
        });
        const { objectKey } = await ensureEvalDO(owner, cancelArgs.subKey ?? "default");
        return deps.doDispatch.dispatch(
          { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          "cancel",
          cancelArgs.runId
        );
      }
      if (method === "forceReset") {
        const forceArgs = (args[0] ?? {}) as {
          ownerId?: string;
          contextId?: string;
          subKey?: string;
        };
        const owner = await resolveOwner(ctx.caller.runtime.kind, ownerId, {
          ownerId: forceArgs.ownerId,
          contextId: forceArgs.contextId,
        });
        const { objectKey } = await ensureEvalDO(owner, forceArgs.subKey ?? "default");
        return deps.doDispatch.dispatch(
          { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          "forceReset"
        );
      }
      throw new Error(`eval: unknown method ${method}`);
    },
  };
}
