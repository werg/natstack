/**
 * vcs service — GAD-native version control RPC surface. External Git interop
 * lives in the dedicated gitInterop service.
 *
 * The caller's working tree is resolved from its context registration:
 * runtime entities operating inside a context commit their `.contexts/{id}`
 * folder onto the `ctx:{id}` head; callers with no context (shell, server)
 * operate on the main workspace head.
 */

import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import { splitRepoPath } from "@natstack/shared/runtime/entitySpec";
import {
  vcsMethods,
  vcsApplyEditsInputSchema,
  type VcsRecallInput,
  type VcsPushInput,
} from "@natstack/shared/serviceSchemas/vcs";
import { normalizeWorkspaceRepoPath } from "@natstack/shared/workspace/remotes";
import type { WorkspaceVcs } from "../gadVcs/workspaceVcs.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { VCS_MAIN_HEAD, vcsContextHead } from "../gadVcs/store.js";
import type {
  MainAdvanceApprovalCandidate,
  MainAdvanceApprovalGate,
} from "./mainAdvanceApproval.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

export interface VcsServiceDeps {
  workspaceVcs: WorkspaceVcs;
  entityCache?: Pick<EntityCache, "resolveContext">;
  getBuildSystem?: () => BuildSystemV2 | null;
  mainAdvanceGate?: MainAdvanceApprovalGate;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}

/** The caller's own context id (extensions resolve through their chained caller). */
function callerContextId(ctx: ServiceContext, deps: VcsServiceDeps): string | null {
  const contextCallerId =
    ctx.caller.runtime.kind === "extension" && ctx.chainCaller
      ? ctx.chainCaller.callerId
      : ctx.caller.runtime.id;
  return deps.entityCache?.resolveContext(contextCallerId) ?? null;
}

/** Resolve the caller's default head: context callers → their ctx head, else main. */
function headForCaller(ctx: ServiceContext, deps: VcsServiceDeps): string {
  const contextId = callerContextId(ctx, deps);
  return contextId ? vcsContextHead(contextId) : VCS_MAIN_HEAD;
}

/** Shell/server are user-level surfaces; everything else (panel,
 *  app, worker, do, extension) is sandboxed code whose writes are confined
 *  to its own context head. */
function isPrivilegedCaller(ctx: ServiceContext, deps: VcsServiceDeps): boolean {
  return isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability });
}

