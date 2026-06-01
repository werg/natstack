import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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
import type { HibernationResumableTool, PiRunnerOptions } from "./pi-runner.js";
import type { RuntimeFs } from "./tools/runtime-fs.js";
import { TrajectoryBackedSessionStorage } from "@workspace/pi-adapter";
import {
  runAgentLoop,
  type AgentLoopConfig,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";

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

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

async function flushUntil(predicate: () => boolean, iterations = 50): Promise<void> {
  for (let i = 0; i < iterations && !predicate(); i += 1) {
    await Promise.resolve();
  }
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
  const blobs = new Map<string, string>();
  const rpc = {
    call: vi.fn(async (_target: string, method: string, args: unknown[] = []) => {
      if (method === "workspace.getAgentsMd") return "workspace prompt";
      if (method === "workspace.listSkills") return [];
      if (method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
        };
      }
      if (method === "query") return { rows: [] };
      if (method === "blobstore.putText") {
        const text = String(args[0] ?? "");
        const digest = createHash("sha256").update(text, "utf8").digest("hex");
        blobs.set(digest, text);
        return { digest, size: Buffer.byteLength(text, "utf8") };
      }
      if (method === "blobstore.getText") {
        return blobs.get(String(args[0])) ?? null;
      }
      if (method === "blobstore.getRange") {
        const text = blobs.get(String(args[0]));
        if (text === undefined) return null;
        const offset = Number(args[1] ?? 0);
        const limit = Number(args[2] ?? text.length);
        return text.slice(offset, offset + limit);
      }
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

describe("pi-agent-core steering integration", () => {
  it("admits queued steering before next-turn preparation starts", async () => {
    const order: string[] = [];
    const steered: AgentMessage = {
      role: "user",
      content: "change direction",
      timestamp: 2,
    } as AgentMessage;
    const steeringQueue: AgentMessage[] = [];
    let modelCallCount = 0;
    const tools: NonNullable<Parameters<typeof runAgentLoop>[1]["tools"]> = [
      {
        name: "probe",
        label: "Probe",
        description: "probe",
        parameters: { type: "object", additionalProperties: false },
        execute: vi.fn(async () => {
          order.push("tool-finished");
          steeringQueue.push(steered);
          return { content: [{ type: "text" as const, text: "ok" }], details: {} };
        }),
      },
    ];

    const config: AgentLoopConfig = {
      model: {
        id: "gpt-5",
        provider: "openai-codex",
        modelId: "gpt-5",
        api: "openai",
      } as unknown as AgentLoopConfig["model"],
      convertToLlm: (messages) => messages as never,
      getSteeringMessages: async () => steeringQueue.splice(0),
      prepareNextTurn: async () => {
        order.push("prepare-next-turn");
        return undefined;
      },
    } as AgentLoopConfig;

    const streamFn = vi.fn(async () => {
      const message =
        modelCallCount++ === 0
          ? {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "probe",
                  arguments: {},
                },
              ],
              timestamp: 3,
            }
          : {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
              timestamp: 4,
            };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done" };
        },
        result: async () => message,
      };
    });

    await runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 } as AgentMessage],
      { systemPrompt: "test", messages: [], tools },
      config,
      async (event) => {
        if (event.type === "turn_end") order.push("turn-end");
        if (
          event.type === "message_start" &&
          (event.message as { role?: string }).role === "user" &&
          event.message === steered
        ) {
          order.push("steering-admitted");
        }
      },
      undefined,
      streamFn as never
    );

    expect(order).toEqual([
      "tool-finished",
      "turn-end",
      "steering-admitted",
      "prepare-next-turn",
      "turn-end",
    ]);
  });
});

