import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { createEvalService } from "./evalService.js";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";

const WORKSPACE_REF = {
  source: INTERNAL_DO_SOURCE,
  className: "WorkspaceDO",
  objectKey: "ws_1",
};

function evalKey(ownerId: string, subKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${subKey}`).digest("hex").slice(0, 40);
}

function createHarness(contexts: Record<string, string | null>) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  const doDispatch = {
    async dispatchHeld(
      this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
      ref: unknown,
      method: string,
      ...args: unknown[]
    ) {
      return this.dispatch(ref, method, ...args);
    },
    async dispatch(ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") {
        return contexts[String(args[0])] ?? null;
      }
      if (method === "entityActivate") {
        return undefined;
      }
      if (method === "entityResolve") {
        // No lineage in the mock → resolveParentPanel walk ends with no parent.
        return null;
      }
      if (method === "slotResolveByEntity") {
        // No panel slots in the mock → resolveParentPanel resolves to no owning panel.
        return null;
      }
      if (method === "run") {
        return { success: true, console: "", scopeKeys: [] };
      }
      if (method === "reset") {
        return { ok: true };
      }
      if (method === "cancel") {
        return { ok: true };
      }
      if (method === "forceReset") {
        return { ok: true };
      }
      if (method === "startRun") {
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      }
      if (method === "executeRun") {
        return { success: true, console: "ok", scopeKeys: [] };
      }
      if (method === "getRun") {
        return { status: "done", result: { success: true, console: "", scopeKeys: [] } };
      }
      if (method === "onEvalComplete") {
        return undefined;
      }
      throw new Error(`unexpected dispatch ${method}`);
    },
  } as unknown as DODispatch;
  // A real store over the mocked dispatch + cache: entity ops (activate /
  // resolveContext) flow through it to `doDispatch`, so `calls` still captures
  // them — exactly the path the eval service exercises in production.
  const entityCache = {
    resolveContext(id: string) {
      return contexts[id] ?? null;
    },
    // Always a cache miss → ensureEvalDO takes the activate path, so the existing
    // entityActivate-dispatch assertions still hold.
    resolveActive() {
      return null;
    },
    // Cache miss for the parent-resolution walk → falls back to entityResolve.
    resolve() {
      return null;
    },
    _onActivate() {},
    _onRetire() {},
  } as unknown as EntityCache;
  const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws_1", entityCache });
  const service = createEvalService({
    doDispatch,
    entityStore,
    tokenManager: {
      ensureToken: (callerId: string) => `tok:${callerId}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
  });
  return { service, calls };
}

