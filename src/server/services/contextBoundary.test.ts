import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  CONTEXT_BOUNDARY_CAPABILITY,
  contextBoundaryResourceKey,
  requireContextBoundaryPermission,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";

function tempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ctx-boundary-")), "grants.json");
}

function subjectCaller(id = "panel:p1") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/p",
    effectiveVersion: "v1",
  });
}

function makeDeps(
  opts: {
    decision?: "session" | "deny" | "once";
    exists?: (id: string) => boolean;
    owner?: string;
  } = {}
): ContextBoundaryDeps & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => opts.decision ?? "session");
  return {
    approvalQueue: { request } as never,
    grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    contextExists: opts.exists ?? (() => true),
    resolveContextOwnerLabel: () => opts.owner,
    request,
  };
}

const action = { kind: "runtime" as const, verb: "Create panel" };

afterEach(() => vi.restoreAllMocks());

describe("requireContextBoundaryPermission", () => {
  it("allows same-context actions without prompting", async () => {
    const deps = makeDeps();
    const result = await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-a",
      action,
    });
    expect(result.allowed).toBe(true);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("allows launching into a FRESH foreign context without prompting", async () => {
    const deps = makeDeps({ exists: () => false });
    const result = await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-fresh",
      action,
    });
    expect(result.allowed).toBe(true);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("prompts (once) for an EXISTING foreign context and grants when allowed", async () => {
    const deps = makeDeps({ exists: () => true, owner: "Agent X" });
    const result = await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action,
    });
    expect(result.allowed).toBe(true);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        callerId: "panel:p1",
        grantResourceKey: contextBoundaryResourceKey("ctx-b", "panel:p1"),
      })
    );
  });

  it("denies when the user denies the cross-context prompt", async () => {
    const deps = makeDeps({ decision: "deny" });
    const result = await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("treats a null origin as foreign (gates an existing target)", async () => {
    const deps = makeDeps({ exists: () => true });
    await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller(),
      originContextId: null,
      targetContextId: "ctx-b",
      action,
    });
    expect(deps.request).toHaveBeenCalledTimes(1);
  });

  it("attributes the prompt to the subject caller (never the executing server)", async () => {
    const deps = makeDeps();
    await requireContextBoundaryPermission(deps, {
      subjectCaller: subjectCaller("panel:anchor"),
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action,
    });
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({ callerId: "panel:anchor", callerKind: "panel" })
    );
  });
});
