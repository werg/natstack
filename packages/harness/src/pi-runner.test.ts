/**
 * Tests for PiRunner — the in-process pi-agent-core wrapper.
 *
 * pi-agent-core's `Agent` and pi-ai's `getModel` are mocked so we can assert
 * on the assembly logic (resource loading, tool wrapping, event forwarding,
 * fork via state.messages assignment, dispose cleanup, getApiKey delegation) without
 * pulling in any provider transports or real LLM call paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

// Capture references so each test can poke them.
const agentInstances: any[] = [];
const subscribeCallbacks = new Map<any, (event: any) => void>();
const unsubscribeFns = new Map<any, ReturnType<typeof vi.fn>>();

vi.mock("@mariozechner/pi-agent-core", () => {
  class MockAgent {
    public state: any;
    public getApiKey: ((provider: string) => any) | undefined;
    public abort = vi.fn();
    public waitForIdle = vi.fn().mockResolvedValue(undefined);
    public prompt = vi.fn().mockResolvedValue(undefined);
    public steer = vi.fn();
    // Spies for the property setters: PiRunner assigns to state.tools / state.messages
    // (the real pi-agent-core 0.66+ AgentState exposes them as setter properties).
    public toolsSetSpy = vi.fn();
    public messagesSetSpy = vi.fn();

    constructor(opts: any) {
      const self = this;
      let _tools: any[] = opts?.initialState?.tools ?? [];
      let _messages: any[] = opts?.initialState?.messages ?? [];
      this.state = {
        systemPrompt: opts?.initialState?.systemPrompt ?? "",
        model: opts?.initialState?.model ?? null,
        thinkingLevel: opts?.initialState?.thinkingLevel ?? "medium",
        get tools() {
          return _tools;
        },
        set tools(t: any[]) {
          _tools = [...t];
          self.toolsSetSpy(t);
        },
        get messages() {
          return _messages;
        },
        set messages(m: any[]) {
          _messages = [...m];
          self.messagesSetSpy(m);
        },
        isStreaming: opts?.initialState?.isStreaming ?? false,
        streamingMessage:
          opts?.initialState?.streamingMessage ?? undefined,
        pendingToolCalls:
          opts?.initialState?.pendingToolCalls ?? new Set<string>(),
      };
      this.getApiKey = opts?.getApiKey;
      agentInstances.push(this);
    }

    subscribe(fn: (event: any, signal?: any) => void) {
      subscribeCallbacks.set(this, fn);
      const unsub = vi.fn();
      unsubscribeFns.set(this, unsub);
      return unsub;
    }
  }
  return { Agent: MockAgent };
});

vi.mock("@mariozechner/pi-ai", () => {
  return {
    getModel: vi.fn((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      modelId,
      api: "openai",
    })),
  };
});

// ── Imports under test (after mocks) ────────────────────────────────────────

import { PiRunner, type PiRunnerOptions } from "./pi-runner.js";
import type { RpcCaller } from "./resource-loader.js";
import type { RuntimeFs } from "./tools/runtime-fs.js";
import type { NatStackUIBridgeCallbacks } from "./natstack-extension-context.js";
import type { ChannelToolMethod } from "./extensions/channel-tools.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

function createMockRpc(
  overrides: Record<string, unknown> = {},
): RpcCaller & { call: ReturnType<typeof vi.fn> } {
  const responses: Record<string, unknown> = {
    "main:workspace.getAgentsMd": "BASE SYSTEM PROMPT",
    "main:workspace.listSkills": [],
    "main:auth.getProviderToken": "fake-token-abc",
    ...overrides,
  };
  const call = vi.fn(async (targetId: string, method: string) => {
    const key = `${targetId}:${method}`;
    if (key in responses) return responses[key];
    throw new Error(`Unexpected RPC call: ${key}`);
  });
  return { call: call as RpcCaller["call"] } as RpcCaller & {
    call: ReturnType<typeof vi.fn>;
  };
}

function createStubFs(): RuntimeFs {
  // Most fs methods are unused in these tests; we only need a structurally
  // valid object so file-tool factories don't blow up at construction time.
  const stub: any = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    mktemp: vi.fn().mockResolvedValue("/tmp/x"),
    readFile: vi.fn().mockResolvedValue("file contents"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: 10,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      mode: 0o644,
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
  return stub as RuntimeFs;
}

function createStubUiCallbacks(): NatStackUIBridgeCallbacks {
  return {
    showSelect: vi.fn().mockResolvedValue(undefined),
    showConfirm: vi.fn().mockResolvedValue(true),
    showInput: vi.fn().mockResolvedValue(undefined),
    showEditor: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setWorkingMessage: vi.fn(),
    requestProviderOAuth: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<PiRunnerOptions> = {},
): PiRunnerOptions {
  const roster: ChannelToolMethod[] = [];
  return {
    rpc: createMockRpc(),
    fs: createStubFs(),
    uiCallbacks: createStubUiCallbacks(),
    rosterCallback: () => roster,
    callMethodCallback: vi.fn().mockResolvedValue(undefined),
    askUserCallback: vi.fn().mockResolvedValue(""),
    model: "openai-codex:gpt-5",
    approvalLevel: 2, // full auto so wrapped tools never block in default tests
    ...overrides,
  };
}

beforeEach(() => {
  agentInstances.length = 0;
  subscribeCallbacks.clear();
  unsubscribeFns.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiRunner.init", () => {
  it("loads workspace resources via RPC and constructs the Agent", async () => {
    const options = createOptions();
    const rpcCallSpy = (options.rpc as any).call as ReturnType<typeof vi.fn>;
    const runner = new PiRunner(options);

    await runner.init();

    expect(rpcCallSpy).toHaveBeenCalledWith("main", "workspace.getAgentsMd");
    expect(rpcCallSpy).toHaveBeenCalledWith("main", "workspace.listSkills");
    expect(agentInstances).toHaveLength(1);

    const agent = agentInstances[0];
    expect(agent.state.systemPrompt).toContain("BASE SYSTEM PROMPT");
    expect(agent.state.model).toEqual(
      expect.objectContaining({ id: "openai-codex:gpt-5" }),
    );
    expect(agent.state.thinkingLevel).toBe("medium");
    // After session_start dispatch the active tool set should have been pushed
    // via the state.tools property setter.
    expect(agent.toolsSetSpy).toHaveBeenCalled();
  });

  it("respects an explicit thinkingLevel option", async () => {
    const options = createOptions({ thinkingLevel: "high" });
    const runner = new PiRunner(options);
    await runner.init();
    expect(agentInstances[0].state.thinkingLevel).toBe("high");
  });

  it("seeds initialMessages on warm restore", async () => {
    const initialMessages = [
      { role: "user", content: "hello", timestamp: 1 } as any,
    ];
    const runner = new PiRunner(createOptions({ initialMessages }));
    await runner.init();
    expect(agentInstances[0].state.messages).toEqual(initialMessages);
  });

  it("throws when the model string lacks a provider:model separator", async () => {
    const runner = new PiRunner(createOptions({ model: "no-colon" }));
    await expect(runner.init()).rejects.toThrow(/provider:model/);
  });

  it("getApiKey callback delegates to auth.getProviderToken", async () => {
    const options = createOptions();
    const rpcCallSpy = (options.rpc as any).call as ReturnType<typeof vi.fn>;
    const runner = new PiRunner(options);
    await runner.init();

    const agent = agentInstances[0];
    const token = await agent.getApiKey("openai");
    expect(token).toBe("fake-token-abc");
    expect(rpcCallSpy).toHaveBeenCalledWith(
      "main",
      "auth.getProviderToken",
      "openai",
    );
  });

  it("OAuth fallback: shows the Connect card and throws (non-blocking) when not logged in", async () => {
    const ui = createStubUiCallbacks();

    const rpcResponses: Record<string, unknown> = {
      "main:workspace.getAgentsMd": "BASE PROMPT",
      "main:workspace.listSkills": [],
    };
    const call = vi.fn(
      async (targetId: string, method: string, ..._args: unknown[]) => {
        const key = `${targetId}:${method}`;
        if (key === "main:auth.getProviderToken") {
          throw new Error("Not logged in to openai-codex. Use the settings panel to connect.");
        }
        if (key in rpcResponses) return rpcResponses[key];
        throw new Error(`Unexpected RPC call: ${key}`);
      },
    );
    const rpc = { call: call as never } as PiRunnerOptions["rpc"];

    const runner = new PiRunner(
      createOptions({ rpc, uiCallbacks: ui, model: "openai-codex:gpt-5.4" }),
    );
    await runner.init();

    const agent = agentInstances[0];
    // getApiKey should throw (non-blocking) instead of waiting.
    await expect(agent.getApiKey("openai-codex")).rejects.toThrow(/Sign in required/);

    // The OAuth card was pushed before the throw.
    expect(ui.requestProviderOAuth).toHaveBeenCalledWith(
      "openai-codex",
      "ChatGPT",
    );
    // waitForProvider should NOT have been called (non-blocking).
    expect(call).not.toHaveBeenCalledWith(
      "main",
      "auth.waitForProvider",
      expect.anything(),
    );
  });

  it("OAuth fallback: rethrows non-auth errors without showing the card", async () => {
    const ui = createStubUiCallbacks();
    const call = vi.fn(async (_t: string, method: string) => {
      if (method === "workspace.getAgentsMd") return "P";
      if (method === "workspace.listSkills") return [];
      if (method === "auth.getProviderToken") {
        throw new Error("Network error");
      }
      throw new Error(`Unexpected: ${method}`);
    });
    const rpc = { call: call as never } as PiRunnerOptions["rpc"];

    const runner = new PiRunner(
      createOptions({ rpc, uiCallbacks: ui, model: "openai-codex:gpt-5.4" }),
    );
    await runner.init();

    const agent = agentInstances[0];
    await expect(agent.getApiKey("openai-codex")).rejects.toThrow(/Network error/);
    // Should NOT have shown the card or called waitForProvider.
    expect(ui.requestProviderOAuth).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalledWith(
      "main",
      "auth.waitForProvider",
      expect.anything(),
    );
  });
});

describe("PiRunner approval-gate tool wrapping", () => {
  it("blocks the wrapped tool's execute when the gate denies", async () => {
    const ui = createStubUiCallbacks();
    // approvalLevel 0 = ask all; deny via showConfirm.
    (ui.showConfirm as any).mockResolvedValue(false);
    const runner = new PiRunner(
      createOptions({ uiCallbacks: ui, approvalLevel: 0 }),
    );
    await runner.init();

    const agent = agentInstances[0];
    // The agent's current tool set is what we set after init.
    const tools: any[] = agent.state.tools;
    const writeTool = tools.find((t) => t.name === "write");
    expect(writeTool).toBeDefined();

    // Calling the wrapped execute() should throw because the gate denied.
    await expect(
      writeTool.execute("call-1", { path: "/x", content: "y" }, undefined),
    ).rejects.toThrow(/denied/i);
  });

  it("passes through to the underlying tool when the gate allows", async () => {
    // ls calls fs.stat which must report isDirectory() === true.
    const fs = createStubFs() as any;
    fs.stat = vi.fn().mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      size: 0,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      mode: 0o755,
    });
    fs.readdir = vi.fn().mockResolvedValue([]);

    const runner = new PiRunner(createOptions({ fs, approvalLevel: 2 }));
    await runner.init();

    const tools: any[] = agentInstances[0].state.tools;
    const lsTool = tools.find((t) => t.name === "ls");
    expect(lsTool).toBeDefined();

    // ls calls fs.readdir / stat under the hood. We only need it not to
    // throw from the approval-gate path.
    await expect(
      lsTool.execute("call-1", { path: "." }, undefined),
    ).resolves.toBeDefined();
  });
});

describe("PiRunner event forwarding", () => {
  it("forwards Agent events to subscribers", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();

    const events: any[] = [];
    runner.subscribe((e) => events.push(e));

    const agentCallback = subscribeCallbacks.get(agentInstances[0])!;
    expect(agentCallback).toBeDefined();
    agentCallback({ type: "agent_start" });
    agentCallback({
      type: "message_end",
      message: { role: "user", content: "hi", timestamp: 1 },
    });

    // Wait one microtask so handleAgentEvent's async paths flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(events.map((e) => e.type)).toEqual(["agent_start", "message_end"]);
  });

  it("calls onPersist on message_end and agent_end", async () => {
    const onPersist = vi.fn();
    const runner = new PiRunner(createOptions({ onPersist }));
    await runner.init();

    const agent = agentInstances[0];
    agent.state.messages = [
      { role: "user", content: "hi", timestamp: 1 } as any,
    ];

    const cb = subscribeCallbacks.get(agent)!;
    cb({
      type: "message_end",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    await Promise.resolve();
    cb({ type: "agent_end", messages: agent.state.messages });
    await Promise.resolve();

    expect(onPersist).toHaveBeenCalledTimes(2);
    expect(onPersist).toHaveBeenLastCalledWith(agent.state.messages);
  });

  it("refreshes active tools on turn_start", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const agent = agentInstances[0];
    agent.toolsSetSpy.mockClear();

    const cb = subscribeCallbacks.get(agent)!;
    await cb({ type: "turn_start" });

    expect(agent.toolsSetSpy).toHaveBeenCalled();
  });
});

describe("PiRunner.runTurn", () => {
  it("passes a plain string when there are no images", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    await runner.runTurn("hello world");
    expect(agentInstances[0].prompt).toHaveBeenCalledWith("hello world");
  });

  it("builds a multi-content user message when images are present", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const images = [
      { type: "image" as const, mimeType: "image/png", data: "base64data" },
    ];
    await runner.runTurn("look at this", images);

    expect(agentInstances[0].prompt).toHaveBeenCalledTimes(1);
    const arg = agentInstances[0].prompt.mock.calls[0][0];
    expect(arg.role).toBe("user");
    expect(Array.isArray(arg.content)).toBe(true);
    expect(arg.content[0]).toEqual({ type: "text", text: "look at this" });
    expect(arg.content[1]).toEqual(images[0]);
  });
});

describe("PiRunner.steer", () => {
  it("wraps content + images into an AgentMessage", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const images = [
      { type: "image" as const, mimeType: "image/jpeg", data: "abc" },
    ];
    await runner.steer("update", images);
    const arg = agentInstances[0].steer.mock.calls[0][0];
    expect(arg.role).toBe("user");
    expect(Array.isArray(arg.content)).toBe(true);
  });

  it("uses string content when there are no images", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    await runner.steer("just words");
    const arg = agentInstances[0].steer.mock.calls[0][0];
    expect(arg.content).toBe("just words");
  });
});

describe("PiRunner.forkAtMessage", () => {
  it("truncates the message array via state.messages assignment", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const agent = agentInstances[0];
    agent.state.messages = [
      { role: "user", content: "a", timestamp: 1 } as any,
      { role: "assistant", content: "b", timestamp: 2 } as any,
      { role: "user", content: "c", timestamp: 3 } as any,
    ];
    // Clear the spy so we only count the assignment forkAtMessage performs.
    agent.messagesSetSpy.mockClear();

    const result = await runner.forkAtMessage(2);
    expect(result).toHaveLength(2);
    expect(agent.messagesSetSpy).toHaveBeenCalledTimes(1);
    const replacedWith = agent.messagesSetSpy.mock.calls[0][0];
    expect(replacedWith).toHaveLength(2);
    expect(agent.state.messages).toHaveLength(2);
  });
});

describe("PiRunner.interrupt", () => {
  it("aborts the agent and waits for idle", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    await runner.interrupt();
    expect(agentInstances[0].abort).toHaveBeenCalled();
    expect(agentInstances[0].waitForIdle).toHaveBeenCalled();
  });
});

describe("PiRunner.dispose", () => {
  it("aborts the agent, calls the subscribe unsub, and clears listeners", async () => {
    const runner = new PiRunner(createOptions());
    await runner.init();
    const agent = agentInstances[0];
    const unsub = unsubscribeFns.get(agent)!;

    const listener = vi.fn();
    runner.subscribe(listener);

    runner.dispose();

    expect(agent.abort).toHaveBeenCalled();
    expect(unsub).toHaveBeenCalled();

    // After dispose, getStateSnapshot returns the empty fallback (no agent).
    const snapshot = runner.getStateSnapshot();
    expect(snapshot).toEqual({ messages: [], isStreaming: false });
  });
});

describe("PiRunner.setApprovalLevel", () => {
  it("updates the level so the closure-bound gate sees the new value", async () => {
    const ui = createStubUiCallbacks();
    (ui.showConfirm as any).mockResolvedValue(false);
    const runner = new PiRunner(
      createOptions({ uiCallbacks: ui, approvalLevel: 2 }),
    );
    await runner.init();

    // At level 2 the wrapped tool runs unconditionally.
    const tools: any[] = agentInstances[0].state.tools;
    const writeTool = tools.find((t) => t.name === "write");

    runner.setApprovalLevel(0);
    expect(runner.approvalLevel).toBe(0);

    await expect(
      writeTool.execute("call-1", { path: "/x", content: "y" }, undefined),
    ).rejects.toThrow();
  });
});
