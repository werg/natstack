import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpectroliteApp } from "./createApp";

const runtimeMocks = vi.hoisted(() => {
  const stateArgs = { current: {} as Record<string, unknown> };
  return {
    stateArgs,
    getStateArgs: vi.fn(() => stateArgs.current),
    setStateArgs: vi.fn(async (updates: Record<string, unknown>) => {
      stateArgs.current = { ...stateArgs.current, ...updates };
    }),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    edit: vi.fn(),
    pushStatus: vi.fn(),
    pendingMerge: vi.fn(),
    contextStatus: vi.fn(),
    subscribeHead: vi.fn(),
    subscribeWorking: vi.fn(),
  };
});

const sessionMocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  dispose: vi.fn(),
  onVaultSelected: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "vault-fresh",
  rpc: {},
  panel: {
    slotId: "panel:spectrolite",
    stateArgs: {
      get: runtimeMocks.getStateArgs,
      set: runtimeMocks.setStateArgs,
    },
  },
  vcs: {
    listFiles: runtimeMocks.listFiles,
    readFile: runtimeMocks.readFile,
    edit: runtimeMocks.edit,
    pushStatus: runtimeMocks.pushStatus,
    pendingMerge: runtimeMocks.pendingMerge,
    contextStatus: runtimeMocks.contextStatus,
    subscribeHead: runtimeMocks.subscribeHead,
    subscribeWorking: runtimeMocks.subscribeWorking,
  },
}));

vi.mock("./sessionController", () => ({
  SessionController: vi.fn(() => sessionMocks),
}));

describe("createSpectroliteApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.stateArgs.current = {
      contextId: "vault-fresh",
      repoRoot: "projects/fresh",
      pendingStarterDoc: { path: "Welcome.mdx", content: "# Welcome\n" },
    };
    runtimeMocks.listFiles.mockResolvedValue([]);
    runtimeMocks.readFile.mockResolvedValue(null);
    runtimeMocks.edit.mockResolvedValue({
      head: "ctx:vault-fresh",
      stateHash: "state:1",
      committed: false,
      status: "uncommitted",
      editSeq: 1,
      changedPaths: ["projects/fresh/Welcome.mdx"],
    });
    runtimeMocks.pushStatus.mockResolvedValue([
      {
        repoPath: "projects/fresh",
        ahead: 0,
        uncommitted: 1,
        diverged: false,
        deleted: false,
        files: [],
      },
    ]);
    runtimeMocks.pendingMerge.mockResolvedValue(null);
    runtimeMocks.contextStatus.mockResolvedValue([]);
    runtimeMocks.subscribeHead.mockReturnValue(() => undefined);
    runtimeMocks.subscribeWorking.mockReturnValue(() => undefined);
  });

  it("creates a pending starter doc after the panel is bound to the vault context", async () => {
    const app = createSpectroliteApp();

    app.start();

    await vi.waitFor(() => {
      expect(runtimeMocks.edit).toHaveBeenCalledWith({
        edits: [
          {
            kind: "create",
            path: "projects/fresh/Welcome.mdx",
            content: { kind: "text", text: "# Welcome\n" },
          },
        ],
      });
    });
    expect(app.store.getState().activePath).toBe("Welcome.mdx");
    expect(runtimeMocks.setStateArgs).toHaveBeenCalledWith({
      openPath: "Welcome.mdx",
      pendingStarterDoc: null,
    });
  });

  it("refreshes publish state when durable working edits advance", async () => {
    const workingAdvances: Array<() => void> = [];
    runtimeMocks.subscribeWorking.mockImplementation((_head: string, cb: () => void) => {
      workingAdvances.push(cb);
      return () => undefined;
    });
    const app = createSpectroliteApp();

    app.start();
    await vi.waitFor(() => {
      expect(runtimeMocks.pushStatus).toHaveBeenCalledTimes(1);
    });

    runtimeMocks.pushStatus.mockClear();
    const onWorkingAdvance = workingAdvances[0];
    if (!onWorkingAdvance) throw new Error("subscribeWorking did not capture a callback");
    onWorkingAdvance();

    await vi.waitFor(() => {
      expect(runtimeMocks.pushStatus).toHaveBeenCalledWith(["projects/fresh"]);
    });
  });
});
