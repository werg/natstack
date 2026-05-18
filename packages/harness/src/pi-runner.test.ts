import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    getModel: vi.fn(() => ({
      id: "gpt-5",
      provider: "openai-codex",
      modelId: "gpt-5",
      api: "openai",
      contextWindow: 100000,
    })),
  };
});

import { PiRunner } from "./pi-runner.js";
import type { PiRunnerOptions } from "./pi-runner.js";
import type { RuntimeFs } from "./tools/runtime-fs.js";

function createFs(): RuntimeFs {
  return {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    mktemp: vi.fn(async () => "/tmp/natstack"),
    readFile: vi.fn(async () => "contents"),
    writeFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: 8,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      mode: 0o644,
    })),
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  } as RuntimeFs;
}

function createOptions(overrides: Partial<PiRunnerOptions> = {}): PiRunnerOptions {
  const rpc = {
    call: vi.fn(async (_target: string, method: string) => {
      if (method === "workspace.getAgentsMd") return "workspace prompt";
      if (method === "workspace.listSkills") return [];
      if (method === "gad.findBranchEntriesByType") return [];
      throw new Error(`unexpected rpc method ${method}`);
    }),
  };
  return {
    rpc: rpc as unknown as PiRunnerOptions["rpc"],
    fs: createFs(),
    uiCallbacks: {
      selectForTool: vi.fn(),
      confirmForTool: vi.fn(async () => true),
      inputForTool: vi.fn(),
      editorForTool: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    rosterCallback: () => [],
    callMethodCallback: vi.fn(),
    askUserCallback: vi.fn(async () => ""),
    model: "openai-codex:gpt-5",
    getApiKey: vi.fn(async () => "token"),
    approvalLevel: 2,
    ...overrides,
  };
}

describe("PiRunner", () => {
  it("initializes a harness-backed session", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();

    const snapshot = await runner.getStateSnapshot();
    expect(snapshot).toEqual({ messages: [], isStreaming: false });
    expect(runner.session).toBeTruthy();

    runner.dispose();
  });

  it("appends user messages through the session", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();

    await runner.appendUserMessage({ role: "user", content: "hello", timestamp: 1 } as any);
    const snapshot = await runner.getStateSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect((snapshot.messages[0] as any).content).toBe("hello");

    runner.dispose();
  });
});
