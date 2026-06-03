import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartVitest = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    state: { getFiles: () => [] },
    close: vi.fn(),
  })
);

vi.mock("vitest/node", () => ({
  startVitest: mockStartVitest,
}));

import { activate } from "./index.js";

interface CallerInfo {
  callerId?: string;
  callerKind?: string;
  contextId?: string;
  chainContextId?: string;
}

type ApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: "no-user-context" };

function makeWorkspace() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-runner-source-"));
  const contexts = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-runner-contexts-"));
  return { source, contexts };
}

function makeCtx(workspace = makeWorkspace(), caller: CallerInfo = {}) {
  const approval = vi.fn(
    async (_req: { subject: { id: string } }): Promise<ApprovalChoice> => ({
      kind: "choice",
      choice: "once",
    })
  );
  const revoke = vi.fn(async () => true);
  const ctx = {
    workspace: {
      async getInfo() {
        return { path: workspace.source, contextsPath: workspace.contexts };
      },
    },
    invocation: {
      current: () => ({
        caller: {
          callerId: caller.callerId ?? "panel:tree/panels~my-app/abc",
          callerKind: caller.callerKind ?? "panel",
          ...(caller.contextId ? { contextId: caller.contextId } : {}),
        },
        ...(caller.chainContextId ? { chainCaller: { contextId: caller.chainContextId } } : {}),
      }),
    },
    approvals: { request: approval, revoke },
    log: { info: vi.fn() },
  };
  return { ctx, approval, revoke };
}

describe("@workspace-extensions/test-runner", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    mockStartVitest.mockReset();
    mockStartVitest.mockResolvedValue({
      state: { getFiles: () => [] },
      close: vi.fn(),
    });
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs tests from the caller context by default", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    const target = path.join(workspace.contexts, "ctx-1", "packages", "tool");
    fs.mkdirSync(target, { recursive: true });
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    const result = await api.run("packages/tool");

    expect(result.summary).toContain("No test files found");
    expect(result.contextId).toBe("ctx-1");
    expect(approval).toHaveBeenCalledTimes(1);
    expect(mockStartVitest).toHaveBeenCalledWith(
      "run",
      [path.join(target, "**/*.test.{ts,tsx}")],
      expect.objectContaining({ root: workspace.source })
    );
  });

  it("rejects path traversal before requesting approval", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await expect(api.run("../secret")).rejects.toThrow("Target must not contain parent traversal");
    expect(approval).not.toHaveBeenCalled();
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("requires a context id", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.source, "packages", "tool"), { recursive: true });
    const { ctx } = makeCtx(workspace);
    ctx.invocation.current = () => ({
      caller: { callerId: "server:test", callerKind: "server" },
    });
    const api = await activate(ctx);

    await expect(api.run("packages/tool")).rejects.toThrow("requires a contextId");
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("injects panel setup for panel targets", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.contexts, "ctx-1", "panels", "my-app"), {
      recursive: true,
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await api.run("panels/my-app");

    expect(mockStartVitest).toHaveBeenCalledWith(
      "run",
      expect.any(Array),
      expect.objectContaining({
        setupFiles: [expect.stringContaining("panel-test-setup.mjs")],
      })
    );
  });

  it("stops when approval is denied", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.contexts, "ctx-1", "packages", "tool"), {
      recursive: true,
    });
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    approval.mockResolvedValue({ kind: "choice", choice: "deny" });
    const api = await activate(ctx);

    await expect(api.run("packages/tool")).rejects.toThrow("denied");
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("stops when approval is dismissed", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.contexts, "ctx-1", "packages", "tool"), {
      recursive: true,
    });
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    approval.mockResolvedValue({ kind: "dismissed" });
    const api = await activate(ctx);

    await expect(api.run("packages/tool")).rejects.toThrow("denied");
    expect(mockStartVitest).not.toHaveBeenCalled();
  });

  it("routes through approval even if an untyped caller passes approve false", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.contexts, "ctx-1", "packages", "tool"), {
      recursive: true,
    });
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await api.run({
      target: "packages/tool",
      approve: false,
    } as unknown as Parameters<typeof api.run>[0]);

    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval.mock.calls[0]?.[0]).not.toHaveProperty("options");
    expect(mockStartVitest).toHaveBeenCalledTimes(1);
  });

  it("uses a stable scoped approval subject so the approval service can honor remember choices", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    fs.mkdirSync(path.join(workspace.contexts, "ctx-1", "packages", "tool"), {
      recursive: true,
    });
    const { ctx, approval } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    await api.run("packages/tool");
    await api.run("packages/tool");

    expect(approval).toHaveBeenCalledTimes(2);
    expect(approval.mock.calls[0]?.[0].subject.id).toBe(
      approval.mock.calls[1]?.[0].subject.id
    );
    expect(approval.mock.calls[0]?.[0]).not.toHaveProperty("promptOptions");
  });

  it("formats passing and failing test results", async () => {
    const workspace = makeWorkspace();
    cleanup.push(workspace.source, workspace.contexts);
    const target = path.join(workspace.contexts, "ctx-1", "packages", "tool");
    fs.mkdirSync(target, { recursive: true });
    mockStartVitest.mockResolvedValue({
      state: {
        getFiles: () => [
          {
            filepath: path.join(target, "index.test.ts"),
            result: { state: "fail", duration: 10 },
            tasks: [
              { name: "passes", result: { state: "pass" } },
              { name: "fails", result: { state: "fail", errors: [{ message: "nope" }] } },
            ],
          },
        ],
      },
      close: vi.fn(),
    });
    const { ctx } = makeCtx(workspace, { chainContextId: "ctx-1" });
    const api = await activate(ctx);

    const result = await api.run("packages/tool");

    expect(result.summary).toBe("1 of 2 tests failed");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details[0]).toMatchObject({
      file: "packages/tool/index.test.ts",
      status: "fail",
      errors: ["fails: nope"],
    });
  });
});