/**
 * Authorization gate for HEAD WRITES (commit, merge target, abortMerge).
 * Policy:
 *
 * - shell / server: may write any head (user-level surfaces).
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
  if (isPrivilegedCaller(ctx, deps)) return requestedHead ?? headForCaller(ctx, deps);
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

function resolvePushSourceHead(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  requestedHead: string | undefined
): string {
  if (requestedHead) {
    if (isPrivilegedCaller(ctx, deps)) return requestedHead;
    const ownHead = headForCaller(ctx, deps);
    if (ownHead === VCS_MAIN_HEAD) {
      throw new Error(
        `vcs.push from ${ctx.caller.runtime.kind} requires a context; no context head is registered`
      );
    }
    if (requestedHead !== ownHead) {
      throw new Error(
        `Callers may only push their own context head (${ownHead}), not ${requestedHead}`
      );
    }
    return requestedHead;
  }

  const ownHead = headForCaller(ctx, deps);
  if (ownHead === VCS_MAIN_HEAD) {
    throw new Error(
      "vcs.push requires a source context head. Call from a registered context, or pass sourceHead explicitly from shell/server."
    );
  }
  return ownHead;
}

function routeWorkspacePath(filePath: string): { repoPath: string; repoRelPath: string } | null {
  const split = splitRepoPath(filePath);
  if (!split) return null;
  if (!split.repoRelPath) {
    throw new Error(
      `vcs.edit path ${JSON.stringify(filePath)} names a workspace repo root. ` +
        repoRootWriteHint(split.repoPath)
    );
  }
  // Validate the routed repo name (segment safety) — vcs edits gate on `main`,
  // so this is the authoritative boundary check.
  return { repoPath: normalizeWorkspaceRepoPath(split.repoPath), repoRelPath: split.repoRelPath };
}

function repoRootWriteHint(repoPath: string): string {
  const segments = repoPath.split("/");
  const leaf = segments.at(-1) ?? repoPath;
  if (segments.length >= 2 && /\.[^/.]+$/.test(leaf)) {
    const repoName = leaf.replace(/\.[^/.]+$/, "");
    const section = segments.slice(0, -1).join("/");
    return `Write a file inside a repo-shaped path instead, e.g. ${section}/${repoName}/${leaf}.`;
  }
  return `Write a file inside the repo instead, e.g. ${repoPath}/README.md.`;
}

function stripRepoPath(filePath: string, repoPath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const repo = normalizeWorkspaceRepoPath(repoPath);
  return normalized === repo
    ? ""
    : normalized.startsWith(`${repo}/`)
      ? normalized.slice(repo.length + 1)
      : normalized;
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
  method: "status" | "pendingMerge",
  requested: string | undefined,
  ctx: ServiceContext,
  deps: VcsServiceDeps
): string {
  if (!requested) return headForCaller(ctx, deps);
  if (looksLikeWorkspacePath(requested)) {
    throw new Error(
      `vcs.${method} expects an optional materialized VCS head, not a filesystem path (${JSON.stringify(requested)}). ` +
        `Omit the argument for the current context head. Use vcs.resolveHead(ref) for arbitrary refs.`
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

function assertStateHashArg(method: string, value: string, position: string): void {
  if (!value.startsWith("state:")) {
    throw new Error(
      `vcs.${method} expects ${position} to be a GAD state hash such as "state:...", not ${JSON.stringify(value)}. ` +
        `Use vcs.resolveHead(head).stateHash or the stateHash returned by vcs.edit before diffing.`
    );
  }
}

export function createVcsService(deps: VcsServiceDeps): ServiceDefinition {
  return {
    name: "vcs",
    description: "Workspace version control (GAD-native): commit, status, log, diff",
    policy: {
      allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"],
    },
    methods: vcsMethods,
    handler: async (ctx, method, args) => {
      const vcs = deps.workspaceVcs;
      const actor = { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind };
      switch (method) {
        case "edit": {
          // Working edit — tracked, NOT a commit. Actor is the verified caller.
          // Per-repo: edits route by path to their owning repo's ctx head.
          const input = vcsApplyEditsInputSchema.parse(args[0]);
          const head = resolveWriteHead(ctx, deps, input.head);
          const repoPath = input.repoPath ? normalizeWorkspaceRepoPath(input.repoPath) : undefined;
          const groups = new Map<string, typeof input.edits>();
          if (repoPath) {
            groups.set(repoPath, input.edits);
          } else {
            for (const edit of input.edits) {
              const routed = routeWorkspacePath(edit.path);
              if (!routed) {
                throw new Error(
                  `vcs.edit could not infer a repo for ${JSON.stringify(edit.path)}. ` +
                    `Pass repoPath and repo-relative edit paths, or use a workspace path under a repo section.`
                );
              }
              const list = groups.get(routed.repoPath) ?? [];
              list.push({ ...edit, path: routed.repoRelPath } as (typeof input.edits)[number]);
              groups.set(routed.repoPath, list);
            }
          }
          if (groups.size === 0) throw new Error("vcs.edit requires at least one edit");
          if (groups.size > 1 && input.baseStateHash !== undefined) {
            throw new Error(
              "vcs.edit cannot enforce baseStateHash across multiple repos; " +
                "split the edit by repo or omit baseStateHash"
            );
          }
          const results: Awaited<ReturnType<typeof vcs.recordEdit>>[] = [];
          for (const [editRepoPath, repoEdits] of groups) {
            results.push(
              await vcs.recordEdit({
                head,
                edits: repoEdits,
                actor,
                repoPath: editRepoPath,
                ...(groups.size === 1 && input.baseStateHash
                  ? { baseStateHash: input.baseStateHash }
                  : {}),
                // Provenance edge into the agentic trajectory (self-asserted by
                // the calling agent runtime; the edit tool passes its toolCallId).
                ...(input.invocationId ? { invocationId: input.invocationId } : {}),
              })
            );
          }
          if (results.length === 1) return results[0]!;
          // Aggregate a multi-repo edit into one working result.
          return {
            head,
            stateHash: head.startsWith("ctx:")
              ? await vcs.resolveContextView(head.slice("ctx:".length))
              : (await vcs.workspaceView()).stateHash,
            committed: false as const,
            status: "uncommitted" as const,
            editSeq: results.reduce((m, r) => Math.max(m, r.editSeq), 0),
            changedPaths: results.flatMap((r) => r.changedPaths),
          };
        }
        case "commit": {
          const [input] = args as [import("@natstack/shared/serviceSchemas/vcs").VcsCommitInput];
          if (!input.message || !input.message.trim()) {
            throw new Error("vcs.commit requires a message");
          }
          const head = resolveWriteHead(ctx, deps, input.head);
          if (head === VCS_MAIN_HEAD) {
            throw new Error("vcs.commit: main advances only via push; commit a ctx:* head");
          }
          const contextId = head.startsWith("ctx:") ? head.slice("ctx:".length) : null;
          // Repos to commit: explicit, else every repo with uncommitted edits.
          let repoPaths: string[];
          if (input.repoPaths && input.repoPaths.length > 0) {
            repoPaths = input.repoPaths.map((r) => normalizeWorkspaceRepoPath(r));
          } else if (contextId) {
            repoPaths = (await vcs.contextStatus(contextId))
              .filter((r) => r.uncommitted)
              .map((r) => r.repoPath);
          } else {
            repoPaths = [];
          }
          // Exclude paths route to their repo (repo-relative) for filtering.
          const excludeByRepo = new Map<string, string[]>();
          for (const p of input.exclude ?? []) {
            const routed = routeWorkspacePath(p);
            if (routed) {
              const list = excludeByRepo.get(routed.repoPath) ?? [];
              list.push(routed.repoRelPath);
              excludeByRepo.set(routed.repoPath, list);
            }
          }
          const out = [];
          for (const repoPath of repoPaths) {
            const result = await vcs.commit({
              head,
              repoPath,
              message: input.message,
              actor,
              ...(excludeByRepo.has(repoPath) ? { exclude: excludeByRepo.get(repoPath)! } : {}),
            });
            out.push({ repoPath: normalizeWorkspaceRepoPath(repoPath), ...result });
          }
          return out;
        }
        case "discardEdits": {
          const [repoArg, headArg] = args as [string, string | undefined];
          const head = resolveWriteHead(ctx, deps, headArg);
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return await vcs.discardEdits({ head, repoPath });
        }
        case "commitEdits": {
          const [repoArg, target] = args as [string, { eventId: string }];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return await vcs.listCommitEdits(repoPath, target.eventId);
        }
        case "fileHistory": {
          const [repoArg, pathArg, headArg, limitArg] = args as [
            string,
            string,
            string | undefined,
            number | undefined,
          ];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return await vcs.fileHistory(repoPath, pathArg, headArg, limitArg);
        }
        case "commitAncestors": {
          const [repoArg, eventIdArg, limitArg] = args as [string, string, number | undefined];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return await vcs.commitAncestors(repoPath, eventIdArg, limitArg);
        }
        case "editsByActor": {
          const [actorId, limitArg] = args as [string, number | undefined];
          return await vcs.editsByActor(actorId, limitArg);
        }
        case "editsByTurn": {
          const [turnId] = args as [string];
          return await vcs.editsByTurn(turnId);
        }
        case "editsByInvocation": {
          const [invocationId] = args as [string];
          return await vcs.editsByInvocation(invocationId);
        }
        case "previewBuild": {
          const [input] = args as [{ repoPaths?: string[]; units?: string[]; head?: string }];
          const head = input.head
            ? resolveWriteHead(ctx, deps, input.head)
            : headForCaller(ctx, deps);
          return await vcs.previewBuild({
            head,
            ...(input.repoPaths
              ? { repoPaths: input.repoPaths.map((r) => normalizeWorkspaceRepoPath(r)) }
              : {}),
            ...(input.units ? { units: input.units } : {}),
            getBuildSystem: () => deps.getBuildSystem?.() ?? null,
          });
        }
        case "readFile": {
          const [ref, filePath, repoArg] = args as [string, string, string | undefined];
          const resolvedRef = ref || headForCaller(ctx, deps);
          if (repoArg) {
            const repoPath = normalizeWorkspaceRepoPath(repoArg);
            const repoRelPath = stripRepoPath(filePath, repoPath);
            if (resolvedRef.startsWith("ctx:")) {
              const stateHash = await vcs.contextRepoState(
                resolvedRef.slice("ctx:".length),
                repoPath
              );
              return stateHash ? await vcs.readFile(stateHash, repoRelPath) : null;
            }
            return await vcs.readFile(resolvedRef, repoRelPath, repoPath);
          }
          const routed = routeWorkspacePath(filePath);
          if (routed && resolvedRef.startsWith("ctx:")) {
            const stateHash = await vcs.contextRepoState(
              resolvedRef.slice("ctx:".length),
              routed.repoPath
            );
            return stateHash ? await vcs.readFile(stateHash, routed.repoRelPath) : null;
          }
          if (routed && !resolvedRef.startsWith("state:")) {
            return await vcs.readFile(resolvedRef, routed.repoRelPath, routed.repoPath);
          }
          const stateRef = resolvedRef.startsWith("ctx:")
            ? await vcs.resolveContextView(resolvedRef.slice("ctx:".length))
            : resolvedRef === VCS_MAIN_HEAD
              ? (await vcs.workspaceView()).stateHash
              : resolvedRef;
          return await vcs.readFile(stateRef, filePath);
        }
        case "listFiles": {
          const [ref, repoArg] = args as [string | undefined, string | undefined];
          const resolvedRef = ref || headForCaller(ctx, deps);
          if (repoArg) {
            const repoPath = normalizeWorkspaceRepoPath(repoArg);
            if (resolvedRef.startsWith("ctx:")) {
              const stateHash = await vcs.contextRepoState(
                resolvedRef.slice("ctx:".length),
                repoPath
              );
              return stateHash ? await vcs.listFiles(stateHash) : [];
            }
            return await vcs.listFiles(resolvedRef, repoPath);
          }
          const stateRef = resolvedRef.startsWith("ctx:")
            ? await vcs.resolveContextView(resolvedRef.slice("ctx:".length))
            : resolvedRef === VCS_MAIN_HEAD
              ? (await vcs.workspaceView()).stateHash
              : resolvedRef;
          return await vcs.listFiles(stateRef);
        }
        case "revert": {
          // A revert lands as a WORKING edit (inverse patch) — no commit, no
          // build; the caller commits it later. Rejects a `main` head.
          const [target] = args as [
            { stateHash?: string; eventId?: string; head?: string; repoPath: string },
          ];
          const head = resolveWriteHead(ctx, deps, target.head);
          const repoPath = normalizeWorkspaceRepoPath(target.repoPath);
          return await vcs.revert({
            head,
            target: { stateHash: target.stateHash, eventId: target.eventId },
            actor,
            repoPath,
          });
        }
        case "status": {
          const [repoArg, headArg] = args as [string, string | undefined];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = resolveReadHeadArg("status", headArg, ctx, deps);
          return await vcs.statusHead(head, repoPath);
        }
        case "log": {
          const [repoArg, limitArg, requestedHead] = args as [
            string,
            number | undefined,
            string | undefined,
          ];
          const limit = limitArg ?? 50;
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = requestedHead ?? headForCaller(ctx, deps);
          return await vcs.readVcsLog(limit, head, repoPath);
        }
        case "diff": {
          const [left, right] = args as [string, string];
          assertStateHashArg("diff", left, "left");
          assertStateHashArg("diff", right, "right");
          return await vcs.vcs.diffStates(left, right);
        }
        case "resolveHead": {
          const [requested, repoArg] = args as [string | undefined, string];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const head = requested ?? headForCaller(ctx, deps);
          return { head, stateHash: await vcs.resolveHead(head, repoPath) };
        }
        case "workspaceViewWithRepoAt": {
          const [repoArg, stateHash] = args as [string, string | null];
          if (stateHash !== null)
            assertStateHashArg("workspaceViewWithRepoAt", stateHash, "stateHash");
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          return { stateHash: await vcs.workspaceViewWithRepoAt(repoPath, stateHash) };
        }
        case "merge": {
          // Explicit reconcile: pull `main` into the caller's context head on a
          // repo → a merge commit (no main approval; the ctx head advances).
          const [repoArg, headArg] = args as [string, string | undefined];
          const repoPath = normalizeWorkspaceRepoPath(repoArg);
          const targetHead = resolveWriteHead(ctx, deps, headArg);
          if (targetHead === VCS_MAIN_HEAD) {
            throw new Error(
              "vcs.merge targets a ctx:* head (pulls main into it); main advances via push"
            );
          }
          return await vcs.mergeHeads(targetHead, VCS_MAIN_HEAD, { actor, repoPath });
        }
        case "mergeGroup": {
          const [entries] = args as [
            Array<{ repoPath: string; sourceHead: string; targetHead?: string }>,
          ];
          const normalizedEntries = entries.map((e) => ({
            repoPath: normalizeWorkspaceRepoPath(e.repoPath),
            sourceHead: e.sourceHead,
            targetHead: resolveWriteHead(ctx, deps, e.targetHead),
          }));
          return await vcs.mergeGroup(normalizedEntries, { actor });
        }
        case "abortMerge": {
          const [repoArg, headArg] = args as [string | undefined, string | undefined];
          const targetHead = resolveWriteHead(ctx, deps, headArg);
          const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
          if (!repoPath) {
            throw new Error("vcs.abortMerge requires repoPath in the per-repo VCS model");
          }
          return await vcs.abortMerge(targetHead, {
            actor,
            repoPath,
            ...(targetHead === VCS_MAIN_HEAD
              ? mainAdvanceOptions(ctx, deps, { operation: "abort-merge" })
              : {}),
          });
        }
        case "pendingMerge": {
          const [repoArg, headArg] = args as [string | undefined, string | undefined];
          const targetHead = resolveReadHeadArg("pendingMerge", headArg, ctx, deps);
          const repoPath = repoArg ? normalizeWorkspaceRepoPath(repoArg) : undefined;
          if (!repoPath) {
            throw new Error("vcs.pendingMerge requires repoPath in the per-repo VCS model");
          }
          return await vcs.pendingMerge(targetHead, repoPath);
        }
        case "push": {
          // Per-repo, build-gated push (W4). Group push (multiple repos) is
          // atomic at the store layer (ingestRepoGroup). Routed through the
          // main-advance approval gate.
          const [input] = args as [VcsPushInput];
          const repoPaths = input.repoPaths.map((r) => normalizeWorkspaceRepoPath(r));
          const sourceHead = resolvePushSourceHead(ctx, deps, input.sourceHead);
          return await vcs.push({
            repoPaths,
            sourceHead,
            ...(input.message ? { message: input.message } : {}),
            actor,
            ...mainAdvanceOptions(ctx, deps, { operation: "push", sourceHead }),
            // BuildSystemV2 satisfies RepoPushValidator structurally — no cast.
            getBuildSystem: () => deps.getBuildSystem?.() ?? null,
          });
        }
        case "pushStatus": {
          const [repoArgs] = args as [string[]];
          const repoPaths = repoArgs.map((r) => normalizeWorkspaceRepoPath(r));
          const head = headForCaller(ctx, deps);
          return await Promise.all(repoPaths.map((repoPath) => vcs.pushStatus(repoPath, head)));
        }
        case "recall": {
          const [input] = args as [VcsRecallInput];
          return await vcs.recallMemory(input);
        }
        case "forkRepo": {
          const [fromPath, toPath] = args as [string, string];
          return await vcs.forkRepo(
            normalizeWorkspaceRepoPath(fromPath),
            normalizeWorkspaceRepoPath(toPath),
            actor
          );
        }
        case "deleteRepo": {
          // Severe, global-state action: archive a repo's history and remove it
          // from workspace main. Gated by a dedicated per-repo deletion approval
          // (NOT the generic write grant) via the beforeDelete hook.
          const [input] = args as [{ repoPath: string; force?: boolean }];
          const repoPath = normalizeWorkspaceRepoPath(input.repoPath);
          const result = await vcs.deleteRepo({
            repoPath,
            actor,
            ...(input.force ? { force: true } : {}),
            ...(deps.mainAdvanceGate
              ? {
                  beforeDelete: async ({ fileCount, stateHash, dependents }) =>
                    deps.mainAdvanceGate!.approveRepoDeletion({
                      caller: ctx.caller,
                      repoPath,
                      fileCount,
                      stateHash,
                      dependents,
                    }),
                }
              : {}),
          });
          await deps.getBuildSystem?.()?.whenSettled();
          return result;
        }
        case "restoreRepo": {
          // Recover a deleted repo: re-point main at its archive head. Fails if a
          // different repo now occupies the path. Gated by a (standard) restore
          // approval via the beforeRestore hook.
          const [input] = args as [{ repoPath: string }];
          const repoPath = normalizeWorkspaceRepoPath(input.repoPath);
          const result = await vcs.restoreRepo({
            repoPath,
            actor,
            ...(deps.mainAdvanceGate
              ? {
                  beforeRestore: async ({ fileCount, stateHash }) =>
                    deps.mainAdvanceGate!.approveRepoRestore({
                      caller: ctx.caller,
                      repoPath,
                      fileCount,
                      stateHash,
                    }),
                }
              : {}),
          });
          await deps.getBuildSystem?.()?.whenSettled();
          return result;
        }
        case "contextStatus": {
          const contextId = callerContextId(ctx, deps);
          if (!contextId) throw new Error("vcs.contextStatus requires an active context");
          return await vcs.contextStatus(contextId);
        }
        case "rebaseContext": {
          const contextId = callerContextId(ctx, deps);
          if (!contextId) throw new Error("vcs.rebaseContext requires an active context");
          return await vcs.rebaseContext(contextId, actor);
        }
        default:
          throw new Error(`Unknown vcs method: ${method}`);
      }
    },
  };
}
