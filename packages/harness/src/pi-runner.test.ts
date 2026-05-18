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
      if (method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
        };
      }
      if (method === "query") return { rows: [] };
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

  it("isolates permanent provenance failures so one bad event does not poison retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appendBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cannot resolve unknown dispatch: missing"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Cannot resolve unknown dispatch: missing"));
    const runner = new PiRunner(createOptions()) as unknown as {
      storage: { appendBatch: typeof appendBatch };
      provenanceQueue: Array<Record<string, unknown>>;
      flushProvenance(): Promise<void>;
    };
    const valid = { eventId: "valid", kind: "system_event", payload: {} };
    const invalid = {
      eventId: "invalid",
      kind: "dispatch_resolved",
      payload: { dispatchCallId: "missing" },
    };
    runner.storage = { appendBatch };
    runner.provenanceQueue = [valid, invalid];

    try {
      await runner.flushProvenance();

      expect(appendBatch).toHaveBeenCalledTimes(3);
      expect(appendBatch).toHaveBeenNthCalledWith(2, [valid]);
      expect(appendBatch).toHaveBeenNthCalledWith(3, [invalid]);
      expect(runner.provenanceQueue).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "[PiRunner] dropping invalid provenance event:",
        expect.objectContaining({ eventId: "invalid", kind: "dispatch_resolved" }),
      );
      expect(warn).not.toHaveBeenCalledWith(
        "[PiRunner] provenance flush failed:",
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("records completed tool results as resolved dispatch provenance", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];

    runner.queueMessageProvenance(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "eval",
        content: [{ type: "text", text: "done" }],
      },
      "entry-result",
    );

    expect(runner.provenanceQueue).toMatchObject([
      {
        kind: "dispatch_resolved",
        anchorId: "call_1",
        payload: { dispatchCallId: "call_1", resultEntryId: "entry-result" },
      },
    ]);
  });
});