describe("createEvalService", () => {
  it("runs CLI eval as the selected session owner and context", async () => {
    const { service, calls } = createHarness({ "session:default": "ctx_1" });

    await service.handler({ caller: createVerifiedCaller("shell:dev_cli", "shell") }, "run", [
      {
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        code: "return 1;",
      },
    ]);

    const objectKey = evalKey("session:default", "default");
    expect(calls[0]).toEqual({
      ref: WORKSPACE_REF,
      method: "entityActivate",
      args: [
        {
          kind: "do",
          source: { repoPath: INTERNAL_DO_SOURCE, effectiveVersion: "internal" },
          contextId: "ctx_1",
          className: "EvalDO",
          key: objectKey,
          // The EvalDO's launch parent IS its owner — bridges the lineage so entities spawned FROM an
          // eval (e.g. headless sub-agents) resolve up through the owner to the owner's panel.
          parentId: "session:default",
          stateArgs: { ownerPrincipalId: "session:default", subKey: "default" },
        },
      ],
    });
    expect(calls.find((c) => c.method === "run")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      method: "run",
      args: [
        expect.objectContaining({
          code: "return 1;",
          contextId: "ctx_1",
        }),
      ],
    });
  });

  it("keeps entity callers bound to their verified runtime owner", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "run", [
      { subKey: "chan_1", channelId: "chan_1", code: "return 1;" },
    ]);

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls[0]).toMatchObject({
      method: "entityActivate",
      args: [
        expect.objectContaining({
          contextId: "ctx_agent",
          key: objectKey,
          stateArgs: { ownerPrincipalId: ownerId, subKey: "chan_1" },
        }),
      ],
    });
    expect(calls.find((c) => c.method === "run")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      method: "run",
      args: [
        expect.objectContaining({
          contextId: "ctx_agent",
          channelId: "chan_1",
          agentRef: ownerId,
        }),
      ],
    });
  });

  it("resolves the eval's parent as the agent caller's owning panel (lineage walk)", async () => {
    // Lineage: an agent DO whose launch parent (recorded at createEntity) is a panel.
    const rec = (
      over: Partial<EntityRecord> & { id: string; kind: EntityRecord["kind"] }
    ): EntityRecord => ({
      source: { repoPath: "src", effectiveVersion: "v" },
      contextId: "ctx_agent",
      key: over.id,
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
      ...over,
    });
    const records: Record<string, EntityRecord> = {
      "do:src:Agent:k": rec({ id: "do:src:Agent:k", kind: "do", parentId: "panel:p" }),
      "panel:p": rec({ id: "panel:p", kind: "panel", contextId: "ctx_panel" }),
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const doDispatch = {
      async dispatchHeld(
        this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
        ref: unknown,
        method: string,
        ...args: unknown[]
      ) {
        return this.dispatch(ref, method, ...args);
      },
      async dispatch(_ref: unknown, method: string, ...args: unknown[]) {
        calls.push({ method, args });
        if (method === "entityActivate") return undefined;
        if (method === "entityResolve") return records[String(args[0])] ?? null;
        // Durable nav→slot: the panel entity "panel:p" is the current entity of open slot "panel:tree/p".
        if (method === "slotResolveByEntity")
          return String(args[0]) === "panel:p" ? "panel:tree/p" : null;
        if (method === "run") return { success: true, console: "", scopeKeys: [] };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = {
      resolveContext: (id: string) => records[id]?.contextId ?? null,
      resolve: (id: string) => records[id] ?? null,
      resolveActive: () => null,
      _onActivate() {},
      _onRetire() {},
    } as unknown as EntityCache;
    const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws", entityCache });
    const service = createEvalService({
      doDispatch,
      entityStore,
      tokenManager: {
        ensureToken: (id: string) => `tok:${id}`,
      } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    });

    await service.handler({ caller: createVerifiedCaller("do:src:Agent:k", "do") }, "run", [
      { channelId: "c", code: "return 1;" },
    ]);

    const runCall = calls.find((c) => c.method === "run");
    // The parent is the owning panel's TREE SLOT id (durable nav→slot of "panel:p" → "panel:tree/p"),
    // not the panel's entity id — so defaultOpenParentId/getPanelHandle nest under the real slot.
    expect((runCall?.args[0] as { parent?: unknown }).parent).toEqual({
      parentId: "panel:tree/p",
      parentEntityId: "panel:tree/p",
      parentKind: "panel",
    });
  });

  it("rejects owner overrides from unprivileged callers", async () => {
    const { service } = createHarness({
      "panel:one": "ctx_panel",
      "session:default": "ctx_1",
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("panel:one", "panel") }, "run", [
        {
          ownerId: "session:default",
          contextId: "ctx_1",
          subKey: "default",
          code: "return 1;",
        },
      ])
    ).rejects.toThrow(/restricted to shell\/server/);
  });

  it("rejects missing or ambiguous run sources even when handler is called directly", async () => {
    const { service } = createHarness({ "session:default": "ctx_1" });
    const ctx = { caller: createVerifiedCaller("shell:dev_cli", "shell") };

    await expect(
      service.handler(ctx, "run", [
        { ownerId: "session:default", contextId: "ctx_1", subKey: "default" },
      ])
    ).rejects.toThrow(/exactly one of code or path/);

    await expect(
      service.handler(ctx, "run", [
        {
          ownerId: "session:default",
          contextId: "ctx_1",
          subKey: "default",
          code: "return 1;",
          path: "/snippet.ts",
        },
      ])
    ).rejects.toThrow(/exactly one of code or path/);
  });

  it("startRun: inserts with the caller's runId, returns it, and pushes completion to the agent", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "startRun", [
      { subKey: "chan_1", channelId: "chan_1", code: "return 1;", runId: "inv-42" },
    ]);
    expect(ret).toEqual({ runId: "inv-42" });

    const objectKey = evalKey(ownerId, "chan_1");
    // startRun dispatched to the owner's EvalDO with the CALLER's runId + assembled args.
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: [expect.objectContaining({ runId: "inv-42", channelId: "chan_1", agentRef: ownerId })],
    });

    // The held run + completion push run on a background task — let them settle.
    await new Promise((r) => setTimeout(r, 10));
    // executeRun was dispatched HELD (the mock records dispatchHeld as a dispatch).
    expect(calls.find((c) => c.method === "executeRun")).toMatchObject({ args: ["inv-42"] });
    // Completion pushed to the owning agent DO, content-routed by channelId.
    expect(calls.find((c) => c.method === "onEvalComplete")).toMatchObject({
      ref: { source: "agents/worker", className: "Agent", objectKey: "abc" },
      args: [expect.objectContaining({ runId: "inv-42", channelId: "chan_1" })],
    });
  });

  it("startRun without a caller runId mints a server uuid (and uses it for the run)", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = (await service.handler(
      { caller: createVerifiedCaller(ownerId, "do") },
      "startRun",
      [{ subKey: "chan_1", channelId: "chan_1", code: "return 1;" }]
    )) as { runId: string };
    expect(ret.runId).toBeTruthy();
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      args: [expect.objectContaining({ runId: ret.runId })],
    });
  });

  it("getRun: routes to the owner's EvalDO by (owner, subKey)", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "getRun", [
      { subKey: "chan_1", runId: "inv-42" },
    ]);

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "getRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });

  it("cancel: routes to the owner's EvalDO by (owner, subKey) and forwards the runId", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "cancel", [
      { subKey: "chan_1", runId: "inv-42" },
    ]);
    expect(ret).toEqual({ ok: true });

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "cancel")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });

  it("forceReset: routes to the owner's EvalDO by (owner, subKey)", async () => {
    const ownerId = "do:agents/worker:Agent:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = await service.handler(
      { caller: createVerifiedCaller(ownerId, "do") },
      "forceReset",
      [{ subKey: "chan_1" }]
    );
    expect(ret).toEqual({ ok: true });

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "forceReset")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
    });
  });
});

