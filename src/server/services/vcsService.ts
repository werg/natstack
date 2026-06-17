/**
 * vcs service — GAD-native version control RPC surface. External Git interop
 * lives in the dedicated gitInterop service.
 *
 * The caller's working tree is resolved from its context registration:
 * agents/panels operating inside a context commit their `.contexts/{id}`
 * folder onto the `ctx:{id}` head; callers with no context (shell, server)
 * operate on the main workspace head.
 */

import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import {
  vcsMethods,
  type VcsApplyEditsInput,
  type VcsRecallInput,
} from "@natstack/shared/serviceSchemas/vcs";
import { normalizeWorkspaceRepoPath } from "@natstack/shared/workspace/remotes";
import type { WorkspaceVcs } from "../gadVcs/workspaceVcs.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../gadVcs/store.js";
import { unitStatusFromHead } from "./vcsStatus.js";
import type {
  MainAdvanceApprovalCandidate,
  MainAdvanceApprovalGate,
} from "./mainAdvanceApproval.js";

export interface VcsServiceDeps {
  workspaceVcs: WorkspaceVcs;
  entityCache?: Pick<EntityCache, "resolveContext">;
  getBuildSystem?: () => BuildSystemV2 | null;
  mainAdvanceGate?: MainAdvanceApprovalGate;
}

/** Resolve the caller's default head: context callers → their ctx head, else main. */
function headForCaller(ctx: ServiceContext, deps: VcsServiceDeps): string {
  const contextCallerId =
    ctx.caller.runtime.kind === "extension" && ctx.chainCaller
      ? ctx.chainCaller.callerId
      : ctx.caller.runtime.id;
  const contextId = deps.entityCache?.resolveContext(contextCallerId) ?? null;
  return contextId ? vcsContextHead(contextId) : VCS_MAIN_HEAD;
}

/** Shell/server/harness are user-level surfaces; everything else (panel,
 *  app, worker, do, extension) is sandboxed code whose writes are confined
 *  to its own context head. */
function isPrivilegedCaller(ctx: ServiceContext): boolean {
  return (
    ctx.caller.runtime.kind === "shell" ||
    ctx.caller.runtime.kind === "server" ||
    ctx.caller.runtime.kind === "harness"
  );
}

/**
 * Authorization gate for HEAD WRITES (commit, merge target, abortMerge).
 * Policy:
 *
 * - shell / server / harness: may write any head (user-level surfaces).
 * - entity callers (panel, app, worker, do, extension): may write ONLY their
 *   own `ctx:{id}` head. A caller with no context registration gets an
 *   ERROR, never a silent fallthrough to main — main is user-owned; the
 *   publish path for sandboxed code is a privileged merge of its ctx head.
 */
function resolveWriteHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  requestedHead: string | undefined
): string {
  const callerKind = ctx.caller.runtime.kind;
  if (isPrivilegedCaller(ctx)) return requestedHead ?? headForCaller(ctx, deps);
  const contextCallerId =
    callerKind === "extension" && ctx.chainCaller
      ? ctx.chainCaller.callerId
      : ctx.caller.runtime.id;
  const contextId = deps.entityCache?.resolveContext(contextCallerId) ?? null;
  if (!contextId) {
    throw new Error(
      `vcs head writes require a context: caller ${ctx.caller.runtime.id} (${callerKind}) has no ` +
        `context registration. Writes to ${VCS_MAIN_HEAD} are reserved for shell/server callers.`
    );
  }
  const ownHead = vcsContextHead(contextId);
  if (requestedHead && requestedHead !== ownHead) {
    throw new Error(
      `Callers may only write their own context head (${ownHead}), not ${requestedHead}` +
        (requestedHead === VCS_MAIN_HEAD
          ? ` — publishing to ${VCS_MAIN_HEAD} goes through a shell/server merge`
          : "")
    );
  }
  return ownHead;
}

function mainAdvanceHook(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  input: Omit<MainAdvanceApprovalCandidate, "event" | "caller">
) {
  if (!deps.mainAdvanceGate) return undefined;
  return async (event: MainAdvanceApprovalCandidate["event"]) => {
    if (event.head !== VCS_MAIN_HEAD) return;
    await deps.mainAdvanceGate?.approve({
      ...input,
      event,
      caller: ctx.caller,
    });
  };
}