describe("PiRunner", () => {
  it("initializes a harness-backed session", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();

    const snapshot = await runner.getStateSnapshot();
    expect(snapshot).toEqual({ messages: [], isStreaming: false });
    expect(runner.session).toBeTruthy();

    runner.dispose();
  });

  it("aborts before_agent_start resource loading when the runner is interrupted", async () => {
    const stuckResources = deferred<string>();
    let agentsMdCalls = 0;
    const rpcCall = vi.fn(
      async (
        _target: string,
        method: string,
        _args: unknown[],
        opts?: { signal?: AbortSignal }
      ) => {
        if (method === "workspace.getAgentsMd") {
          agentsMdCalls++;
          if (agentsMdCalls === 1) return "workspace prompt";
          return stuckResources.promise;
        }
        if (method === "workspace.listSkills") return [];
        if (method === "workers.resolveService") {
          return {
            kind: "durable-object",
            targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
          };
        }
        if (method === "query") return { rows: [] };
        throw new Error(`unexpected rpc method ${method}`);
      }
    );
    const runner = new PiRunner(
      createOptions({
        rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"],
      })
    );
    await runner.init();

    const prompt = runner.prompt({ content: "hello" });
    await flushUntil(() => agentsMdCalls > 1);
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "workspace.getAgentsMd",
      [],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await expect(Promise.allSettled([runner.abort(), prompt])).resolves.toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "rejected" }),
    ]);

    runner.dispose();
  });

  it("rejects prompt when async lifecycle handling fails", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    runner.hooks.on("event", (event) => {
      if (event.type === "agent_start") throw new Error("listener failed");
    });

    await expect(runner.prompt({ content: "hello" })).rejects.toThrow("listener failed");
    expect(runner.isStreaming).toBe(false);

    runner.dispose();
  });

  it("rejects prompt when the runner completes without agent_end", async () => {
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      harness: { prompt(content: string): Promise<void> };
      handleHarnessEvent(event: unknown): Promise<void>;
    };
    await runner.init();
    internals.harness.prompt = async () => {
      await internals.handleHarnessEvent({ type: "agent_start" });
    };

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-no-end" })).rejects.toThrow(
      "Runner prompt completed without agent_end"
    );
    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();

    runner.dispose();
  });

  it("rejects prompt when the runner completes without agent_start", async () => {
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      harness: { prompt(content: string): Promise<void> };
    };
    await runner.init();
    internals.harness.prompt = async () => undefined;

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-no-start" })).rejects.toThrow(
      "Runner prompt completed without agent_start"
    );
    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();

    runner.dispose();
  });

  it("clears adopted turn ids when prompt setup fails before turn.opened", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    (runner as unknown as { refreshRuntimeTools(): Promise<void> }).refreshRuntimeTools = vi.fn(
      async () => {
        throw new Error("tool refresh failed");
      }
    );

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-adopted" })).rejects.toThrow(
      "tool refresh failed"
    );

    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();
    runner.dispose();
  });

  it("clears adopted turn ids when continue setup fails before turn.opened", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    (runner as unknown as { prepareSessionForContinue(): Promise<void> }).prepareSessionForContinue =
      vi.fn(async () => {
        throw new Error("continue preflight failed");
      });

    await expect(runner.continueAgent({ turnId: "turn-adopted" })).rejects.toThrow(
      "continue preflight failed"
    );

    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();
    runner.dispose();
  });

  it("durably closes adopted turn ids when an opened prompt fails", async () => {
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      hooks: { on(event: "event", listener: (event: { type?: string }) => void): unknown };
    };
    await runner.init();
    internals.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    internals.gad = { call: appendTrajectoryBatch };
    internals.hooks.on("event", (event) => {
      if (event.type === "agent_start") throw new Error("opened turn failed");
    });

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-opened" })).rejects.toThrow(
      "opened turn failed"
    );

    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();
    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({ kind: "turn.opened", turnId: "turn-opened" }),
          }),
        ],
      })
    );
    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "turn.closed",
              turnId: "turn-opened",
              payload: expect.objectContaining({
                reason: "work_failed",
                summary: "Agent turn failed before completion",
              }),
            }),
          }),
        ],
      })
    );
    runner.dispose();
  });

  it("does not close a turn when turn.opened fails to persist", async () => {
    const appendTrajectoryBatch = vi.fn(
      async (
        _method: string,
        input: { events: Array<{ event: { kind: string; turnId?: string } }> }
      ) => {
        if (input.events.some((item) => item.event.kind === "turn.opened")) {
          throw new Error("turn open append failed");
        }
        return { events: [], published: [] };
      }
    );
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
    };
    await runner.init();
    internals.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    internals.gad = { call: appendTrajectoryBatch };

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-open-failed" })).rejects.toThrow(
      "turn open append failed"
    );

    expect((await runner.getDebugState())["currentTurnId"]).toBeNull();
    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "turn.opened",
              turnId: "turn-open-failed",
            }),
          }),
        ],
      })
    );
    expect(appendTrajectoryBatch).not.toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "turn.closed",
              turnId: "turn-open-failed",
            }),
          }),
        ],
      })
    );
    runner.dispose();
  });

  it("keeps a recoverable agent_end turn open when requested by the host", async () => {
    const appendTrajectoryBatch = vi.fn(
      async (_method: string, _input: { events?: Array<{ event: { kind: string } }> }) => ({
        events: [],
        published: [],
      })
    );
    const runner = new PiRunner(
      createOptions({
        keepTurnOpenOnAgentEnd: (event) => {
          const messages = (event as { messages?: Array<{ stopReason?: string }> }).messages ?? [];
          return messages[messages.length - 1]?.stopReason === "error";
        },
      })
    );
    const internals = runner as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      handleHarnessEvent(event: unknown): Promise<void>;
    };
    await runner.init();
    internals.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    internals.gad = { call: appendTrajectoryBatch };

    await internals.handleHarnessEvent({ type: "agent_start" });
    await internals.handleHarnessEvent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "reauth required" }],
    });

    expect((await runner.getDebugState())["currentTurnId"]).toEqual(expect.any(String));
    expect(
      appendTrajectoryBatch.mock.calls.flatMap((call) =>
        (call[1].events ?? []).map((item) => item.event.kind)
      )
    ).toEqual(["turn.opened"]);
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

  it("does not perform async session inspection in debug state", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const huge = "x".repeat(20_000);

    await runner.appendUserMessage({ role: "user", content: huge, timestamp: 1 } as any);
    const debug = await runner.getDebugState();
    const serialized = JSON.stringify(debug);

    expect(serialized).not.toContain(huge);
    expect(debug["session"]).toEqual({
      available: false,
      reason: "session_debug_requires_async_io",
    });

    runner.dispose();
  });

  it("includes active channel tools in debug state", async () => {
    const runner = new PiRunner(createOptions({
      rosterCallback: () => [
        {
          participantHandle: "sandbox",
          name: "eval",
          description: "Run code in the panel sandbox",
          parameters: { type: "object" },
        },
      ],
    }));
    await runner.init();

    const debug = await runner.getDebugState();
    expect(debug["activeToolNames"]).toEqual(expect.arrayContaining(["read", "eval"]));
    expect(JSON.stringify(debug["phase"])).toContain("tools.refreshed");

    runner.dispose();
  });

  it("warns when expected channel tools are absent from the roster", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new PiRunner(createOptions({
      rosterCallback: () => [],
      expectedChannelToolNames: ["eval"],
    }));
    await runner.init();

    expect(warn).toHaveBeenCalledWith(
      "[PiRunner] Channel roster is missing expected tools before model refresh",
      expect.objectContaining({
        missingExpectedChannelToolNames: ["eval"],
        rosterToolNames: [],
      })
    );
    expect(JSON.stringify((await runner.getDebugState())["phase"])).toContain('"missingExpectedChannelToolNames":["eval"]');

    warn.mockRestore();
    runner.dispose();
  });

  it("refreshes channel tools after the next-turn hook updates the roster", async () => {
    let roster: Array<{
      participantHandle: string;
      name: string;
      description: string;
      parameters: unknown;
    }> = [];
    const runner = new PiRunner(
      createOptions({
        rosterCallback: () => roster,
        onPrepareNextTurn: async () => {
          roster = [
            {
              participantHandle: "sandbox",
              name: "eval",
              description: "Run code in the panel sandbox",
              parameters: { type: "object" },
            },
          ];
        },
      })
    );
    await runner.init();

    expect((await runner.getDebugState())["activeToolNames"]).not.toContain("eval");

    await (runner as unknown as { prepareFollowingTurn(): Promise<void> }).prepareFollowingTurn();

    expect((await runner.getDebugState())["activeToolNames"]).toContain("eval");
    runner.dispose();
  });

  it("records provider payload tool names for model-call diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new PiRunner(createOptions());
    await runner.init();
    await (
      runner as unknown as {
        harness: {
          emitBeforeProviderPayload(model: unknown, payload: unknown): Promise<unknown>;
        };
      }
    ).harness.emitBeforeProviderPayload(
      { id: "gpt-5", provider: "openai-codex" },
      {
        tools: [
          { type: "function", name: "eval" },
          { type: "function", function: { name: "feedback_form" } },
          { functionDeclarations: [{ name: "inline_ui" }] },
        ],
      }
    );

    const debug = await runner.getDebugState();
    expect(JSON.stringify(debug["phase"])).toContain("provider.payload.ready");
    expect(JSON.stringify(debug["phase"])).toContain('"hasEval":true');
    expect(JSON.stringify(debug["phase"])).toContain('"toolNames":["eval","feedback_form","inline_ui"]');
    expect(warn).toHaveBeenCalledWith(
      "[PiRunner] Provider payload tool set differs from active harness tools",
      expect.objectContaining({
        payloadToolNames: ["eval", "feedback_form", "inline_ui"],
      })
    );
    warn.mockRestore();
    runner.dispose();
  });

  it("warns when provider payload omits expected channel tools", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new PiRunner(createOptions({
      rosterCallback: () => [
        {
          participantHandle: "sandbox",
          name: "eval",
          description: "Run code in the panel sandbox",
          parameters: { type: "object" },
        },
      ],
      expectedChannelToolNames: ["eval"],
    }));
    await runner.init();
    await (
      runner as unknown as {
        harness: {
          emitBeforeProviderPayload(model: unknown, payload: unknown): Promise<unknown>;
        };
      }
    ).harness.emitBeforeProviderPayload(
      { id: "gpt-5", provider: "openai-codex" },
      { tools: [{ type: "function", name: "read" }] }
    );

    expect(warn).toHaveBeenCalledWith(
      "[PiRunner] Provider payload is missing expected channel tools",
      expect.objectContaining({
        missingExpectedChannelToolNames: ["eval"],
        rosterToolNames: ["eval"],
        payloadToolNames: ["read"],
      })
    );

    warn.mockRestore();
    runner.dispose();
  });

  it("logs a loud diagnostic when the model-facing tool set changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let allowEval = true;
    const runner = new PiRunner(createOptions({
      rosterCallback: () => [
        {
          participantHandle: "sandbox",
          name: "eval",
          description: "Run code in the panel sandbox",
          parameters: { type: "object" },
        },
      ],
      toolFilter: (name) => allowEval || name !== "eval",
    }));
    await runner.init();
    await (runner as unknown as { refreshRuntimeTools(reason?: string): Promise<void> }).refreshRuntimeTools("test.initial");
    allowEval = false;
    await (runner as unknown as { refreshRuntimeTools(reason?: string): Promise<void> }).refreshRuntimeTools("test.remove_eval");

    expect(warn).toHaveBeenCalledWith(
      "[PiRunner] Model-facing tool set changed",
      expect.objectContaining({
        reason: "test.remove_eval",
        removed: ["eval"],
      })
    );
    warn.mockRestore();
    runner.dispose();
  });

  it("deduplicates tool names before advertising tools to the model", async () => {
    const setTitleTool = {
      name: "set_title",
      label: "set_title",
      description: "worker title fallback",
      parameters: { type: "object" },
      execute: vi.fn(),
    } as unknown as NonNullable<PiRunnerOptions["extraTools"]>[number];
    const runner = new PiRunner(createOptions({
      rosterCallback: () => [
        {
          participantHandle: "panel",
          name: "set_title",
          description: "panel title tool",
          parameters: { type: "object" },
        },
      ],
      extraTools: [setTitleTool],
    }));
    await runner.init();

    const names = ((await runner.getDebugState())["activeToolNames"] as string[]).filter((name) => name === "set_title");
    expect(names).toHaveLength(1);
    expect(JSON.stringify((await runner.getDebugState())["phase"])).toContain('"duplicateToolNames":["set_title"]');

    runner.dispose();
  });

  it("repairs an empty aborted assistant leaf before continuing", async () => {
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      prepareSessionForContinue(): Promise<void>;
      lastContinueDiagnostic: Record<string, unknown> | null;
    };
    await runner.init();

    const userLeaf = await runner.appendUserMessage({
      role: "user",
      content: "continue from here",
      timestamp: 1,
    } as any);
    const abortedLeaf = await runner.session!.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "aborted",
      timestamp: 2,
    } as any);

    expect(await runner.session!.getLeafId()).toBe(abortedLeaf);
    await internals.prepareSessionForContinue();

    expect(await runner.session!.getLeafId()).toBe(userLeaf);
    expect(internals.lastContinueDiagnostic).toMatchObject({
      status: "repaired",
      reason: "empty_aborted_assistant_leaf",
      fromLeafId: abortedLeaf,
      toLeafId: userLeaf,
    });

    runner.dispose();
  });

  it("rejects continue when the session ends with a completed assistant message", async () => {
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      prepareSessionForContinue(): Promise<void>;
      lastContinueDiagnostic: Record<string, unknown> | null;
    };
    await runner.init();

    await runner.appendUserMessage({ role: "user", content: "hello", timestamp: 1 } as any);
    const assistantLeaf = await runner.session!.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 2,
    } as any);

    await expect(internals.prepareSessionForContinue()).rejects.toMatchObject({
      code: "session",
      message: expect.stringContaining("Cannot continue"),
    });
    expect(await runner.session!.getLeafId()).toBe(assistantLeaf);
    expect(internals.lastContinueDiagnostic).toMatchObject({
      status: "invalid",
      reason: "unsupported_last_role",
      lastRole: "assistant",
    });

    runner.dispose();
  });

  it("keeps empty assistant error provenance private", async () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
      provenanceQueue: Array<{ event: { kind: string; payload: Record<string, unknown> }; publishToChannel?: boolean }>;
      dispose(): void;
    };

    runner.queueMessageProvenance(
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provided authentication token is expired. Please try signing in again.",
        timestamp: 1,
      },
      "entry-error"
    );

    expect(runner.provenanceQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            kind: "message.failed",
            payload: expect.objectContaining({
              reason: "Provided authentication token is expired. Please try signing in again.",
              recoverable: true,
            }),
          }),
          publishToChannel: false,
        }),
      ])
    );

    runner.dispose();
  });

  it("publishes failed assistant provenance when the assistant message has visible content", async () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
      provenanceQueue: Array<{ event: { kind: string; payload: Record<string, unknown> }; publishToChannel?: boolean }>;
      dispose(): void;
    };

    runner.queueMessageProvenance(
      {
        role: "assistant",
        content: [{ type: "text", text: "I could not finish this request." }],
        stopReason: "error",
        errorMessage: "provider stream failed",
        timestamp: 1,
      },
      "entry-error-visible"
    );

    expect(runner.provenanceQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            kind: "message.failed",
            payload: expect.objectContaining({
              reason: "provider stream failed",
              recoverable: true,
            }),
          }),
          publishToChannel: true,
        }),
      ])
    );

    runner.dispose();
  });

  it("raises permanent provenance failures instead of silently dropping events", async () => {
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

    await expect(runner.flushProvenance()).rejects.toMatchObject({
      code: "provenance",
      message: expect.stringContaining("Permanent provenance persistence failure"),
    });

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(3);
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      2,
      "appendTrajectoryBatch",
      expect.objectContaining({ events: [expect.objectContaining({ eventId: "valid" })] })
    );
    expect(appendTrajectoryBatch).toHaveBeenNthCalledWith(
      3,
      "appendTrajectoryBatch",
      expect.objectContaining({ events: [expect.objectContaining({ eventId: "invalid" })] })
    );
    expect(runner.provenanceQueue).toEqual([invalid]);
  });

  it("raises oversized provenance events that remain too large after blob spilling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      provenanceQueue: Array<Record<string, unknown>>;
      flushProvenance(): Promise<void>;
    };
    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 60000; i += 1) hugeMetadata[`k${i}`] = "v";
    const oversized = {
      eventId: "oversized",
      event: {
        kind: "invocation.completed",
        actor: { kind: "agent", id: "test", metadata: hugeMetadata },
        causality: { invocationId: "call_1" },
        payload: { protocol: "agentic.trajectory.v1", result: { content: "small output" } },
        createdAt: new Date(0).toISOString(),
      },
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.provenanceQueue = [oversized];

    try {
      await expect(runner.flushProvenance()).rejects.toMatchObject({
        code: "provenance",
        message: expect.stringContaining("Provenance event remains too large after blob spilling"),
      });

      expect(appendTrajectoryBatch).not.toHaveBeenCalled();
      expect(runner.provenanceQueue).toEqual([oversized]);
      expect(warn).not.toHaveBeenCalledWith(
        "[PiRunner] dropping permanent provenance event:",
        expect.anything()
      );
      expect(warn).not.toHaveBeenCalledWith(
        "[PiRunner] provenance flush failed:",
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("raises message-end provenance persistence failures after clearing active run state", async () => {
    const appendTrajectoryBatch = vi.fn(async () => {
      throw new Error(
        'DO RPC relay failed (500): {"error":"string or blob too big: SQLITE_TOOBIG"}'
      );
    });
    const options = createOptions();
    const runner = new PiRunner(options) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      session: {
        getLeafId(): Promise<string>;
        buildContext(): Promise<{ messages: unknown[] }>;
      };
      running: boolean;
      currentTurnId: string | null;
      activeAssistantMessage: { messageId: string; lastText: string; started: boolean } | null;
      awaitingProviderFirstEvent: boolean;
      activeRunSignal: AbortSignal | null;
      openInvocationIds: Set<string>;
      openToolInvocations: Map<string, unknown>;
      handleHarnessEvent(event: unknown): Promise<void>;
      getStateSnapshot(): Promise<{ isStreaming: boolean }>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.session = {
      getLeafId: vi.fn(async () => "entry-assistant"),
      buildContext: vi.fn(async () => ({ messages: [] })),
    };
    runner.running = true;
    runner.currentTurnId = "turn-open";
    runner.activeAssistantMessage = {
      messageId: "message-assistant",
      lastText: "partial",
      started: true,
    };
    runner.awaitingProviderFirstEvent = true;
    runner.activeRunSignal = new AbortController().signal;
    runner.openInvocationIds.add("call_1");
    runner.openToolInvocations.set("call_1", { toolName: "eval" });

    await expect(
      runner.handleHarnessEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: 0,
        },
      })
    ).rejects.toMatchObject({
      code: "provenance",
      message: expect.stringContaining("Provenance event is too large to store"),
    });

    expect((await runner.getStateSnapshot()).isStreaming).toBe(false);
    expect(runner.currentTurnId).toBe("turn-open");
    expect(runner.activeAssistantMessage).toBeNull();
    expect(runner.awaitingProviderFirstEvent).toBe(false);
    expect(runner.activeRunSignal).toBeNull();
    expect(runner.openInvocationIds.size).toBe(1);
    expect(runner.openToolInvocations.size).toBe(1);
    expect(options.uiCallbacks.setWorkingMessage).toHaveBeenCalledWith(undefined);
  });

  it("raises force-close persistence failures without dropping the open turn", async () => {
    const appendTrajectoryBatch = vi.fn(async () => {
      throw new Error("append failed");
    });
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      currentTurnId: string | null;
      running: boolean;
      activeAssistantMessage: { messageId: string; lastText: string; started: boolean } | null;
      forceCloseCurrentTurn(reason?: string, summary?: string): Promise<boolean>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.currentTurnId = "turn-open";
    runner.running = true;
    runner.activeAssistantMessage = {
      messageId: "message-assistant",
      lastText: "partial",
      started: true,
    };

    await expect(runner.forceCloseCurrentTurn("failed", "failed")).rejects.toThrow("append failed");

    expect(runner.currentTurnId).toBe("turn-open");
    expect(runner.running).toBe(false);
    expect(runner.activeAssistantMessage).toBeNull();
  });

  it("raises completed turn-close persistence failures without dropping the open turn", async () => {
    const appendTrajectoryBatch = vi.fn(async () => {
      throw new Error("turn close append failed");
    });
    const options = createOptions();
    const runner = new PiRunner(options) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      currentTurnId: string | null;
      running: boolean;
      awaitingProviderFirstEvent: boolean;
      activeRunSignal: AbortSignal | null;
      handleHarnessEvent(event: unknown): Promise<void>;
      getStateSnapshot(): Promise<{ isStreaming: boolean }>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.currentTurnId = "turn-open";
    runner.running = true;
    runner.awaitingProviderFirstEvent = true;
    runner.activeRunSignal = new AbortController().signal;

    await expect(runner.handleHarnessEvent({ type: "agent_end" })).rejects.toThrow(
      "turn close append failed"
    );

    expect((await runner.getStateSnapshot()).isStreaming).toBe(false);
    expect(runner.currentTurnId).toBe("turn-open");
    expect(runner.awaitingProviderFirstEvent).toBe(false);
    expect(runner.activeRunSignal).toBeNull();
    expect(options.uiCallbacks.setWorkingMessage).toHaveBeenCalledWith(undefined);
  });

  it("keeps an opened turn after public prompt fails while appending turn.closed", async () => {
    const appendTrajectoryBatch = vi.fn(
      async (
        _method: string,
        input: { events: Array<{ event: { kind: string; turnId?: string } }> }
      ) => {
        if (input.events.some((item) => item.event.kind === "turn.closed")) {
          throw new Error("turn close append failed");
        }
        return { events: [], published: [] };
      }
    );
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      currentTurnId: string | null;
    };
    await runner.init();
    internals.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    internals.gad = { call: appendTrajectoryBatch };

    await expect(runner.prompt({ content: "hello" }, { turnId: "turn-close-failed" })).rejects.toThrow(
      "turn close append failed"
    );

    expect(internals.currentTurnId).toBe("turn-close-failed");
    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "turn.opened",
              turnId: "turn-close-failed",
            }),
          }),
        ],
      })
    );
  });

  it("does not append a completed turn close while force close is in progress", async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const batches: Array<Array<{ event: { kind: string; turnId?: string; payload?: unknown } }>> = [];
    const appendTrajectoryBatch = vi.fn(async (_method: string, input: { events: Array<{ event: { kind: string; turnId?: string; payload?: unknown } }> }) => {
      batches.push(input.events);
      await appendGate;
      return { events: [], published: [] };
    });
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      currentTurnId: string | null;
      running: boolean;
      openInvocationIds: Set<string>;
      openToolInvocations: Map<string, unknown>;
      forceCloseCurrentTurn(reason?: string, summary?: string): Promise<boolean>;
      closeCurrentTurn(): Promise<void>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };
    runner.currentTurnId = "turn-open";
    runner.running = true;
    runner.openInvocationIds.add("call_1");
    runner.openToolInvocations.set("call_1", { toolName: "eval" });

    const forceClose = runner.forceCloseCurrentTurn(
      "user_interrupted",
      "Agent turn interrupted by user"
    );
    await runner.closeCurrentTurn();
    releaseAppend();
    await forceClose;

    const events = batches.flat().map((item) => item.event);
    expect(events.map((event) => event.kind)).toEqual([
      "invocation.abandoned",
      "turn.closed",
    ]);
    expect(events[0]).toMatchObject({ turnId: "turn-open" });
    expect(events[1]?.payload).toMatchObject({
      reason: "user_interrupted",
      summary: "Agent turn interrupted by user",
    });
  });

  it("spills oversized invocation results to blobstore before appending provenance", async () => {
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    const runner = new PiRunner(createOptions()) as unknown as {
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
    const largeText = "x".repeat(160 * 1024);

    await runner.appendTrajectoryEvents([
      {
        publishToChannel: true,
        event: {
          kind: "invocation.completed",
          actor: { kind: "agent", id: "test" },
          causality: { invocationId: "call_1" },
          payload: {
            protocol: "agentic.trajectory.v1",
            result: { toolCallId: "call_1", content: [{ type: "text", text: largeText }] },
            summary: "large result",
          },
          createdAt: new Date(0).toISOString(),
        },
      },
    ]);

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(1);
    const calls = appendTrajectoryBatch.mock.calls as unknown as Array<
      [string, { events: Array<{ event: { payload: { result?: unknown } } }> }]
    >;
    const input = calls[0]![1];
    const result = input.events[0]!.event.payload.result as Record<string, unknown>;
    expect(result).toMatchObject({
      protocol: "natstack.blob-ref.v1",
      encoding: "json",
      originalBytes: expect.any(Number),
    });
    expect(JSON.stringify(input)).not.toContain(largeText);
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
      "entry-result"
    );

    expect(runner.provenanceQueue).toMatchObject([
      {
        eventId: expect.stringMatching(/^entry-result:message:completed:[0-9a-f]{16}$/u),
        publishToChannel: false,
        event: {
          kind: "message.completed",
          causality: { messageId: "entry-result" },
          payload: { role: "tool", content: "done" },
        },
      },
      {
        eventId: expect.stringMatching(
          /^entry-result:invocation:call_1:terminal:[0-9a-f]{16}$/u
        ),
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

  it("uses the message leaf captured at harness emission time for message-end provenance", async () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      session: { getLeafId(): Promise<string> };
      provenanceQueue: Array<Record<string, unknown>>;
      handleMessageEnd(message: unknown, capturedMessageEntryId?: string): Promise<void>;
    };
    runner.session = {
      getLeafId: vi.fn(async () => {
        throw new Error("late leaf lookup should not run");
      }),
    };
    runner.provenanceQueue = [];

    await runner.handleMessageEnd(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "eval",
        content: [{ type: "text", text: "done" }],
      },
      "entry-at-emit"
    );

    expect(runner.provenanceQueue).toMatchObject([
      { eventId: expect.stringMatching(/^entry-at-emit:message:completed:[0-9a-f]{16}$/u) },
      {
        eventId: expect.stringMatching(
          /^entry-at-emit:invocation:call_1:terminal:[0-9a-f]{16}$/u
        ),
      },
    ]);
    expect(runner.session.getLeafId).not.toHaveBeenCalled();
  });

  it("content-addresses derived message provenance for repeated session entry ids", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];

    runner.queueMessageProvenance(
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      "entry-replayed"
    );
    runner.queueMessageProvenance(
      { role: "assistant", content: [{ type: "text", text: "second" }] },
      "entry-replayed"
    );

    const eventIds = runner.provenanceQueue.map((item) => item["eventId"]);
    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).toMatch(/^entry-replayed:message:completed:[0-9a-f]{16}$/u);
    expect(eventIds[1]).toMatch(/^entry-replayed:message:completed:[0-9a-f]{16}$/u);
    expect(eventIds[0]).not.toBe(eventIds[1]);
  });

  it("batches exact Pi session entries with semantic message provenance", async () => {
    const timestamp = new Date(0).toISOString();
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      entries: [
        {
          type: "message",
          id: "entry-tool",
          parentId: null,
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "eval",
            content: [{ type: "text", text: "done" }],
          },
        } as never,
      ],
    });
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      gad: { call: ReturnType<typeof vi.fn> };
      session: { getLeafId(): Promise<string> };
      storage: TrajectoryBackedSessionStorage;
      provenanceQueue: Array<Record<string, unknown>>;
      handleMessageEnd(message: unknown, capturedMessageEntryId?: string): Promise<void>;
    };
    const appendTrajectoryBatch = vi.fn(async () => undefined);
    runner.options.gad = { trajectoryId: "trajectory:test", branchId: "branch:test" };
    runner.gad = { call: appendTrajectoryBatch };
    runner.session = { getLeafId: vi.fn(async () => "entry-tool") };
    runner.storage = storage;
    runner.provenanceQueue = [];

    await runner.handleMessageEnd(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "eval",
        content: [{ type: "text", text: "done" }],
      },
      "entry-tool"
    );

    expect(appendTrajectoryBatch).toHaveBeenCalledTimes(1);
    expect(appendTrajectoryBatch).toHaveBeenCalledWith(
      "appendTrajectoryBatch",
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventId: "entry-tool:pi-session-entry",
            event: expect.objectContaining({
              kind: "system.event",
              payload: expect.objectContaining({
                kind: "message",
              }),
            }),
          }),
          expect.objectContaining({
            eventId: expect.stringMatching(/^entry-tool:message:completed:[0-9a-f]{16}$/u),
          }),
          expect.objectContaining({
            eventId: expect.stringMatching(
              /^entry-tool:invocation:call_1:terminal:[0-9a-f]{16}$/u
            ),
          }),
        ],
      })
    );
  });

  it("does not emit duplicate terminal provenance for already-terminal invocations", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      terminalInvocationIds: Set<string>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];
    runner.terminalInvocationIds.add("call_1");

    runner.queueMessageProvenance(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "eval",
        content: [{ type: "text", text: "done" }],
      },
      "entry-result"
    );

    expect(runner.provenanceQueue).toEqual([
      expect.objectContaining({
        eventId: expect.stringMatching(/^entry-result:message:completed:[0-9a-f]{16}$/u),
        event: expect.objectContaining({
          kind: "message.completed",
          payload: expect.objectContaining({ role: "tool" }),
        }),
      }),
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
      "entry-user"
    );

    expect(runner.provenanceQueue).toContainEqual(
      expect.objectContaining({
        publishToChannel: false,
        event: expect.objectContaining({
          kind: "message.completed",
          actor: { kind: "user", id: "user" },
          payload: expect.objectContaining({
            role: "user",
            content: "Read the onboarding docs",
          }),
        }),
      })
    );
  });

  it("publishes assistant thinking-only messages to the channel", () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    runner.provenanceQueue = [];

    runner.queueMessageProvenance(
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Checking repository state." }],
      },
      "entry-thinking"
    );

    expect(runner.provenanceQueue).toContainEqual(
      expect.objectContaining({
        publishToChannel: true,
        event: expect.objectContaining({
          kind: "message.completed",
          payload: expect.objectContaining({
            role: "assistant",
            content: "",
            blocks: [
              expect.objectContaining({
                type: "thinking",
                content: "Checking repository state.",
              }),
            ],
          }),
        }),
      })
    );
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
            function: { name: "eval", arguments: '{"code":"1 + 1"}' },
          },
        ],
      },
      "entry-assistant"
    );

    expect(runner.provenanceQueue).toContainEqual(
      expect.objectContaining({
        publishToChannel: false,
        event: expect.objectContaining({
          kind: "message.completed",
          payload: expect.objectContaining({
            role: "assistant",
            content: "",
          }),
        }),
      })
    );
    expect(
      runner.provenanceQueue.some((item) => JSON.stringify(item).includes("[tool call:"))
    ).toBe(false);
    expect(runner.provenanceQueue).toContainEqual(
      expect.objectContaining({
        eventId: expect.stringMatching(
          /^entry-assistant:invocation:call_2:started:[0-9a-f]{16}$/u
        ),
        event: expect.objectContaining({
          kind: "invocation.started",
          causality: expect.objectContaining({ invocationId: "call_2" }),
          payload: expect.objectContaining({
            name: "eval",
            request: { code: "1 + 1" },
          }),
        }),
      })
    );
  });

  it("exposes open invocation metadata and closes it when a tool result is recorded", () => {
    const runner = new PiRunner(createOptions());
    const internals = runner as unknown as {
      provenanceQueue: Array<Record<string, unknown>>;
      queueMessageProvenance(message: unknown, messageEntryId: string): void;
    };
    internals.provenanceQueue = [];

    internals.queueMessageProvenance(
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool_call",
            tool_call_id: "call_2",
            function: { name: "eval", arguments: '{"code":"1 + 1"}' },
          },
        ],
      },
      "entry-assistant"
    );

    expect(runner.isInvocationOpen("call_2")).toBe(true);
    expect(runner.getOpenInvocation("call_2")).toMatchObject({
      invocationId: "call_2",
      modelToolCallId: "call_2",
      name: "eval",
      messageId: "entry-assistant",
      blockIndex: 1,
    });

    internals.queueMessageProvenance(
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "eval",
        content: [{ type: "text", text: "2" }],
      },
      "entry-result"
    );

    expect(runner.isInvocationOpen("call_2")).toBe(false);
    expect(runner.getOpenInvocation("call_2")).toBeUndefined();
  });

  it("checks whether the current session leaf descends from an earlier entry", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();

    const parentLeaf = await runner.appendUserMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    } as any);
    const childLeaf = await runner.appendToolResult({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "eval",
      content: [{ type: "text", text: "done" }],
      timestamp: 2,
    } as any);

    expect(await runner.isLeafDescendantOf(parentLeaf)).toBe(true);
    expect(await runner.isLeafDescendantOf(childLeaf)).toBe(true);
    expect(await runner.isLeafDescendantOf("unrelated-entry")).toBe(false);
    expect(await runner.hasToolResult("call_1")).toBe(true);
    expect(await runner.hasToolResult("missing-call")).toBe(false);
    expect(await runner.isCurrentLeafToolResult("call_1")).toBe(true);

    runner.dispose();
  });

  it("only executes direct resume for tools that explicitly opt in and passes the abort signal", async () => {
    const signalSeen: AbortSignal[] = [];
    const runner = new PiRunner(
      createOptions({
        extraTools: [
          {
            name: "unsafe_tool",
            label: "unsafe_tool",
            description: "unsafe",
            parameters: { type: "object" } as never,
            execute: vi.fn(async () => ({
              content: [{ type: "text" as const, text: "should not run" }],
              details: undefined,
            })),
          },
          {
            name: "safe_tool",
            label: "safe_tool",
            description: "safe",
            parameters: { type: "object" } as never,
            natstackResume: { safeAcrossHibernation: true },
            execute: vi.fn(async (_toolCallId, _params, signal) => {
              signalSeen.push(signal!);
              return { content: [{ type: "text" as const, text: "ran" }], details: undefined };
            }),
          } as HibernationResumableTool & NonNullable<PiRunnerOptions["extraTools"]>[number],
        ],
      })
    );
    await runner.init();
    const controller = new AbortController();

    await expect(runner.executeToolDirect("unsafe_tool", "call-unsafe", {})).resolves.toMatchObject(
      {
        isError: true,
        details: { __natstack_resume_disabled: true },
      }
    );
    await expect(
      runner.executeToolDirect("safe_tool", "call-safe", {}, controller.signal)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "ran" }],
    });
    expect(signalSeen).toEqual([controller.signal]);

    runner.dispose();
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
        input: Record<string, unknown>
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
                details: expect.objectContaining({
                  protocol: "natstack.blob-ref.v1",
                  encoding: "json",
                  originalBytes: expect.any(Number),
                }),
              }),
            }),
          }),
        ],
      })
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
      })
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
        input: Record<string, unknown>
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
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
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
      })
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
      })
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
      })
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
      if (
        target === "do:workers/pubsub-channel:PubSubChannel:channel:test" &&
        method === "broadcastStoredEnvelopes"
      ) {
        return { broadcasted: 2 };
      }
      throw new Error(`unexpected rpc call ${target}.${method}`);
    });
    const runner = new PiRunner(
      createOptions({ rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"] })
    ) as unknown as {
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
    await flushMicrotasks();

    expect(rpcCall).toHaveBeenCalledWith(
      "do:workers/pubsub-channel:PubSubChannel:channel:test",
      "broadcastStoredEnvelopes",
      [["env-1", "env-2"]]
    );
  });

  it("does not block trajectory append completion on a stuck channel broadcast", async () => {
    const stuckBroadcast = deferred<unknown>();
    const appendTrajectoryBatch = vi.fn(async () => ({
      published: [{ channelId: "channel:test", envelopeId: "env-1" }],
    }));
    const rpcCall = vi.fn((target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return Promise.resolve({
          kind: "durable-object",
          targetId: "do:workers/pubsub-channel:PubSubChannel:channel:test",
        });
      }
      if (
        target === "do:workers/pubsub-channel:PubSubChannel:channel:test" &&
        method === "broadcastStoredEnvelopes"
      ) {
        return stuckBroadcast.promise;
      }
      return Promise.reject(new Error(`unexpected rpc call ${target}.${method}`));
    });
    const runner = new PiRunner(
      createOptions({ rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"] })
    ) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      appendTrajectoryEvents(items: Array<Record<string, unknown>>): Promise<void>;
      getDebugState(): Record<string, unknown>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };

    await expect(
      runner.appendTrajectoryEvents([
        {
          publishToChannel: true,
          event: {
            kind: "turn.opened",
            actor: { kind: "agent", id: "pi" },
            turnId: "turn-1",
            payload: { protocol: "agentic.trajectory.v1", summary: "Agent turn started" },
            createdAt: new Date(0).toISOString(),
          },
        },
      ])
    ).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(rpcCall).toHaveBeenCalledWith(
      "do:workers/pubsub-channel:PubSubChannel:channel:test",
      "broadcastStoredEnvelopes",
      [["env-1"]]
    );
    const debug = await runner.getDebugState();
    expect(debug["channelPublicationBroadcasts"]).toMatchObject({
      "channel:test": {
        pendingBatches: 1,
        activeEnvelopeIds: ["env-1"],
      },
    });

    stuckBroadcast.resolve({ broadcasted: 1 });
  });

  it("records channel publication broadcast failures in runner diagnostics", async () => {
    const appendTrajectoryBatch = vi
      .fn()
      .mockResolvedValueOnce({ published: [{ channelId: "channel:test", envelopeId: "env-1" }] });
    const rpcCall = vi.fn((target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return Promise.resolve({
          kind: "durable-object",
          targetId: "do:workers/pubsub-channel:PubSubChannel:channel:test",
        });
      }
      if (
        target === "do:workers/pubsub-channel:PubSubChannel:channel:test" &&
        method === "broadcastStoredEnvelopes"
      ) {
        return Promise.reject(new Error("broadcast failed"));
      }
      return Promise.reject(new Error(`unexpected rpc call ${target}.${method}`));
    });
    const runner = new PiRunner(
      createOptions({ rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"] })
    ) as unknown as {
      options: PiRunnerOptions;
      gad: { call: typeof appendTrajectoryBatch };
      appendTrajectoryEvents(items: Array<Record<string, unknown>>): Promise<void>;
      getDebugState(): Promise<Record<string, unknown>>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.gad = { call: appendTrajectoryBatch };

    await expect(
      runner.appendTrajectoryEvents([
        {
          publishToChannel: true,
          event: {
            kind: "turn.opened",
            actor: { kind: "agent", id: "pi" },
            turnId: "turn-1",
            payload: { protocol: "agentic.trajectory.v1", summary: "Agent turn started" },
            createdAt: new Date(0).toISOString(),
          },
        },
      ])
    ).resolves.toBeUndefined();
    await flushMicrotasks();

    const debug = await runner.getDebugState();
    expect(debug["channelPublicationBroadcasts"]).toMatchObject({
      "channel:test": {
        failureCount: 1,
        lastError: {
          envelopeIds: ["env-1"],
          message: "broadcast failed",
        },
      },
    });
    expect(debug["lastErrors"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "channel_publication.broadcast",
          message: "broadcast failed",
        }),
      ])
    );
  });

  it("serializes channel broadcasts after async scheduling", async () => {
    const firstBroadcast = deferred<unknown>();
    const appendTrajectoryBatch = vi
      .fn()
      .mockResolvedValueOnce({ published: [{ channelId: "channel:test", envelopeId: "env-1" }] })
      .mockResolvedValueOnce({ published: [{ channelId: "channel:test", envelopeId: "env-2" }] });
    const broadcastCalls: string[][] = [];
    const rpcCall = vi.fn((target: string, method: string, args: unknown[]) => {
      if (target === "main" && method === "workers.resolveService") {
        return Promise.resolve({
          kind: "durable-object",
          targetId: "do:workers/pubsub-channel:PubSubChannel:channel:test",
        });
      }
      if (
        target === "do:workers/pubsub-channel:PubSubChannel:channel:test" &&
        method === "broadcastStoredEnvelopes"
      ) {
        const envelopeIds = args[0] as string[];
        broadcastCalls.push(envelopeIds);
        return broadcastCalls.length === 1
          ? firstBroadcast.promise
          : Promise.resolve({ broadcasted: 1 });
      }
      return Promise.reject(new Error(`unexpected rpc call ${target}.${method}`));
    });
    const runner = new PiRunner(
      createOptions({ rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"] })
    ) as unknown as {
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
    const event = {
      kind: "message.completed",
      actor: { kind: "agent", id: "pi" },
      payload: { protocol: "agentic.trajectory.v1", role: "assistant", content: "hello" },
      createdAt: new Date(0).toISOString(),
    };

    await runner.appendTrajectoryEvents([{ publishToChannel: true, event }]);
    await flushMicrotasks();
    await runner.appendTrajectoryEvents([{ publishToChannel: true, event }]);
    await flushMicrotasks();

    expect(broadcastCalls).toEqual([["env-1"]]);
    firstBroadcast.resolve({ broadcasted: 1 });
    await flushMicrotasks();

    expect(broadcastCalls).toEqual([["env-1"], ["env-2"]]);
  });

  it("records compaction failures without failing the settled turn", async () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      harness: unknown;
      session: unknown;
      extensionRuntime: unknown;
      compactionTrigger: { shouldCompact(): boolean };
      maybeCompactWhenIdle(): Promise<void>;
      getDebugState(): Promise<Record<string, unknown>>;
    };
    runner.harness = {
      compact: vi.fn(async () => {
        throw new Error("compact failed");
      }),
      getModel: vi.fn(() => ({ contextWindow: 100000 })),
      getThinkingLevel: vi.fn(() => "medium"),
    };
    runner.session = {
      buildContext: vi.fn(async () => ({
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      })),
      getLeafId: vi.fn(async () => "leaf-1"),
      getEntries: vi.fn(async () => []),
    };
    runner.extensionRuntime = { getActiveTools: vi.fn(() => []) };
    runner.compactionTrigger = { shouldCompact: vi.fn(() => true) };

    await expect(runner.maybeCompactWhenIdle()).resolves.toBeUndefined();

    const debug = await runner.getDebugState();
    expect(debug["compaction"]).toMatchObject({
      attempts: 1,
      failures: 1,
      consecutiveFailures: 1,
      lastFailure: { message: "compact failed" },
    });
    expect(debug["lastErrors"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "compaction", message: "compact failed" }),
      ])
    );
  });

  it("does not abandon restored invocations that became terminal before repair", async () => {
    const runner = new PiRunner(createOptions()) as unknown as {
      options: PiRunnerOptions;
      restoredTrajectoryState: {
        invocations: Record<string, { invocationId: string; status: string; actor: { kind: "agent"; id: string } }>;
        turns: Record<string, never>;
      };
      terminalInvocationIds: Set<string>;
      appendTrajectoryEvents: ReturnType<typeof vi.fn>;
      repairDurableOpenState(): Promise<void>;
    };
    runner.options.gad = {
      trajectoryId: "trajectory:test",
      branchId: "branch:test",
      channelId: "channel:test",
    };
    runner.restoredTrajectoryState = {
      invocations: {
        "tool-1": {
          invocationId: "tool-1",
          status: "running",
          actor: { kind: "agent", id: "pi" },
        },
      },
      turns: {},
    };
    runner.terminalInvocationIds.add("tool-1");
    runner.appendTrajectoryEvents = vi.fn(async () => undefined);

    await runner.repairDurableOpenState();

    expect(runner.appendTrajectoryEvents).not.toHaveBeenCalled();
  });

  it("keeps a restored open turn alive while recovered tool results continue", async () => {
    const actor = { kind: "agent" as const, id: "agent-1" };
    const events = [
      {
        eventId: "turn-opened",
        trajectoryId: "trajectory:test",
        branchId: "branch:test",
        seq: 0,
        prevEventHash: "genesis",
        eventHash: "hash-turn",
        kind: "turn.opened",
        actor,
        turnId: "turn-open",
        payload: { protocol: "agentic.trajectory.v1", summary: "started" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
      {
        eventId: "invocation-started",
        trajectoryId: "trajectory:test",
        branchId: "branch:test",
        seq: 1,
        prevEventHash: "hash-turn",
        eventHash: "hash-invocation",
        kind: "invocation.started",
        actor,
        turnId: "turn-open",
        causality: { invocationId: "call_1" },
        payload: { protocol: "agentic.trajectory.v1", name: "eval", request: {} },
        createdAt: "2026-05-27T00:00:01.000Z",
      },
    ];
    const appended: unknown[] = [];
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[] = []) => {
      if (method === "workspace.getAgentsMd") return "workspace prompt";
      if (method === "workspace.listSkills") return [];
      if (method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
        };
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "listTrajectoryEvents") {
        return events;
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "appendTrajectoryBatch") {
        appended.push(...((args[0] as { events?: unknown[] }).events ?? []));
        return { events: [], published: [] };
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "query") {
        return { rows: [] };
      }
      throw new Error(`unexpected rpc call ${target}.${method}`);
    });
    const runner = new PiRunner(
      createOptions({
        rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"],
        repairDurableOpenStateOnInit: false,
        gad: {
          trajectoryId: "trajectory:test",
          branchId: "branch:test",
          channelId: "chat:test",
        },
      })
    );

    await runner.init();
    expect((await runner.getDebugState())["currentTurnId"]).toBe("turn-open");

    await (runner as unknown as { openCurrentTurn(): Promise<void> }).openCurrentTurn();
    expect(appended).toEqual([]);

    await runner.repairDurableOpenState({ closeOpenTurns: false });

    expect(appended.map((item) => (item as { event?: { kind?: string } }).event?.kind)).toEqual([
      "invocation.abandoned",
    ]);
    expect((await runner.getDebugState())["currentTurnId"]).toBe("turn-open");
    runner.dispose();
  });

  it("hydrates stored trajectory refs before restoring the Pi session branch", async () => {
    const blobs = new Map<string, string>();
    const putBlob = (value: unknown) => {
      const text = JSON.stringify(value);
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      blobs.set(digest, text);
      return {
        protocol: "natstack.blob-ref.v1" as const,
        digest,
        size: Buffer.byteLength(text, "utf8"),
        encoding: "json" as const,
        originalBytes: Buffer.byteLength(text, "utf8"),
      };
    };
    const actor = { kind: "agent" as const, id: "agent-1" };
    const entry = (id: string, parentId: string | null, role: "user" | "assistant") => ({
      kind: "pi.session_entry",
      entry: {
        type: "message",
        id,
        parentId,
        timestamp: `2026-05-27T00:00:0${parentId ? 1 : 0}.000Z`,
        message: { role, content: `${role} message`, timestamp: parentId ? 1 : 0 },
      },
    });
    const events = [
      {
        eventId: "user-entry:pi-session-entry",
        trajectoryId: "trajectory:test",
        branchId: "branch:test",
        seq: 0,
        prevEventHash: "genesis",
        eventHash: "hash-user",
        kind: "system.event",
        actor,
        payload: { protocol: "agentic.trajectory.v1", details: putBlob(entry("user-entry", null, "user")) },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
      {
        eventId: "assistant-entry:pi-session-entry",
        trajectoryId: "trajectory:test",
        branchId: "branch:test",
        seq: 1,
        prevEventHash: "hash-user",
        eventHash: "hash-assistant",
        kind: "system.event",
        actor,
        payload: {
          protocol: "agentic.trajectory.v1",
          details: putBlob(entry("assistant-entry", "user-entry", "assistant")),
        },
        createdAt: "2026-05-27T00:00:01.000Z",
      },
    ];
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[] = []) => {
      if (method === "workspace.getAgentsMd") return "workspace prompt";
      if (method === "workspace.listSkills") return [];
      if (method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
        };
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "listTrajectoryEvents") {
        return events;
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "appendTrajectoryBatch") {
        return { events: [], published: [] };
      }
      if (target === "do:workers/gad-store:GadWorkspaceDO:workspace-gad" && method === "query") {
        return { rows: [] };
      }
      if (method === "blobstore.getText") return blobs.get(String(args[0])) ?? null;
      throw new Error(`unexpected rpc call ${target}.${method}`);
    });
    const runner = new PiRunner(
      createOptions({
        rpc: { call: rpcCall } as unknown as PiRunnerOptions["rpc"],
        gad: {
          trajectoryId: "trajectory:test",
          branchId: "branch:test",
          channelId: "chat:test",
        },
      })
    );

    await runner.init();

    expect(await runner.isLeafDescendantOf("assistant-entry")).toBe(true);
    runner.dispose();
  });
});