/**
 * F2: when the held `executeRun` dispatch dies (server restart dropped the connection), the service
 * reconciles the run's terminal state via `getRun` and pushes `onEvalComplete` itself, so the agent's
 * parked invocation settles even if its own poll backstop never re-fires.
 */
function createHeldFailHarness(opts: {
  contextId: string;
  getRunResponse: { status: string; result?: unknown };
}) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  const doDispatch = {
    async dispatchHeld(_ref: unknown, method: string, ..._args: unknown[]) {
      if (method === "executeRun") {
        throw new Error("held connection dropped (server restart)");
      }
      // run (the synchronous held path) is not exercised here.
      throw new Error(`unexpected dispatchHeld ${method}`);
    },
    async dispatch(ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") return opts.contextId;
      if (method === "entityActivate") return undefined;
      if (method === "entityResolve") return null;
      if (method === "slotResolveByEntity") return null;
      if (method === "startRun")
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      if (method === "getRun") return opts.getRunResponse;
      if (method === "onEvalComplete") return undefined;
      throw new Error(`unexpected dispatch ${method}`);
    },
  } as unknown as DODispatch;
  const ownerId = "do:agents/worker:Agent:abc";
  const entityCache = {
    resolveContext: () => opts.contextId,
    resolveActive: () => null,
    resolve: () => null,
    _onActivate() {},
    _onRetire() {},
  } as unknown as EntityCache;
  const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws_1", entityCache });
  const service = createEvalService({
    doDispatch,
    entityStore,
    tokenManager: {
      ensureToken: (id: string) => `tok:${id}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
  });
  return { service, calls, ownerId };
}

describe("createEvalService — F2 held-run failure reconciliation", () => {
  it("pushes onEvalComplete with the reconciled getRun result when the held run died but completed (done)", async () => {
    const result = { success: true, console: "ok", returnValue: 7 };
    const { service, calls, ownerId } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "done", result },
    });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "startRun", [
      { subKey: "chan_1", channelId: "chan_1", code: "return 7;", runId: "inv-h1" },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    // After the held dispatch threw, the service reconciled via getRun and pushed the REAL result.
    expect(calls.find((c) => c.method === "getRun")).toMatchObject({ args: ["inv-h1"] });
    expect(calls.find((c) => c.method === "onEvalComplete")).toMatchObject({
      ref: { source: "agents/worker", className: "Agent", objectKey: "abc" },
      args: [expect.objectContaining({ runId: "inv-h1", channelId: "chan_1", result })],
    });
  });

  it("pushes a synthetic terminal failure when the held run is gone (cancelled/unknown)", async () => {
    const { service, calls, ownerId } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "cancelled" },
    });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "startRun", [
      { subKey: "chan_1", channelId: "chan_1", code: "return 1;", runId: "inv-h2" },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    const push = calls.find((c) => c.method === "onEvalComplete");
    expect(push).toBeTruthy();
    expect((push!.args[0] as { result: { success: boolean } }).result.success).toBe(false);
    expect((push!.args[0] as { runId: string }).runId).toBe("inv-h2");
  });

  it("does NOT push a terminal when the run is still in flight (running) — never bounds a long eval", async () => {
    const { service, calls, ownerId } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
    });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "startRun", [
      { subKey: "chan_1", channelId: "chan_1", code: "while(true){}", runId: "inv-h3" },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    // The run is genuinely still running elsewhere → leave it alone (its own completion push covers
    // it); forcing a terminal here would cut a legitimately long-running eval short.
    expect(calls.some((c) => c.method === "onEvalComplete")).toBe(false);
  });
});