function mainAdvanceOptions(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  input: Omit<MainAdvanceApprovalCandidate, "event" | "caller">
) {
  const beforeAdvance = mainAdvanceHook(ctx, deps, input);
  return beforeAdvance ? { beforeAdvance } : {};
}

function looksLikeWorkspacePath(value: string): boolean {
  return (
    value === "." ||
    value === "/" ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("/")
  );
}

function resolveReadHeadArg(
  method: "status" | "publishStatus" | "pendingMerge",
  requested: string | undefined,
  ctx: ServiceContext,
  deps: VcsServiceDeps
): string {
  if (!requested) return headForCaller(ctx, deps);
  if (looksLikeWorkspacePath(requested)) {
    throw new Error(
      `vcs.${method} expects an optional materialized VCS head, not a filesystem path (${JSON.stringify(requested)}). ` +
        `Omit the argument for the current context head. Use vcs.unitStatus(repoPath) to scope status to a workspace unit, or vcs.resolveHead(ref) for arbitrary refs.`
    );
  }
  if (requested !== VCS_MAIN_HEAD && !requested.startsWith("ctx:")) {
    throw new Error(
      `vcs.${method} expects an optional materialized VCS head ("main" or "ctx:..."), not ${JSON.stringify(requested)}. ` +
        `Omit the argument for the current context head. Use vcs.resolveHead(ref) for arbitrary refs or vcs.diff(leftStateHash, rightStateHash) for state comparisons.`
    );
  }
  return requested;
}

function assertStateHashArg(method: string, value: string, position: "left" | "right"): void {
  if (!value.startsWith("state:")) {
    throw new Error(
      `vcs.${method} expects ${position} to be a GAD state hash such as "state:...", not ${JSON.stringify(value)}. ` +
        `Use vcs.resolveHead(head).stateHash or the stateHash returned by vcs.applyEdits before diffing.`
    );
  }
}

