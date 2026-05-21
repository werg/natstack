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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    const appendTrajectoryBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("GAD event id collision with different content"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("GAD event id collision with different content"));
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      provenanceQueue: Array<Record<string, unknown>>;
      flushProvenance(): Promise<void>;
    };
    const valid = {
      eventId: "valid",
      event: {
        kind: "system.event",
        actor: { kind: "system", id: "test" },
        payload: { protocol: "agentic.trajectory.v1", kind: "valid" },
        createdAt: new Date(0).toISOString(),
      },
    };
    const invalid = {
      eventId: "invalid",
      event: {
        kind: "system.event",
        actor: { kind: "system", id: "test" },
        payload: { protocol: "agentic.trajectory.v1", kind: "invalid" },
        createdAt: new Date(0).toISOString(),
      },
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.provenanceQueue = [valid, invalid];

    try {
      await runner.flushProvenance();

      expect(appendTrajectoryBatch).toHaveBeenCalledTimes(3);
      expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
        2,
        "appendTrajectoryBatch",
        expect.objectContaining({ events: [expect.objectContaining({ eventId: "valid" })] }),
      );
      expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
        3,
        "appendTrajectoryBatch",
        expect.objectContaining({ events: [expect.objectContaining({ eventId: "invalid" })] }),
      );
      expect(runner.provenanceQueue).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "[PiRunner] dropping invalid provenance event:",
        expect.objectContaining({ eventId: "invalid", kind: "system.event" }),
      );
      expect(warn).not.toHaveBeenCalledWith(
        "[PiRunner] provenance flush failed:",
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("records completed tool results as trajectory invocation provenance", () => {
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
        eventId: "entry-result",
        publishToChannel: false,
        event: {
          kind: "message.completed",
          causality: { messageId: "entry-result" },
          payload: { role: "tool", content: "done" },
        },
      },
      {
        publishToChannel: true,
        event: {
          kind: "invocation.completed",
          causality: { invocationId: "call_1", messageId: "entry-result" },
          payload: {
            result: expect.objectContaining({ toolCallId: "call_1", toolName: "eval" }),
          },
        },
      },
    ]);
  });

  it("keeps session-appended user messages provenance-only", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];

    runner.queueMessageProvenance(
      { role: "user", content: [{ type: "text", text: "Read the onboarding docs" }] },
      "entry-user",
    );

    expect(runner.provenanceQueue).toContainEqual(expect.objectContaining({
      publishToChannel: false,
      event: expect.objectContaining({
        kind: "message.completed",
        actor: { kind: "user", id: "user" },
        payload: expect.objectContaining({
          role: "user",
          content: "Read the onboarding docs",
        }),
      }),
    }));
  });

  it("records tool-call names and parsed arguments from provider-shaped blocks", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];

    runner.queueMessageProvenance(
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            tool_call_id: "call_2",
            function: { name: "eval", arguments: "{\"code\":\"1 + 1\"}" },
          },
        ],
      },
      "entry-assistant",
    );

    expect(runner.provenanceQueue).toContainEqual(expect.objectContaining({
      publishToChannel: false,
      event: expect.objectContaining({
        kind: "message.completed",
        payload: expect.objectContaining({
          role: "assistant",
          content: "",
        }),
      }),
    }));
    expect(
      runner.provenanceQueue.some((item) =>
        JSON.stringify(item).includes("[tool call:")
      ),
    ).toBe(false);
    expect(runner.provenanceQueue).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        kind: "invocation.started",
        causality: expect.objectContaining({ invocationId: "call_2" }),
        payload: expect.objectContaining({
          name: "eval",
          request: { code: "1 + 1" },
        }),
      }),
    }));
  });

  it("records approval prompts and decisions as trajectory events", async () => {
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    const runner = new PiRunner(createOptions({ approvalLevel: 0 })) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      extensionRuntime: { dispatch: typeof dispatch };
      dispatchToolCallEvent(
        toolCallId: string,
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<{ block?: boolean; reason?: string } | undefined>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.extensionRuntime = { dispatch };

    await runner.dispatchToolCallEvent("call_approval", "write", { path: "a.txt" });

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(2);
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      1,
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            publish: { channelIds: ["channel:test"] },
            event: expect.objectContaining({
              kind: "approval.requested",
              causality: expect.objectContaining({
                approvalId: "approval:call_approval",
                invocationId: "call_approval",
              }),
              payload: expect.objectContaining({
                question: "Allow tool call?",
                details: { toolName: "write", input: { path: "a.txt" } },
              }),
            }),
          }),
        ],
      }),
    );
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      2,
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            publish: { channelIds: ["channel:test"] },
            event: expect.objectContaining({
              kind: "approval.resolved",
              causality: expect.objectContaining({
                approvalId: "approval:call_approval",
                invocationId: "call_approval",
              }),
              payload: expect.objectContaining({ granted: true }),
            }),
          }),
        ],
      }),
    );
  });

  it("publishes an approval request before tool execution can continue", async () => {
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const gate = deferred<{ block?: boolean; reason?: string } | undefined>();
    const dispatch = vi.fn(() => gate.promise);
    const runner = new PiRunner(createOptions({ approvalLevel: 0 })) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      extensionRuntime: { dispatch: typeof dispatch };
      dispatchToolCallEvent(
        toolCallId: string,
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<{ block?: boolean; reason?: string } | undefined>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.extensionRuntime = { dispatch };

    const pending = runner.dispatchToolCallEvent("call_blocking", "write", { path: "a.txt" });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => {
      expect(appendTrajectoryBatch).toHaveBeenCalledTimes(1);
    });
    await appendTrajectoryBatch.mock.results[0]?.value;
    await Promise.resolve();

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(1);
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      1,
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            publish: { channelIds: ["channel:test"] },
            event: expect.objectContaining({ kind: "approval.requested" }),
          }),
        ],
      }),
    );
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    gate.resolve(undefined);
    await pending;

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(2);
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      2,
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            publish: { channelIds: ["channel:test"] },
            event: expect.objectContaining({
              kind: "approval.resolved",
              payload: expect.objectContaining({ granted: true }),
            }),
          }),
        ],
      }),
    );
  });

  it("stamps agent-authored turn-scoped events before appending to gad", async () => {
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      currentTurnId: string | null;
      appendTrajectoryEvents(items: Array<Record<string, unknown>>): Promise<void>;
    };
    runner.options.gad = { trajectoryId: "trajectory:test", branchId: "branch:test" };
    runner.gad = { call: appendTrajectoryBatch };
    runner.currentTurnId = "turn-active";

    await runner.appendTrajectoryEvents([
      {
        event: {
          kind: "message.completed",
          actor: { kind: "agent", id: "pi" },
          payload: { protocol: "agentic.trajectory.v1", role: "assistant", content: "hello" },
          createdAt: new Date(0).toISOString(),
        },
      },
    ]);

    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({ turnId: "turn-active" }),
          }),
        ],
      }),
    );
  });

  it("asks pubsub channels to broadcast envelopes published by gad", async () => {
    const appendTrajectoryBatch = vi.fn(async () => ({
      published: [
        { channelId: "channel:test", envelopeId: "env-1" },
        { channelId: "channel:test", envelopeId: "env-2" },
      ],
    }));
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/pubsub-channel:PubSubChannel:channel:test",
        };
      }
      if (target === "do:workers/pubsub-channel:PubSubChannel:channel:test" && method === "broadcastStoredEnvelopes") {
        return { broadcasted: 2 };
      }
      throw new Error(`unexpected rpc call ${target}.${method}`);
    });
    const runner = new PiRunner(createOptions({ rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"] })) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      appendTrajectoryEvents(items: Array<Record<string, unknown>>): Promise<void>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };

    await runner.appendTrajectoryEvents([
      {
        publishToChannel: true,
        event: {
          kind: "message.completed",
          actor: { kind: "agent", id: "pi" },
          causality: { messageId: "message-1" },
          payload: { protocol: "agentic.trajectory.v1", role: "assistant", content: "hello" },
          createdAt: new Date(0).toISOString(),
        },
      },
    ]);

    expect(rpcCall).toHaveBeenCalledWith(
      "do:workers/pubsub-channel:PubSubChannel:channel:test",
      "broadcastStoredEnvelopes",
      [["env-1", "env-2"]],
    );
  });
});