export function createVcsService(deps: VcsServiceDeps): ServiceDefinition {
  return {
    name: "vcs",
    description: "Workspace version control (GAD-native): commit, status, log, diff",
    policy: {
      allowed: ["shell", "panel", "app", "server", "worker", "do", "extension", "harness"],
    },
    methods: vcsMethods,
    handler: async (ctx, method, args) => {
      const vcs = deps.workspaceVcs;
      switch (method) {
        case "applyEdits": {
          // Edit-first write — same head-write gate as commit; actor is derived
          // from the verified caller (never client-supplied).
          const [input] = args as [VcsApplyEditsInput];
          const head = resolveWriteHead(ctx, deps, input.head);
          const baseStateHash = input.baseStateHash ?? (await vcs.resolveHead(head));
          if (!baseStateHash) {
            throw new Error(`vcs.applyEdits: head ${head} has no base state to edit`);
          }
          const result = await vcs.applyEdits({
            head,
            baseStateHash,
            edits: input.edits,
            actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            ...(head === VCS_MAIN_HEAD
              ? mainAdvanceOptions(ctx, deps, { operation: "apply-edits" })
              : {}),
          });
          if (result.status === "clean") await deps.getBuildSystem?.()?.whenSettled();
          return result;
        }
        case "readFile": {
          const [ref, filePath] = args as [string, string];
          // Empty ref → the caller's default head. Non-empty refs are explicit:
          // VCS reads are not isolated by caller; only writes are gated.
          const resolvedRef = ref || headForCaller(ctx, deps);
          return await vcs.readFile(resolvedRef, filePath);
        }
        case "listFiles": {
          const ref = args[0] as string | undefined;
          const resolvedRef = ref || headForCaller(ctx, deps);
          return await vcs.listFiles(resolvedRef);
        }
        case "revert": {
          // Revert WRITES the caller's head (forward-applied inverse patch) —
          // same head-write gate as commit/applyEdits.
          const [target] = args as [{ stateHash?: string; eventId?: string; head?: string }];
          const head = resolveWriteHead(ctx, deps, target.head);
          const result = await vcs.revert({
            head,
            target: { stateHash: target.stateHash, eventId: target.eventId },
            actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            ...(head === VCS_MAIN_HEAD
              ? mainAdvanceOptions(ctx, deps, { operation: "revert" })
              : {}),
          });
          if (result.status === "clean") await deps.getBuildSystem?.()?.whenSettled();
          return result;
        }
        case "status": {
          const head = resolveReadHeadArg("status", args[0] as string | undefined, ctx, deps);
          return await vcs.statusHead(head);
        }
        case "unitStatus": {
          const [repoArg, requestedHead] = args as [string, string | undefined];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = requestedHead ?? headForCaller(ctx, deps);
          return unitStatusFromHead(repoPath, head, await vcs.statusHead(head));
        }
        case "log": {
          const [limitArg, requestedHead] = args as [number | undefined, string | undefined];
          const limit = limitArg ?? 50;
          const head = requestedHead ?? headForCaller(ctx, deps);
          return await vcs.readVcsLog(limit, head);
        }
        case "diff": {
          const [left, right] = args as [string, string];
          assertStateHashArg("diff", left, "left");
          assertStateHashArg("diff", right, "right");
          return await vcs.vcs.diffStates(left, right);
        }
        case "resolveHead": {
          const [head] = args as [string];
          return { head, stateHash: await vcs.resolveHead(head) };
        }
        case "merge": {
          // merge(sourceHead) into the caller's head, or merge(source, target).
          // The merge TARGET is a head write — same gate as commit
          // (resolveWriteHead: privileged callers any head, entity callers
          // only their own ctx head, no-context entity callers error).
          const [sourceHead, targetArg] = args as [string, string | undefined];
          const targetHead = resolveWriteHead(ctx, deps, targetArg);
          const result = await vcs.mergeHeads(targetHead, sourceHead, {
            actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            ...(targetHead === VCS_MAIN_HEAD
              ? mainAdvanceOptions(ctx, deps, {
                  operation: "merge",
                  sourceHead,
                })
              : {}),
          });
          if (result.status === "merged") {
            await deps.getBuildSystem?.()?.whenSettled();
          }
          return result;
        }
        case "abortMerge": {
          // Restores the target's tree — a head write.
          const targetHead = resolveWriteHead(ctx, deps, args[0] as string | undefined);
          return await vcs.abortMerge(targetHead, {
            actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            ...(targetHead === VCS_MAIN_HEAD
              ? mainAdvanceOptions(ctx, deps, { operation: "abort-merge" })
              : {}),
          });
        }
        case "pendingMerge": {
          const targetHead = resolveReadHeadArg(
            "pendingMerge",
            args[0] as string | undefined,
            ctx,
            deps
          );
          return await vcs.pendingMerge(targetHead);
        }
        case "publishStatus": {
          // How far the caller's ctx head is ahead of main (unpublished count).
          const requested = args[0] as string | undefined;
          const head = resolveReadHeadArg("publishStatus", requested, ctx, deps);
          return await vcs.publishStatus(head);
        }
        case "publish": {
          // The privileged ctx→main path: a panel/app/shell caller may write
          // ONLY by deliberately publishing its own context head into main.
          // This is the one sanctioned escalation past resolveWriteHead — and
          // it's denied to autonomous agents (do/worker), who must never move
          // main on their own.
          const callerKind = ctx.caller.runtime.kind;
          if (callerKind === "do" || callerKind === "worker") {
            throw new Error(`vcs.publish is reserved for user-facing callers, not ${callerKind}`);
          }
          const callerHead = headForCaller(ctx, deps);
          const requested = args[0] as string | undefined;
          let sourceHead = callerHead;
          if (requested && requested !== callerHead) {
            if (!isPrivilegedCaller(ctx)) {
              throw new Error(`Callers may only publish their own context head (${callerHead})`);
            }
            sourceHead = requested;
          }
          if (sourceHead === VCS_MAIN_HEAD) {
            throw new Error("vcs.publish: no context head to publish (caller is already on main)");
          }
          const result = await vcs.mergeHeads(VCS_MAIN_HEAD, sourceHead, {
            actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            ...mainAdvanceOptions(ctx, deps, {
              operation: "publish",
              sourceHead,
            }),
          });
          if (result.status === "merged") await deps.getBuildSystem?.()?.whenSettled();
          if (result.status === "conflicted") {
            // A panel/app caller cannot resolve OR abort a merge parked on main,
            // so a conflicted publish must NOT leave main wedged. Roll it back
            // here (publish runs in the privileged server context) and report
            // conflicted; the caller re-pulls main into its OWN context head
            // (where the conflict IS resolvable) and re-publishes.
            await vcs.abortMerge(VCS_MAIN_HEAD, {
              actor: { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind },
            });
          }
          return result;
        }
        case "recall": {
          const [input] = args as [VcsRecallInput];
          return await vcs.recallMemory(input);
        }
        default:
          throw new Error(`Unknown vcs method: ${method}`);
      }
    },
  };
}
